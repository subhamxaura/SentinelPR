import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { err } from "@/lib/errors";
import { apiError, parseBody } from "@/lib/web/api";
import { actorFor, recordAudit, requireOrganization } from "@/lib/web/session";
import { canAssignRole, isAtLeast } from "@/lib/web/roles";
import { logger } from "@/lib/logger";

const log = logger.child({ module: "api/invites" });

export const dynamic = "force-dynamic";

const ROLE = z.enum(["owner", "admin", "member"]);

/** Admin/owner only — this endpoint exposes the org's member roster. */
async function requireAdminContext() {
  const ctx = await requireOrganization();
  if (!isAtLeast(ctx.role, "admin")) {
    throw err.authz("Only admins can manage the team.");
  }
  return ctx;
}

/** GET /api/invites — members and pending invites for the org. */
export async function GET(req: Request) {
  try {
    const ctx = await requireAdminContext();
    const members = await prisma.organizationMember.findMany({
      where: { organizationId: ctx.id },
      orderBy: { createdAt: "asc" },
      include: { user: { select: { id: true, email: true, name: true, githubLogin: true, avatarUrl: true } } },
    });
    const invites = await prisma.organizationInvite.findMany({
      where: { organizationId: ctx.id, acceptedAt: null },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json({
      members: members.map((m) => ({
        id: m.id,
        email: m.user.email,
        name: m.user.name,
        githubLogin: m.user.githubLogin,
        avatarUrl: m.user.avatarUrl,
        role: m.role,
        createdAt: m.createdAt,
      })),
      invites: invites.map((i) => ({ id: i.id, email: i.email, role: i.role, createdAt: i.createdAt })),
    });
  } catch (e) {
    return apiError(e);
  }
}

const createInviteSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  role: ROLE,
});

/** POST /api/invites { email, role } — create a pending invite. */
export async function POST(req: Request) {
  try {
    const ctx = await requireAdminContext();
    const body = parseBody(createInviteSchema, await req.json());

    if (!canAssignRole(ctx.role, body.role)) {
      throw err.authz(`Only owners can assign the ${body.role} role.`);
    }

    // Already a member? (email matches a User with a membership in this org.)
    const existing = await prisma.user.findUnique({
      where: { email: body.email },
      select: { memberships: { where: { organizationId: ctx.id }, select: { id: true } } },
    });
    if (existing?.memberships.length) {
      return NextResponse.json(
        { error: { code: "ALREADY_MEMBER", message: "That user is already a member of this organization.", category: "config" } },
        { status: 409 },
      );
    }

    const invite = await prisma.organizationInvite.create({
      data: { organizationId: ctx.id, email: body.email, role: body.role },
    });
    await recordAudit(ctx.id, actorFor(ctx), "invite.created", "organization_invite", invite.id, { email: body.email, role: body.role });
    log.info("Invite created", { org: ctx.id, email: body.email, role: body.role });
    return NextResponse.json({ invite: { id: invite.id, email: invite.email, role: invite.role, createdAt: invite.createdAt } }, { status: 201 });
  } catch (e) {
    if (typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002") {
      return NextResponse.json(
        { error: { code: "INVITE_EXISTS", message: "A pending invite for that email already exists.", category: "config" } },
        { status: 409 },
      );
    }
    return apiError(e);
  }
}

/** DELETE /api/invites?id=… — revoke a pending invite. */
export async function DELETE(req: Request) {
  try {
    const ctx = await requireAdminContext();
    const id = new URL(req.url).searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: { code: "VALIDATION_ERROR", message: "id query param required", category: "config" } }, { status: 400 });
    }
    const invite = await prisma.organizationInvite.findFirst({
      where: { id, organizationId: ctx.id, acceptedAt: null },
      select: { id: true, email: true },
    });
    if (!invite) {
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "No pending invite with that id.", category: "authz" } }, { status: 404 });
    }
    await prisma.organizationInvite.delete({ where: { id } });
    await recordAudit(ctx.id, actorFor(ctx), "invite.revoked", "organization_invite", id, { email: invite.email });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return apiError(e);
  }
}