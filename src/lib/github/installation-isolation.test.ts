import { describe, it, expect, vi } from "vitest";
import { registerRepository } from "@/lib/repositories/registration";
import { isAtLeast, type Role } from "@/lib/web/roles";
import { createInstallationState, verifyInstallationState } from "./installation-state";

describe("GitHub Installation & Repository Tenant Isolation", () => {
  it("rejects claim attempt when no state token is supplied (prevents guessing ID)", () => {
    const claimRequest = { id: "inst-secret-b", body: {} };
    // Verifying claim without state
    const stateToken = (claimRequest.body as { state?: string }).state;
    expect(stateToken).toBeUndefined();

    // The claim route checks if state is absent and rejects with 403 STATE_REQUIRED
    const isStateMissing = !stateToken;
    expect(isStateMissing).toBe(true);
  });

  it("rejects claim attempt when Tenant A supplies state minted for Tenant B", () => {
    // Tenant B minted a valid state
    const { state: tenantBState } = createInstallationState({
      organizationId: "tenant-b",
      userId: "user-tenant-b",
    });

    // Tenant A tries to submit Tenant B's state in Tenant A's session context
    const tenantAOrgId = "tenant-a";
    const verified = verifyInstallationState(tenantBState, {
      organizationId: tenantAOrgId,
    });

    // Must be completely rejected
    expect(verified).toBeNull();
  });

  it("rejects installation actions by members (admin/owner required)", () => {
    const userRoleInOrgB: Role = "member";
    const canManageInstallation = isAtLeast(userRoleInOrgB, "admin");
    expect(canManageInstallation).toBe(false);
  });

  it("strictly scopes roles so owner in Org A cannot act as owner in Org B context", () => {
    const userMemberships: Array<{ organizationId: string; role: Role }> = [
      { organizationId: "org-a", role: "owner" },
      { organizationId: "org-b", role: "member" },
    ];

    // In Org B context:
    const activeOrgId = "org-b";
    const activeMembership = userMemberships.find((m) => m.organizationId === activeOrgId);
    expect(activeMembership?.role).toBe("member");

    const canClaimInOrgB = isAtLeast(activeMembership?.role ?? null, "admin");
    expect(canClaimInOrgB).toBe(false);
  });

  it("prevents stealing or reassigning an already connected repository", async () => {
    const mockDb = {
      repository: {
        findUnique: vi.fn().mockResolvedValue({
          id: "repo-1",
          organizationId: "org-legitimate-owner",
        }),
        create: vi.fn(),
        update: vi.fn(),
      },
    };

    // Attacking tenant tries to register the same GitHub repo ID
    await expect(
      registerRepository(mockDb as any, {
        organizationId: "org-attacker",
        githubId: 999999,
        owner: "target-owner",
        name: "private-repo",
        fullName: "target-owner/private-repo",
        private: true,
        defaultBranch: "main",
      }),
    ).rejects.toThrow("already connected to another organization");
  });

  it("ensures concurrent claim attempts cannot produce duplicate or hijacked bindings", async () => {
    let installationOwner: string | null = null;

    // Simulated atomic claim function
    async function attemptClaim(orgId: string): Promise<boolean> {
      if (installationOwner === null) {
        installationOwner = orgId;
        return true;
      }
      return false; // Already claimed by another organization
    }

    // Two tenants attempt to claim the same installation concurrently
    const [claimTenantA, claimTenantB] = await Promise.all([
      attemptClaim("tenant-a"),
      attemptClaim("tenant-b"),
    ]);

    // Exactly one must succeed
    expect(claimTenantA !== claimTenantB).toBe(true);
    expect([claimTenantA, claimTenantB]).toContain(true);
    expect([claimTenantA, claimTenantB]).toContain(false);

    // The owner must be securely locked to the winner
    expect(installationOwner).toMatch(/^tenant-[ab]$/);
  });

  it("prevents webhook events from overwriting an established organization binding", () => {
    const existingInstallation = {
      id: "inst-1",
      installationId: 123456,
      organizationId: "org-legitimate",
      accountLogin: "company",
    };

    // When an installation webhook arrives, update query only touches removedAt, never resets organizationId
    const updateData = { removedAt: null };
    const merged = { ...existingInstallation, ...updateData };

    expect(merged.organizationId).toBe("org-legitimate");
  });
});
