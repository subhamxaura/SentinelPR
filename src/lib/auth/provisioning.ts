/**
 * User + organization provisioning.
 *
 * Access model (documented in docs/security-model.md):
 * - A GitHub identity maps 1:1 to a User row by GitHub's immutable numeric ID.
 * - A verified primary email may bind a legacy row once, but an email already
 *   bound to a different GitHub ID is never silently merged.
 * - Memberships come from existing rows, pending OrganizationInvite rows, or —
 *   when AUTH_ALLOW_DEFAULT_ORG_SIGNUP is not "0" — auto-joining the default
 *   org. The first member of the default org becomes its owner.
 * - With auto-join disabled and no invite, sign-in yields zero memberships:
 *   the dashboard shows a request-access screen instead of any data.
 */
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import type { GitHubIdentity } from "./github-oauth";

export interface MembershipRef {
  organizationId: string;
  role: string;
}

export interface ProvisionedUser {
  id: string;
  email: string;
  name: string | null;
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === "P2002";
}

function isSerializationFailure(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === "P2034";
}

function toProvisionedUser(user: { id: string; email: string; name: string | null }): ProvisionedUser {
  return { id: user.id, email: user.email, name: user.name };
}

/** Bind a GitHub account by its immutable provider ID; never trust a mutable login as identity. */
export async function upsertUserFromIdentity(identity: GitHubIdentity): Promise<ProvisionedUser> {
  const githubId = String(identity.githubId);
  const byId = await prisma.user.findUnique({ where: { githubId } });
  if (byId) {
    const emailOwner = await prisma.user.findUnique({ where: { email: identity.email } });
    if (emailOwner && emailOwner.id !== byId.id) {
      throw new Error("This verified GitHub email is already linked to a different SentinelPR account.");
    }
    const loginOwner = await prisma.user.findUnique({ where: { githubLogin: identity.login } });
    const updated = await prisma.user.update({
      where: { id: byId.id },
      data: {
        email: identity.email,
        githubLogin: loginOwner && loginOwner.id !== byId.id ? byId.githubLogin : identity.login,
        avatarUrl: identity.avatarUrl,
        name: byId.name ?? identity.name,
      },
    });
    return toProvisionedUser(updated);
  }

  const byEmail = await prisma.user.findUnique({ where: { email: identity.email } });
  if (byEmail) {
    if (byEmail.githubId && byEmail.githubId !== githubId) {
      throw new Error("This verified GitHub email is already linked to a different GitHub account.");
    }
    const loginOwner = await prisma.user.findUnique({ where: { githubLogin: identity.login } });
    const updated = await prisma.user.update({
      where: { id: byEmail.id },
      data: {
        githubId,
        githubLogin: loginOwner && loginOwner.id !== byEmail.id ? byEmail.githubLogin : identity.login,
        avatarUrl: identity.avatarUrl,
        name: byEmail.name ?? identity.name,
      },
    });
    return toProvisionedUser(updated);
  }

  // If a recycled username still belongs to a legacy account, do not claim it.
  const loginOwner = await prisma.user.findUnique({ where: { githubLogin: identity.login } });
  const data = {
    githubId,
    email: identity.email,
    name: identity.name,
    githubLogin: loginOwner ? null : identity.login,
    avatarUrl: identity.avatarUrl,
  };
  try {
    return toProvisionedUser(await prisma.user.create({ data }));
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // A same-account first-sign-in race is resolved by immutable ID. A distinct
    // account claiming the same verified email is rejected, never merged.
    const racedById = await prisma.user.findUnique({ where: { githubId } });
    if (racedById) return toProvisionedUser(racedById);
    const racedByEmail = await prisma.user.findUnique({ where: { email: identity.email } });
    if (racedByEmail) {
      if (racedByEmail.githubId && racedByEmail.githubId !== githubId) {
        throw new Error("This verified GitHub email is already linked to a different GitHub account.");
      }
      const bound = await prisma.user.update({ where: { id: racedByEmail.id }, data: { githubId } });
      return toProvisionedUser(bound);
    }
    // A username-only collision can be safely avoided because githubId is the
    // identity key; create an account without the display login rather than
    // attaching a different person's account.
    if (data.githubLogin) {
      const created = await prisma.user.create({ data: { ...data, githubLogin: null } });
      return toProvisionedUser(created);
    }
    throw error;
  }
}

/** Default (bootstrap) organization, shared with the legacy local mode + seed. */
export async function defaultOrganization() {
  try {
    return await prisma.organization.upsert({
      where: { slug: env.orgSlug },
      update: {},
      create: { name: env.orgName, slug: env.orgSlug },
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const existing = await prisma.organization.findUnique({ where: { slug: env.orgSlug } });
    if (!existing) throw e;
    return existing;
  }
}

/**
 * Consume every pending invite for an email. Idempotent: concurrent requests
 * racing the same invite are absorbed by the (organizationId, userId) unique
 * constraint. Returns the memberships that were granted.
 */
export async function consumePendingInvites(userId: string, email: string): Promise<MembershipRef[]> {
  const invites = await prisma.organizationInvite.findMany({
    where: { email: email.toLowerCase(), acceptedAt: null },
    select: { id: true, organizationId: true, role: true },
  });
  if (invites.length === 0) return [];

  const accepted: MembershipRef[] = [];
  for (const invite of invites) {
    try {
      await prisma.$transaction([
        prisma.organizationMember.create({
          data: { organizationId: invite.organizationId, userId, role: invite.role },
        }),
        prisma.organizationInvite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } }),
      ]);
      accepted.push({ organizationId: invite.organizationId, role: invite.role });
    } catch (e) {
      // P2002: already a member (race or pre-existing row) — nothing to do.
      if (!isUniqueViolation(e)) throw e;
    }
  }
  return accepted;
}

/**
 * Auto-join the default organization. Serializable isolation prevents two
 * concurrent first sign-ins from both observing an empty membership table and
 * becoming owner; P2034 retries and P2002 handles the same-user race.
 */
async function joinDefaultOrganization(organizationId: string, userId: string): Promise<MembershipRef> {
  const key = { organizationId, userId };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const existing = await tx.organizationMember.findUnique({
            where: { organizationId_userId: key },
            select: { role: true },
          });
          if (existing) return { organizationId, role: existing.role };

          const isFirstMember = (await tx.organizationMember.count({ where: { organizationId } })) === 0;
          const role = isFirstMember ? "owner" : "member";
          const created = await tx.organizationMember.create({
            data: { organizationId, userId, role },
            select: { role: true },
          });
          return { organizationId, role: created.role };
        },
        { isolationLevel: "Serializable" },
      );
    } catch (e) {
      if (isUniqueViolation(e)) {
        const existing = await prisma.organizationMember.findUnique({
          where: { organizationId_userId: key },
          select: { role: true },
        });
        if (existing) return { organizationId, role: existing.role };
      }
      if (isSerializationFailure(e) && attempt < 2) continue;
      throw e;
    }
  }
  throw new Error("Could not join the default organization after retries");
}

/**
 * Resolve memberships for a freshly signed-in user. Consumes pending invites,
 * optionally auto-joins the default org. Returns the full membership list.
 */
export async function ensureMemberships(user: ProvisionedUser): Promise<MembershipRef[]> {
  const accepted = await consumePendingInvites(user.id, user.email);
  if (accepted.length > 0) return accepted;

  const existing = await prisma.organizationMember.findMany({
    where: { userId: user.id },
    select: { organizationId: true, role: true },
  });
  if (existing.length > 0) return existing;

  if (env.auth.allowDefaultOrgSignup) {
    const org = await defaultOrganization();
    return [await joinDefaultOrganization(org.id, user.id)];
  }

  return [];
}

export function pickDefaultMembership(
  memberships: MembershipRef[],
  activeOrgId: string | null,
): MembershipRef | null {
  if (memberships.length === 0) return null;
  return memberships.find((m) => m.organizationId === activeOrgId) ?? memberships[0];
}
