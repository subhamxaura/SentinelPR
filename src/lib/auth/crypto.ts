/**
 * Pure session/OAuth-state crypto primitives.
 *
 * The browser receives only opaque random tokens; the database stores only
 * their SHA-256 digests. OAuth state is HMAC-signed and expires, mirroring
 * the signed artifact token scheme in lib/env.ts.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** 32 bytes of CSPRNG, URL-safe — the only secret the browser ever holds. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sessionTokenHash(token: string): string {
  return sha256Hex(token);
}

interface StatePayload {
  nonce: string;
  redirectTo: string;
  exp: number;
}

function stateSecret(): Buffer {
  const configured = env.auth.stateSecret;
  if (configured) return Buffer.from(configured, "utf8");
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_STATE_SECRET is required in production.");
  }
  return Buffer.from("sentinelpr-local-oauth-state", "utf8");
}

/** HMAC-signed, expiring OAuth state. Ties the callback to a browser-initiated flow (CSRF defense). */
export function createSignedState(redirectTo: string): { state: string; nonce: string } {
  const nonce = randomBytes(16).toString("hex");
  const payload: StatePayload = {
    nonce,
    redirectTo: sanitizeRedirect(redirectTo),
    exp: Date.now() + 10 * 60 * 1000,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", stateSecret()).update(body).digest("base64url");
  return { state: `${body}.${sig}`, nonce };
}

export function verifySignedState(state: string): { nonce: string; redirectTo: string } | null {
  const [body, sig] = state.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", stateSecret()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StatePayload;
    if (!payload.exp || Date.now() > payload.exp) return null;
    if (!payload.nonce) return null;
    return { nonce: payload.nonce, redirectTo: sanitizeRedirect(payload.redirectTo) };
  } catch {
    return null;
  }
}

export function stateNonceMatches(expected: string, received: string | null | undefined): boolean {
  if (!expected || !received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

const DUMMY_BASE = "https://sentinel.local";

/** Only same-origin relative paths survive into post-sign-in redirects. */
export function sanitizeRedirect(value: string | null | undefined): string {
  if (!value || typeof value !== "string") return "/";

  // Reject ASCII control characters (0x00 - 0x1F, 0x7F)
  if (/[\u0000-\u001f\u007f]/.test(value)) return "/";

  // Reject literal backslashes anywhere in the URL string
  if (value.includes("\\")) return "/";

  // Must begin with a single "/" and never protocol-relative "//"
  if (!value.startsWith("/") || value.startsWith("//")) return "/";

  // Fail fast on malformed percent encodings
  try {
    decodeURI(value);
  } catch {
    return "/";
  }

  // Canonical URL parse against fixed dummy origin
  let parsed: URL;
  try {
    parsed = new URL(value, DUMMY_BASE);
  } catch {
    return "/";
  }

  if (parsed.origin !== DUMMY_BASE) return "/";
  if (parsed.protocol !== "https:") return "/";
  if (!parsed.pathname.startsWith("/") || parsed.pathname.startsWith("//")) return "/";

  // Inspect path component specifically (before "?" or "#")
  const pathPart = value.split(/[?#]/)[0];
  let decodedPath = pathPart;
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(decodedPath);
      if (next === decodedPath) break;
      decodedPath = next;
    } catch {
      return "/";
    }
  }

  // Reject if decoded path contains control chars, backslashes, or starts with // or /\
  if (/[\u0000-\u001f\u007f]/.test(decodedPath)) return "/";
  if (
    decodedPath.startsWith("//") ||
    decodedPath.startsWith("/\\") ||
    decodedPath.includes("\\") ||
    /%5c/i.test(pathPart) ||
    /%2f/i.test(pathPart)
  ) {
    return "/";
  }

  return value;
}
