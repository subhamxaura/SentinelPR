import { describe, expect, it } from "vitest";
import { resolveTargetMembership, requireMutationRole } from "./session";
import { bestRole, canAssignRole, canModifyMember, hasUsableOwnerCount, isAtLeast, rankRole } from "./roles";

describe("rankRole", () => {
  it("orders member < admin < owner", () => {
    expect(rankRole("member")).toBeLessThan(rankRole("admin"));
    expect(rankRole("admin")).toBeLessThan(rankRole("owner"));
  });

  it("treats unknown roles as no privilege", () => {
    expect(rankRole("bogus")).toBe(0);
  });
});

describe("bestRole", () => {
  it("returns the highest role across memberships", () => {
    expect(bestRole(["member", "admin"])).toBe("admin");
    expect(bestRole(["member", "owner", "admin"])).toBe("owner");
    expect(bestRole(["member"])).toBe("member");
  });

  it("returns null when there are no memberships", () => {
    expect(bestRole([])).toBeNull();
  });
});

describe("canAssignRole", () => {
  it("lets owners assign any role", () => {
    expect(canAssignRole("owner", "owner")).toBe(true);
    expect(canAssignRole("owner", "admin")).toBe(true);
    expect(canAssignRole("owner", "member")).toBe(true);
  });

  it("lets admins assign member and admin but never owner", () => {
    expect(canAssignRole("admin", "admin")).toBe(true);
    expect(canAssignRole("admin", "member")).toBe(true);
    expect(canAssignRole("admin", "owner")).toBe(false);
  });

  it("blocks members and unauthenticated actors entirely", () => {
    expect(canAssignRole("member", "member")).toBe(false);
    expect(canAssignRole(null, "member")).toBe(false);
  });
});

describe("canModifyMember", () => {
  const no = (reason: string) => ({ allowed: false, reason });

  it("blocks everyone from touching owners (except self)", () => {
    expect(canModifyMember("owner", "owner", "admin", { isSelf: false, ownerCount: 2 })).toEqual(
      no("Owners can only be managed by another owner, and owners cannot be demoted."),
    );
    expect(canModifyMember("admin", "owner", "member", { isSelf: false, ownerCount: 2 }).allowed).toBe(false);
    expect(canModifyMember("admin", "owner", null, { isSelf: false, ownerCount: 2 }).allowed).toBe(false);
    expect(canModifyMember("member", "owner", "member", { isSelf: false, ownerCount: 2 }).allowed).toBe(false);
  });

  it("lets admins manage member/admin but not promote to owner", () => {
    expect(canModifyMember("admin", "member", "admin", { isSelf: false, ownerCount: 1 }).allowed).toBe(true);
    expect(canModifyMember("admin", "admin", "member", { isSelf: false, ownerCount: 1 }).allowed).toBe(true);
    expect(canModifyMember("admin", "member", "owner", { isSelf: false, ownerCount: 1 }).allowed).toBe(false);
    expect(canModifyMember("admin", "member", null, { isSelf: false, ownerCount: 1 }).allowed).toBe(true);
  });

  it("blocks members from managing others", () => {
    expect(canModifyMember("member", "member", "admin", { isSelf: false, ownerCount: 1 }).allowed).toBe(false);
    expect(canModifyMember("member", "admin", "member", { isSelf: false, ownerCount: 1 }).allowed).toBe(false);
  });

  it("allows self-demotion (giving up admin) but guards the last owner", () => {
    expect(canModifyMember("admin", "admin", "member", { isSelf: true, ownerCount: 1 }).allowed).toBe(true);
    expect(canModifyMember("owner", "owner", "member", { isSelf: true, ownerCount: 1 }).allowed).toBe(false);
    expect(canModifyMember("owner", "owner", "member", { isSelf: true, ownerCount: 2 }).allowed).toBe(true);
    expect(canModifyMember("owner", "owner", null, { isSelf: true, ownerCount: 1 }).allowed).toBe(false);
  });

  it("blocks self-promotion above the actor's role", () => {
    expect(canModifyMember("admin", "admin", "owner", { isSelf: true, ownerCount: 1 }).allowed).toBe(false);
    expect(canModifyMember("member", "member", "admin", { isSelf: true, ownerCount: 1 }).allowed).toBe(false);
    expect(canModifyMember("member", "member", "owner", { isSelf: true, ownerCount: 1 }).allowed).toBe(false);
    expect(canModifyMember("admin", "admin", "admin", { isSelf: true, ownerCount: 1 }).allowed).toBe(true);
    expect(canModifyMember("owner", "owner", "owner", { isSelf: true, ownerCount: 1 }).allowed).toBe(true);
  });

  it("rejects unauthenticated actors", () => {
    expect(canModifyMember(null, "member", "member", { isSelf: false, ownerCount: 1 }).allowed).toBe(false);
  });
});

describe("hasUsableOwnerCount", () => {
  it("requires at least one owner after any change", () => {
    expect(hasUsableOwnerCount(1)).toBe(true);
    expect(hasUsableOwnerCount(0)).toBe(false);
  });
});

describe("isAtLeast", () => {
  it("compares against the hierarchy", () => {
    expect(isAtLeast("owner", "admin")).toBe(true);
    expect(isAtLeast("member", "admin")).toBe(false);
    expect(isAtLeast(null, "member")).toBe(false);
  });
});

describe("tenant-scoped role authorization (CRIT-02 regression defense)", () => {
  const orgA = { id: "org-a", name: "Org Alpha", slug: "org-alpha" };
  const orgB = { id: "org-b", name: "Org Beta", slug: "org-beta" };

  const multiOrgMemberships = [
    { organizationId: orgA.id, role: "owner" as const, organization: orgA },
    { organizationId: orgB.id, role: "member" as const, organization: orgB },
  ];

  it("scopes role to Org B when activeOrgId is Org B (owner in A, member in B)", () => {
    const target = resolveTargetMembership(multiOrgMemberships, orgB.id);
    expect(target).not.toBeNull();
    expect(target?.organizationId).toBe(orgB.id);
    expect(target?.role).toBe("member");

    // Must NOT be elevated to owner or admin in Org B despite being owner in Org A
    const ctxB = {
      id: target!.organization.id,
      name: target!.organization.name,
      slug: target!.organization.slug,
      sessionId: "s1",
      user: { id: "u1", email: "user@example.com", name: "User", githubLogin: "user", avatarUrl: null },
      role: target!.role,
    };

    expect(isAtLeast(ctxB.role, "admin")).toBe(false);
    expect(isAtLeast(ctxB.role, "owner")).toBe(false);
    expect(canAssignRole(ctxB.role, "member")).toBe(false);
    expect(canAssignRole(ctxB.role, "admin")).toBe(false);
    expect(canAssignRole(ctxB.role, "owner")).toBe(false);

    // Mutations are blocked for member role
    expect(() => requireMutationRole(ctxB, "POST")).toThrow(/Members can view data but not modify configuration/);
    expect(() => requireMutationRole(ctxB, "DELETE")).toThrow(/Members can view data but not modify configuration/);
  });

  it("scopes role to Org A when activeOrgId is Org A (owner in A, member in B)", () => {
    const target = resolveTargetMembership(multiOrgMemberships, orgA.id);
    expect(target).not.toBeNull();
    expect(target?.organizationId).toBe(orgA.id);
    expect(target?.role).toBe("owner");

    const ctxA = {
      id: target!.organization.id,
      name: target!.organization.name,
      slug: target!.organization.slug,
      sessionId: "s1",
      user: { id: "u1", email: "user@example.com", name: "User", githubLogin: "user", avatarUrl: null },
      role: target!.role,
    };

    expect(isAtLeast(ctxA.role, "admin")).toBe(true);
    expect(isAtLeast(ctxA.role, "owner")).toBe(true);
    expect(canAssignRole(ctxA.role, "member")).toBe(true);
    expect(canAssignRole(ctxA.role, "admin")).toBe(true);
    expect(canAssignRole(ctxA.role, "owner")).toBe(true);

    // Mutations are allowed for owner role
    expect(() => requireMutationRole(ctxA, "POST")).not.toThrow();
  });

  it("handles inverse case: member in Org A, owner in Org B", () => {
    const inverseMemberships = [
      { organizationId: orgA.id, role: "member" as const, organization: orgA },
      { organizationId: orgB.id, role: "owner" as const, organization: orgB },
    ];

    const targetA = resolveTargetMembership(inverseMemberships, orgA.id);
    expect(targetA?.role).toBe("member");

    const targetB = resolveTargetMembership(inverseMemberships, orgB.id);
    expect(targetB?.role).toBe("owner");
  });

  it("handles single-organization user correctly", () => {
    const singleOrg = [
      { organizationId: orgA.id, role: "member" as const, organization: orgA },
    ];
    const target = resolveTargetMembership(singleOrg, null);
    expect(target?.organizationId).toBe(orgA.id);
    expect(target?.role).toBe("member");
  });

  it("falls back to first membership when activeOrgId is unknown or not a member", () => {
    const target = resolveTargetMembership(multiOrgMemberships, "org-unknown");
    expect(target?.organizationId).toBe(orgA.id);
    expect(target?.role).toBe("owner");
  });
});