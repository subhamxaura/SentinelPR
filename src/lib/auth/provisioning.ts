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

/** Idempotently upsert the User row for a GitHub identity. */
export async function upsertUserFromIdentity(identity: GitHubIdentity): Promise<ProvisionedUser> {
  const byEmail = await prisma.user.findUnique({ where: { email: identity.email } });
  if (byEmail) {
    const updated = await prisma.user.update({
      where: { id: byEmail.id },
      data: {
        githubLogin: identity.login,
        avatarUrl: identity.avatarUrl,
        name: byEmail.name ?? identity.name,
      },
    });
    return { id: updated.id, email: updated.email, name: updated.name };
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

  const created = await prisma.user.create({
    data: {
      email: identity.email,
      name: identity.name,
      githubLogin: identity.login,
      avatarUrl: identity.avatarUrl,
    },
  });
  return { id: created.id, email: created.email, name: created.name };
}

/** Default (bootstrap) organization, shared with the legacy local mode + seed. */
export async function defaultOrganization() {
  return prisma.organization.upsert({
    where: { slug: env.orgSlug },
    update: {},
    create: { name: env.orgName, slug: env.orgSlug },
  });
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
    } catch {
      // P2002: already a member (race or pre-existing row) — nothing to do.
    }
  }
  return accepted;
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
    const isFirstMember = (await prisma.organizationMember.count({ where: { organizationId: org.id } })) === 0;
    await prisma.organizationMember.create({
      data: { organizationId: org.id, userId: user.id, role: isFirstMember ? "owner" : "member" },
    });
    return [{ organizationId: org.id, role: isFirstMember ? "owner" : "member" }];
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
