/**
 * Request context resolution — pages and API routes call these on every
 * request; nothing is ever resolved from client-supplied IDs.
 *
 * - OAuth mode: context comes from the session cookie + membership rows.
 * - Local mode: legacy single-operator behavior (bootstraps one org).
 */
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { err } from "@/lib/errors";
import { authMode } from "@/lib/auth/mode";
import { readSession, type SessionUser } from "@/lib/auth/session-store";
import { consumePendingInvites, defaultOrganization } from "@/lib/auth/provisioning";
import type { Role } from "@/lib/web/roles";
import { enforceAuthenticatedApiRateLimits, enforcePublicApiRateLimit, rateLimitPolicies, type RateLimitPolicy } from "@/lib/web/rate-limit";

export interface OrgContext {
  id: string;
  name: string;
  slug: string;
  /** DB session row id (oauth mode); null in legacy local mode. */
  sessionId: string | null;
  /** Acting user; null only in legacy local mode. */
  user: SessionUser | null;
  /** Highest-privilege role across active memberships (null in local mode). */
  role: "owner" | "admin" | "member" | null;
}


/* ── Local (legacy) mode ────────────────────────────────────────────────── */

async function resolveLocalOrganization(): Promise<Omit<OrgContext, "user" | "role" | "sessionId">> {
  const org = await defaultOrganization();
  const systemUser = await prisma.user.upsert({
    where: { email: "local@sentinelpr.dev" },
    update: {},
    create: { email: "local@sentinelpr.dev", name: "Local Operator" },
  });
  await prisma.organizationMember.upsert({
    where: { organizationId_userId: { organizationId: org.id, userId: systemUser.id } },
    update: {},
    create: { organizationId: org.id, userId: systemUser.id, role: "owner" },
  });
  return org;
}

/* ── Shared resolution ──────────────────────────────────────────────────── */

export interface UserMembership {
  organizationId: string;
  role: Role;
  organization: { id: string; name: string; slug: string };
}

/**
 * Resolve the active organization membership.
 * Permissions MUST be scoped to the selected organization only; never aggregate
 * or elevate roles across different organizations (cross-tenant privilege escalation).
 */
export function resolveTargetMembership(
  memberships: UserMembership[],
  activeOrgId?: string | null,
): UserMembership | null {
  if (!memberships.length) return null;
  return (
    (activeOrgId ? memberships.find((m) => m.organizationId === activeOrgId) : null) ??
    memberships[0]
  );
}

async function resolveContext(): Promise<OrgContext | null> {
  if (authMode() === "local") {
    const org = await resolveLocalOrganization();
    return { id: org.id, name: org.name, slug: org.slug, sessionId: null, user: null, role: null };
  }

  const session = await readSession();
  if (!session) return null;

  // Invites are consumed lazily on any authenticated request, not only at
  // sign-in — onboarding a user who already has a session takes effect on the
  // next page load. No-op (and cheap) when there is nothing pending.
  await consumePendingInvites(session.user.id, session.user.email).catch(() => undefined);

  const memberships = (await prisma.organizationMember.findMany({
    where: { userId: session.user.id },
    select: { organizationId: true, role: true, organization: { select: { id: true, name: true, slug: true } } },
  })) as UserMembership[];
  if (memberships.length === 0) return null;

  const target = resolveTargetMembership(memberships, session.activeOrgId);
  if (!target) return null;

  return {
    id: target.organization.id,
    name: target.organization.name,
    slug: target.organization.slug,
    sessionId: session.id,
    user: session.user,
    role: target.role,
  };
}

/** Page-context version: throws 401 AppError when unauthenticated in oauth mode. */
export async function requireOrganization(
  req?: Request,
  additionalPolicies: RateLimitPolicy[] = [],
): Promise<OrgContext> {
  const ctx = await resolveContext();
  if (!ctx) {
    if (req) await enforcePublicApiRateLimit(req, rateLimitPolicies.anonymousApi);
    throw err.unauthorized("Sign in to continue");
  }
  if (req) {
    const identity = ctx.user ? `user:${ctx.user.id}` : `local-org:${ctx.id}`;
    await enforceAuthenticatedApiRateLimits(req, identity, additionalPolicies);
  }
  return ctx;
}

/** Soft variant for read paths that degrade gracefully. */
export async function resolveOrganization(req?: Request): Promise<OrgContext | null> {
  const ctx = await resolveContext();
  if (req) {
    if (ctx) {
      const identity = ctx.user ? `user:${ctx.user.id}` : `local-org:${ctx.id}`;
      await enforceAuthenticatedApiRateLimits(req, identity);
    } else {
      await enforcePublicApiRateLimit(req, rateLimitPolicies.anonymousApi);
    }
  }
  return ctx;
}

/**
 * Page-context variant: unauthenticated visitors are redirected to the
 * sign-in page (which also renders the no-membership state) instead of
 * surfacing a raw 401 error boundary.
 */
export async function requirePageOrganization(): Promise<OrgContext> {
  const ctx = await resolveContext();
  if (!ctx) {
    if (authMode() === "oauth") redirect("/signin");
    throw err.unauthorized("Sign in to continue");
  }
  return ctx;
}

/* ── Role checks for mutations ──────────────────────────────────────────── */

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function requireMutationRole(ctx: OrgContext, method: string): void {
  if (!MUTATING_METHODS.has(method.toUpperCase())) return;
  if (ctx.role === null) return; // legacy local mode: single trusted operator
  if (ctx.role === "member") {
    throw err.authz("Members can view data but not modify configuration. Ask an admin.");
  }
}

/** Exported for tests and settings diagnostics. */
export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

/* ── Audit identity ─────────────────────────────────────────────────────── */

export function actorFor(ctx: OrgContext): string {
  return ctx.user ? `user:${ctx.user.id}` : "system";
}

export async function recordAudit(
  organizationId: string,
  actor: string,
  action: string,
  targetType?: string,
  targetId?: string,
  metadata?: Record<string, unknown>,
) {
  await prisma.auditLog.create({
    data: {
      organizationId,
      actor,
      action,
      targetType,
      targetId,
      ...(metadata !== undefined ? { metadata: JSON.parse(JSON.stringify(metadata)) } : {}),
    },
  });
}

export type { SessionUser };
