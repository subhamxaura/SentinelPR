import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "@/lib/env";
import {
  createInstallationState,
  verifyInstallationState,
  consumeInstallationNonce,
  verifyNonceMatches,
} from "./installation-state";

describe("GitHub Installation State Security", () => {
  it("generates a signed state and successfully verifies it for matching org and user", () => {
    const { state, nonce } = createInstallationState({
      organizationId: "org-123",
      userId: "user-456",
    });

    expect(state).toBeTruthy();
    expect(nonce).toHaveLength(48);

    const verified = verifyInstallationState(state, {
      organizationId: "org-123",
      userId: "user-456",
    });

    expect(verified).not.toBeNull();
    expect(verified?.organizationId).toBe("org-123");
    expect(verified?.userId).toBe("user-456");
    expect(verified?.nonce).toBe(nonce);
  });

  it("rejects tampered state payload or signature", () => {
    const { state } = createInstallationState({
      organizationId: "org-123",
      userId: "user-456",
    });

    const [body, sig] = state.split(".");
    // Tamper with payload
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        nonce: "attacker-nonce",
        organizationId: "org-attacker",
        userId: "user-attacker",
        action: "install",
        exp: Date.now() + 60000,
      }),
    ).toString("base64url");
    const tamperedState = `${tamperedPayload}.${sig}`;

    expect(verifyInstallationState(tamperedState)).toBeNull();

    // Tamper with signature
    const badSigState = `${body}.invalidsignature1234567890`;
    expect(verifyInstallationState(badSigState)).toBeNull();
  });

  it("rejects expired state", () => {
    const { state } = createInstallationState({
      organizationId: "org-123",
      userId: "user-456",
      ttlSec: -10, // expired 10 seconds ago
    });

    expect(verifyInstallationState(state)).toBeNull();
  });

  it("rejects state with cross-tenant organization mismatch", () => {
    const { state } = createInstallationState({
      organizationId: "org-tenant-a",
      userId: "user-admin",
    });

    // Tenant B attempts to verify or use Tenant A's state
    const result = verifyInstallationState(state, {
      organizationId: "org-tenant-b",
    });

    expect(result).toBeNull();
  });

  it("rejects state with user mismatch", () => {
    const { state } = createInstallationState({
      organizationId: "org-123",
      userId: "user-admin",
    });

    const result = verifyInstallationState(state, {
      organizationId: "org-123",
      userId: "user-different",
    });

    expect(result).toBeNull();
  });

  it("enforces single-use nonce to prevent replay attacks", async () => {
    const nonce = `test-nonce-${Date.now()}-${Math.random()}`;
    const orgId = "org-replay-test";

    // First use must succeed
    const firstUse = await consumeInstallationNonce(nonce, orgId, "actor-1");
    expect(firstUse).toBe(true);

    // Second use with the same nonce must be rejected (replay attack)
    const secondUse = await consumeInstallationNonce(nonce, orgId, "actor-2");
    expect(secondUse).toBe(false);
  });

  it("correctly checks constant-time nonce equality", () => {
    const nonce = "a1b2c3d4e5f6";
    expect(verifyNonceMatches(nonce, "a1b2c3d4e5f6")).toBe(true);
    expect(verifyNonceMatches(nonce, "wrong-nonce")).toBe(false);
    expect(verifyNonceMatches(nonce, null)).toBe(false);
    expect(verifyNonceMatches(nonce, undefined)).toBe(false);
    expect(verifyNonceMatches("", nonce)).toBe(false);
  });

  describe("Installation Secret Configuration", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("fails closed in production when installation secret and auth state secret are missing", () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("GITHUB_INSTALLATION_SECRET", "");
      vi.stubEnv("GITHUB_APP_SETUP_SECRET", "");
      vi.stubEnv("AUTH_STATE_SECRET", "");
      vi.stubEnv("AUTH_SECRET", "");
      expect(() => env.github.installationSecret).toThrow(/GITHUB_INSTALLATION_SECRET or AUTH_STATE_SECRET/);
    });

    it("accepts GITHUB_APP_SETUP_SECRET alias when GITHUB_INSTALLATION_SECRET is missing", () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("GITHUB_INSTALLATION_SECRET", "");
      vi.stubEnv("GITHUB_APP_SETUP_SECRET", "custom-setup-secret");
      expect(env.github.installationSecret).toBe("custom-setup-secret");
    });
  });
});
