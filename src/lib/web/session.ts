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
import { consumePendingInvites } from "@/lib/auth/provisioning";
import { bestRole } from "@/lib/web/roles";

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
  const { env } = await import("@/lib/env");
  let org = await prisma.organization.findUnique({ where: { slug: env.orgSlug } });
  if (org) return org;
  org = await prisma.organization.create({
    data: { name: env.orgName, slug: env.orgSlug },
  });
  const systemUser = await prisma.user.upsert({
    where: { email: "local@sentinelpr.dev" },
    update: {},
    create: { email: "local@sentinelpr.dev", name: "Local Operator" },
  });
  await prisma.organizationMember.create({
    data: { organizationId: org.id, userId: systemUser.id, role: "owner" },
  });
  return org;
}

/* ── Shared resolution ──────────────────────────────────────────────────── */

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

  const memberships = await prisma.organizationMember.findMany({
    where: { userId: session.user.id },
    select: { organizationId: true, role: true, organization: { select: { id: true, name: true, slug: true } } },
  });
  if (memberships.length === 0) return null;

  const target =
    memberships.find((m) => m.organizationId === session.activeOrgId) ??
    memberships[0];

  return {
    id: target.organization.id,
    name: target.organization.name,
    slug: target.organization.slug,
    sessionId: session.id,
    user: session.user,
    role: bestRole(memberships.map((m) => m.role)),
  };
}

/** Page-context version: throws 401 AppError when unauthenticated in oauth mode. */
export async function requireOrganization(): Promise<OrgContext> {
  const ctx = await resolveContext();
  if (!ctx) throw err.unauthorized("Sign in to continue");
  return ctx;
}

/** Soft variant for read paths that degrade gracefully. */
export async function resolveOrganization(): Promise<OrgContext | null> {
  return resolveContext();
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
