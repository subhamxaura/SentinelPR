import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { env } from "@/lib/env";
import { err } from "@/lib/errors";

/**
 * SSRF guard for user-supplied targets (synthetic monitors, visual suites).
 *
 * Workers fetch URLs configured by dashboard users; without a guard that is a
 * trivial internal-network probe. Rules:
 *  - http/https only
 *  - reject localhost-style hostnames and link-local/metadata IPs outright
 *  - resolve DNS and reject any private/reserved address
 *  - SENTINEL_ALLOW_PRIVATE_TARGETS=1 relaxes this for local dev only
 *
 * Known limitation (documented in docs/security-model.md): classic DNS
 * rebinding TOCTOU remains possible without a pinned-connection HTTP client.
 */

const PRIVATE_V4 = [
  { net: "0.0.0.0", bits: 8 },
  { net: "10.0.0.0", bits: 8 },
  { net: "100.64.0.0", bits: 10 }, // CGNAT
  { net: "127.0.0.0", bits: 8 },
  { net: "169.254.0.0", bits: 16 }, // link-local incl. cloud metadata
  { net: "172.16.0.0", bits: 12 },
  { net: "192.0.0.0", bits: 24 },
  { net: "192.168.0.0", bits: 16 },
  { net: "198.18.0.0", bits: 15 }, // benchmark range
  { net: "224.0.0.0", bits: 4 }, // multicast
  { net: "240.0.0.0", bits: 4 }, // reserved
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function ipv4FromInt(n: number): string {
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

function parseIPv6(ip: string): number[] | null {
  let value = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const zone = value.indexOf("%");
  if (zone !== -1) value = value.slice(0, zone);
  if (!value.includes(":")) return null;

  const halves = value.split("::");
  if (halves.length > 2) return null;

  const parsePart = (part: string): string[] | null => {
    if (!part) return [];
    const groups = part.split(":");
    const last = groups[groups.length - 1];
    if (last.includes(".")) {
      const v4 = ipv4ToInt(last);
      if (v4 === null) return null;
      groups.splice(groups.length - 1, 1, (v4 >>> 16).toString(16), (v4 & 0xffff).toString(16));
    }
    return groups;
  };

  const head = parsePart(halves[0]);
  if (!head) return null;
  const tail = halves.length === 2 ? parsePart(halves[1]) : [];
  if (!tail) return null;

  let groups: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  }

  if (groups.length !== 8) return null;
  const parsed = groups.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : Number.NaN));
  return parsed.some(Number.isNaN) ? null : parsed;
}

export function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  return PRIVATE_V4.some(({ net, bits }) => {
    const base = ipv4ToInt(net);
    if (base === null) return false;
    const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
    return (n & mask) === (base & mask);
  });
}

export function isPrivateIPv6(ip: string): boolean {
  const groups = parseIPv6(ip);
  if (!groups) return false;

  if (groups.every((group) => group === 0)) return true;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // unique local
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // link-local
  if ((groups[0] & 0xffc0) === 0xfec0) return true; // deprecated site-local
  if ((groups[0] & 0xff00) === 0xff00) return true; // multicast
  if (groups[0] === 0x2002) {
    return isPrivateIPv4(ipv4FromInt((groups[1] << 16) | groups[2])); // 6to4
  }
  if (groups[0] === 0x2001 && groups[1] === 0x0000) return true; // Teredo
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups[2] === 1) return true; // local-use NAT64
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) {
    return isPrivateIPv4(ipv4FromInt((groups[6] << 16) | groups[7])); // NAT64
  }
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return isPrivateIPv4(ipv4FromInt((groups[6] << 16) | groups[7]));
  }
  if (groups.slice(0, 6).every((group) => group === 0)) {
    return isPrivateIPv4(ipv4FromInt((groups[6] << 16) | groups[7]));
  }
  return false;
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isLocalHostname(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  return (
    h === "localhost" ||
    h === "host.docker.internal" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h === "metadata.google.internal"
  );
}

export interface UrlGuardResult {
  url: URL;
}

function parseUrl(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw err.config(`Invalid URL: ${raw}`, "INVALID_TARGET_URL");
  }
}

/** Validate a user-supplied target URL before any fetch or browser navigation. */
export async function validatePublicUrl(rawUrl: string | URL): Promise<UrlGuardResult> {
  const url = rawUrl instanceof URL ? rawUrl : parseUrl(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw err.config(`Only http/https targets are allowed (got ${url.protocol})`, "INVALID_TARGET_URL");
  }
  if (url.username || url.password) {
    throw err.config("Credentials in target URLs are not allowed; use headers instead.", "INVALID_TARGET_URL");
  }

  if (env.allowPrivateTargets) return { url };

  const hostname = normalizeHostname(url.hostname);
  if (isLocalHostname(hostname)) {
    throw err.config(
      `Target "${hostname}" resolves to a local address. Private targets are blocked; set SENTINEL_ALLOW_PRIVATE_TARGETS=1 for local development.`,
      "PRIVATE_TARGET_BLOCKED",
    );
  }

  let addresses: Array<{ address: string; family: number }>;
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw err.config(`Target host "${hostname}" does not resolve`, "INVALID_TARGET_URL");
    }
  }
  for (const addr of addresses) {
    if (addr.family === 4 ? isPrivateIPv4(addr.address) : isPrivateIPv6(addr.address)) {
      throw err.config(
        `Target "${hostname}" resolves to a private address (${addr.address}). Private targets are blocked.`,
        "PRIVATE_TARGET_BLOCKED",
      );
    }
  }
  return { url };
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const CROSS_ORIGIN_HEADERS = ["authorization", "cookie", "proxy-authorization", "host", "referer"];
const BODY_HEADERS = ["content-length", "content-type", "content-encoding", "content-language", "content-location"];

function stripHeaders(headers: HeadersInit | undefined, names: string[]): HeadersInit | undefined {
  if (!headers) return headers;
  const next = new Headers(headers);
  for (const name of names) next.delete(name);
  return next;
}

/** Fetch a user-supplied URL while validating every redirect target. */
export async function safeFetch(rawUrl: string | URL, init: RequestInit = {}): Promise<Response> {
  let current = rawUrl instanceof URL ? rawUrl : parseUrl(rawUrl);
  let requestInit = init;

  for (let redirects = 0; ; redirects++) {
    const { url } = await validatePublicUrl(current);
    const response = await fetch(url, { ...requestInit, redirect: "manual" });
    if (!REDIRECT_STATUS.has(response.status)) return response;

    const location = response.headers.get("location");
    if (!location) return response;
    if (redirects >= MAX_REDIRECTS) {
      await response.body?.cancel().catch(() => undefined);
      throw err.config(`Target exceeded ${MAX_REDIRECTS} redirects`, "TOO_MANY_REDIRECTS");
    }

    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      await response.body?.cancel().catch(() => undefined);
      throw err.config("Target returned an invalid redirect URL", "INVALID_TARGET_URL");
    }

    const method = (requestInit.method ?? "GET").toUpperCase();
    const switchToGet =
      (response.status === 303 && method !== "GET" && method !== "HEAD") ||
      ((response.status === 301 || response.status === 302) && method === "POST");
    if (next.origin !== url.origin || switchToGet) {
      let headers = requestInit.headers;
      if (next.origin !== url.origin) headers = stripHeaders(headers, CROSS_ORIGIN_HEADERS);
      if (switchToGet) headers = stripHeaders(headers, BODY_HEADERS);
      if (headers !== requestInit.headers) requestInit = { ...requestInit, headers };
    }
    if (switchToGet) requestInit = { ...requestInit, method: "GET", body: undefined };

    current = next;
    await response.body?.cancel().catch(() => undefined);
  }
}
