import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { err } from "@/lib/errors";

/**
 * Local single-tenant mode.
 *
 * SentinelPR resolves the acting organization server-side on every request —
 * never from client-supplied IDs — and all queries are scoped by it. Today the
 * deployment model is "one operator, trusted dashboard" (local/self-hosted);
 * the org/membership schema is already multi-tenant, so dropping in an OAuth
 * session provider later only means replacing resolveOrganization().
 * This limitation is documented in docs/security-model.md.
 */
export async function resolveOrganization() {
  const slug = env.orgSlug;
  let org = await prisma.organization.findUnique({ where: { slug } });
  if (org) return org;

  org = await prisma.organization.create({
    data: { name: env.orgName, slug },
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

export async function requireOrganization() {
  const org = await resolveOrganization();
  if (!org) throw err.authz("No organization is available for this request");
  return org;
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
