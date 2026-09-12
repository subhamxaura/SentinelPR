import { lookup } from "node:dns/promises";
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
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fe80")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
  if (lower.startsWith("::ffff:")) {
    const v4 = lower.slice(7);
    return isPrivateIPv4(v4);
  }
  return false;
}

function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
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

  if (env.allowPrivateTargets) return { url };

  if (isLocalHostname(url.hostname)) {
    throw err.config(
      `Target "${url.hostname}" resolves to a local address. Private targets are blocked; set SENTINEL_ALLOW_PRIVATE_TARGETS=1 for local development.`,
      "PRIVATE_TARGET_BLOCKED",
    );
  }

  let addresses;
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw err.config(`Target host "${url.hostname}" does not resolve`, "INVALID_TARGET_URL");
  }
  for (const addr of addresses) {
    if (addr.family === 4 ? isPrivateIPv4(addr.address) : isPrivateIPv6(addr.address)) {
      throw err.config(
        `Target "${url.hostname}" resolves to a private address (${addr.address}). Private targets are blocked.`,
        "PRIVATE_TARGET_BLOCKED",
      );
    }
  }
  return { url };
}
