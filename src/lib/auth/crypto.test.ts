import { describe, expect, it } from "vitest";
import { createSignedState, sanitizeRedirect, sessionTokenHash, verifySignedState } from "./crypto";

describe("sanitizeRedirect", () => {
  it("allows same-origin relative paths", () => {
    expect(sanitizeRedirect("/pull-requests/abc")).toBe("/pull-requests/abc");
    expect(sanitizeRedirect("/")).toBe("/");
  });

  it("rejects protocol-relative and absolute URLs (open-redirect defense)", () => {
    expect(sanitizeRedirect("//evil.example")).toBe("/");
    expect(sanitizeRedirect("https://evil.example")).toBe("/");
    expect(sanitizeRedirect("http://evil.example/callback")).toBe("/");
  });

  it("falls back to / for empty values", () => {
    expect(sanitizeRedirect(null)).toBe("/");
    expect(sanitizeRedirect(undefined)).toBe("/");
    expect(sanitizeRedirect("")).toBe("/");
  });
});

describe("session token hashing", () => {
  it("produces stable sha-256 digests", () => {
    expect(sessionTokenHash("token-a")).toBe(sessionTokenHash("token-a"));
    expect(sessionTokenHash("token-a")).not.toBe(sessionTokenHash("token-b"));
  });

  it("never stores the raw token", () => {
    const hash = sessionTokenHash("super-secret-cookie-value");
    expect(hash).not.toContain("super-secret");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("signed OAuth state", () => {
  it("round-trips nonce and sanitized redirect", () => {
    const { state, nonce } = createSignedState("/visual");
    const verified = verifySignedState(state);
    expect(verified).not.toBeNull();
    expect(verified?.nonce).toBe(nonce);
    expect(verified?.redirectTo).toBe("/visual");
  });

  it("rejects tampered signatures", () => {
    const { state } = createSignedState("/");
    const [body] = state.split(".");
    expect(verifySignedState(`${body}.bogussignature`)).toBeNull();
    expect(verifySignedState(`${body}tampered.${"bogus"}`)).toBeNull();
  });

  it("rejects malformed state values", () => {
    expect(verifySignedState("")).toBeNull();
    expect(verifySignedState("no-signature")).toBeNull();
    expect(verifySignedState("a.b.c")).toBeNull();
  });
});
