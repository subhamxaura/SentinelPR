/**
 * Role rules — pure and unit-testable.
 *
 * Hierarchy: owner > admin > member. Admins may manage members and invites
 * but cannot assign the owner role; only an owner can.
 */
export type Role = "owner" | "admin" | "member";

const ROLE_RANK: Record<Role, number> = { member: 1, admin: 2, owner: 3 };

export function rankRole(role: string): number {
  return ROLE_RANK[role as Role] ?? 0;
}

/** Highest-privilege role across a set of membership roles. */
export function bestRole(roles: string[]): Role | null {
  if (roles.length === 0) return null;
  const top = roles.reduce((a, b) => (rankRole(a) >= rankRole(b) ? a : b));
  return top === "owner" || top === "admin" || top === "member" ? top : "member";
}

/**
 * May `actor` grant `target`? Owners may assign any role; admins may assign
 * member/admin but never owner; members may not assign roles at all.
 */
export function canAssignRole(actor: Role | null, target: Role): boolean {
  if (!actor) return false;
  if (actor === "owner") return true;
  if (actor === "admin") return target === "member" || target === "admin";
  return false;
}

/**
 * May `actor` change `target`'s existing role from `targetCurrent` to
 * `targetNext` (or remove them entirely when `targetNext` is null)?
 *
 * Owner-protection rules:
 * - Nobody may edit a fellow owner except an owner; even then, an owner can
 *   never demote or remove another owner (last-owner guard makes this total).
 * - Admins can never act on owners at all.
 * - Actors can always act on themselves — a self-demotion is the accepted way
 *   to give up admin — EXCEPT that demoting/removing yourself as the last
 *   owner is blocked by the owner-count guard at the call site.
 */
export function canModifyMember(
  actor: Role | null,
  targetCurrent: Role,
  targetNext: Role | null,
  opts: { isSelf: boolean; ownerCount: number },
): { allowed: boolean; reason?: string } {
  if (!actor) return { allowed: false, reason: "Not authenticated." };
  if (opts.isSelf) {
    if (actor === "owner" && targetCurrent === "owner" && targetNext !== "owner" && opts.ownerCount <= 1) {
      return { allowed: false, reason: "You are the last owner — promote another owner first." };
    }
    return { allowed: true };
  }
  if (targetCurrent === "owner") {
    return { allowed: false, reason: "Owners can only be managed by another owner, and owners cannot be demoted." };
  }
  if (actor === "member") return { allowed: false, reason: "Members cannot manage other members." };
  if (targetNext !== null && !canAssignRole(actor, targetNext)) {
    return { allowed: false, reason: `Only owners can assign the ${targetNext} role.` };
  }
  return { allowed: true };
}

/**
 * Removes (demote/remove) guard: an organization must always keep at least
 * one owner. Callers pass the post-change owner count including the change.
 */
export function hasUsableOwnerCount(postChangeOwnerCount: number): boolean {
  return postChangeOwnerCount >= 1;
}

export function isAtLeast(actual: Role | null, minimum: Role): boolean {
  return !!actual && rankRole(actual) >= rankRole(minimum);
}