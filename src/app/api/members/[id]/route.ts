import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { err } from "@/lib/errors";
import { apiError, parseBody } from "@/lib/web/api";
import { actorFor, recordAudit, requireOrganization } from "@/lib/web/session";
import { canModifyMember, hasUsableOwnerCount, isAtLeast, type Role } from "@/lib/web/roles";
import { logger } from "@/lib/logger";

const log = logger.child({ module: "api/members" });

export const dynamic = "force-dynamic";

const ROLE = z.enum(["owner", "admin", "member"]);

/** Admin/owner only — member management exposes identities. */
async function requireAdminContext() {
  const ctx = await requireOrganization();
  if (!isAtLeast(ctx.role, "admin")) {
    throw err.authz("Only admins can manage team members.");
  }
  return ctx;
}

/**
 * PATCH /api/members/:id { role } — change a member's role.
 *
 * Rules (see lib/web/roles.ts): owners are immutable to everyone (an owner
 * must promote another owner and then self-demote instead); admins manage
 * member/admin; self-demotion is allowed but the org must always keep at
 * least one owner.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = await requireAdminContext();
    const body = parseBody(z.object({ role: ROLE }), await req.json());

    const target = await prisma.organizationMember.findFirst({
      where: { id, organizationId: ctx.id },
      include: { user: { select: { id: true, email: true } } },
    });
    if (!target) {
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "Member not found in this organization.", category: "authz" } }, { status: 404 });
    }

    const isSelf = !!ctx.user && target.userId === ctx.user.id;
    const ownerCount = await prisma.organizationMember.count({ where: { organizationId: ctx.id, role: "owner" } });

    const decision = canModifyMember(ctx.role, target.role as Role, body.role, { isSelf, ownerCount });
    if (!decision.allowed) {
      return NextResponse.json({ error: { code: "FORBIDDEN", message: decision.reason ?? "Not allowed.", category: "authz" } }, { status: 403 });
    }

    // Defense-in-depth: the org must retain at least one owner after the change.
    const postChangeOwners = ownerCount - (target.role === "owner" && body.role !== "owner" ? 1 : 0);
    if (!hasUsableOwnerCount(postChangeOwners)) {
      return NextResponse.json(
        { error: { code: "LAST_OWNER", message: "Every organization needs at least one owner.", category: "authz" } },
        { status: 409 },
      );
    }

    const updated = await prisma.organizationMember.update({
      where: { id },
      data: { role: body.role },
      include: { user: { select: { id: true, email: true, name: true, githubLogin: true } } },
    });
    await recordAudit(ctx.id, actorFor(ctx), "member.role_changed", "organization_member", id, {
      email: target.user.email,
      from: target.role,
      to: body.role,
    });
    log.info("Member role changed", { org: ctx.id, member: id, from: target.role, to: body.role });
    return NextResponse.json({
      member: { id: updated.id, role: updated.role, email: updated.user.email, name: updated.user.name, githubLogin: updated.user.githubLogin },
    });
  } catch (e) {
    return apiError(e);
  }
}

/** DELETE /api/members/:id — revoke a member's access to this organization. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = await requireAdminContext();

    const target = await prisma.organizationMember.findFirst({
      where: { id, organizationId: ctx.id },
      include: { user: { select: { id: true, email: true } } },
    });
    if (!target) {
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "Member not found in this organization.", category: "authz" } }, { status: 404 });
    }

    const isSelf = !!ctx.user && target.userId === ctx.user.id;
    const ownerCount = await prisma.organizationMember.count({ where: { organizationId: ctx.id, role: "owner" } });

    const decision = canModifyMember(ctx.role, target.role as Role, null, { isSelf, ownerCount });
    if (!decision.allowed) {
      return NextResponse.json({ error: { code: "FORBIDDEN", message: decision.reason ?? "Not allowed.", category: "authz" } }, { status: 403 });
    }

    const postChangeOwners = ownerCount - (target.role === "owner" ? 1 : 0);
    if (!hasUsableOwnerCount(postChangeOwners)) {
      return NextResponse.json(
        { error: { code: "LAST_OWNER", message: "Every organization needs at least one owner.", category: "authz" } },
        { status: 409 },
      );
    }

    await prisma.organizationMember.delete({ where: { id } });
    await recordAudit(ctx.id, actorFor(ctx), "member.removed", "organization_member", id, { email: target.user.email });
    log.info("Member removed", { org: ctx.id, member: id, email: target.user.email });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return apiError(e);
  }
}