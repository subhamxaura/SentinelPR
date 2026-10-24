/**
 * User + organization provisioning.
 *
 * Access model (documented in docs/security-model.md):
 * - A GitHub identity maps 1:1 to a User row (matched by verified email,
 *   with githubLogin as a secondary key for email changes on GitHub's side).
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

/** Idempotently upsert the User row for a GitHub identity. */
export async function upsertUserFromIdentity(identity: GitHubIdentity): Promise<ProvisionedUser> {
  const byEmail = await prisma.user.findUnique({ where: { email: identity.email } });
  if (byEmail) {
    try {
      const updated = await prisma.user.update({
        where: { id: byEmail.id },
        data: {
          githubLogin: identity.login,
          avatarUrl: identity.avatarUrl,
          name: byEmail.name ?? identity.name,
        },
      });
      return { id: updated.id, email: updated.email, name: updated.name };
    } catch (e) {
      // githubLogin is already attached to another local row. The verified
      // email still identifies this account; do not steal the login.
      if (!isUniqueViolation(e)) throw e;
      return { id: byEmail.id, email: byEmail.email, name: byEmail.name };
    }
  }

  // Email changed on GitHub's side — the unique login still identifies the person.
  const byLogin = await prisma.user.findUnique({ where: { githubLogin: identity.login } });
  if (byLogin) {
    const updated = await prisma.user
      .update({
        where: { id: byLogin.id },
        data: {
          email: identity.email,
          avatarUrl: identity.avatarUrl,
          name: byLogin.name ?? identity.name,
        },
      })
      .catch(() => byLogin); // new email already belongs to another local user; keep old
    return { id: updated.id, email: updated.email, name: updated.name };
  }

  try {
    const created = await prisma.user.create({
      data: {
        email: identity.email,
        name: identity.name,
        githubLogin: identity.login,
        avatarUrl: identity.avatarUrl,
      },
    });
    return { id: created.id, email: created.email, name: created.name };
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // Concurrent first sign-in won the insert race.
    const existing =
      (await prisma.user.findUnique({ where: { email: identity.email } })) ??
      (await prisma.user.findUnique({ where: { githubLogin: identity.login } }));
    if (!existing) throw e;
    return { id: existing.id, email: existing.email, name: existing.name };
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
