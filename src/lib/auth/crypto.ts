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
  return Buffer.from(env.auth.stateSecret ?? `state-fallback:${env.databaseUrl || "none"}`, "utf8");
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

/** Only same-origin relative paths survive into post-sign-in redirects. */
export function sanitizeRedirect(value: string | null | undefined): string {
  if (!value) return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}
