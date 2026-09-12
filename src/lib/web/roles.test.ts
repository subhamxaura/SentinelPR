import { describe, expect, it } from "vitest";
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