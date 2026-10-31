import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError, parseBody } from "@/lib/web/api";
import { actorFor, requireOrganization } from "@/lib/web/session";
import { isAtLeast } from "@/lib/web/roles";
import { err } from "@/lib/errors";
import { changeMemberRole, removeMember } from "@/lib/web/member-service";
import { logger } from "@/lib/logger";

const log = logger.child({ module: "api/members" });
export const dynamic = "force-dynamic";
const ROLE = z.enum(["owner", "admin", "member"]);

async function requireAdminContext(req: Request) {
  const ctx = await requireOrganization(req);
  if (ctx.role !== null && !isAtLeast(ctx.role, "admin")) {
    throw err.authz("Only admins can manage team members.");
  }
  return ctx;
}

function sendMutationError(result: { kind: string; reason?: string }, missingMessage: string) {
  if (result.kind === "not-found") {
    return NextResponse.json({ error: { code: "NOT_FOUND", message: missingMessage, category: "authz" } }, { status: 404 });
  }
  if (result.kind === "last-owner") {
    return NextResponse.json({ error: { code: "LAST_OWNER", message: "Every organization needs at least one owner.", category: "authz" } }, { status: 409 });
  }
  return NextResponse.json({
    error: { code: "FORBIDDEN", message: result.reason ?? "Not allowed.", category: "authz" },
  }, { status: 403 });
}

/** PATCH /api/members/:id { role } — serialized role change with a durable audit event. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = await requireAdminContext(req);
    const body = parseBody(z.object({ role: ROLE }), await req.json());
    const result = await changeMemberRole({
      organizationId: ctx.id,
      actorUserId: ctx.user?.id ?? null,
      actorLabel: actorFor(ctx),
      memberId: id,
      nextRole: body.role,
    });
    if (result.kind !== "ok") return sendMutationError(result, "Member not found in this organization.");
    log.info("Member role changed", { org: ctx.id, member: id, to: body.role });
    return NextResponse.json({ member: result.value });
  } catch (error) {
    return apiError(error);
  }
}

/** DELETE /api/members/:id — serialized access revocation preserving an owner. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = await requireAdminContext(req);
    const result = await removeMember({
      organizationId: ctx.id,
      actorUserId: ctx.user?.id ?? null,
      actorLabel: actorFor(ctx),
      memberId: id,
    });
    if (result.kind !== "ok") return sendMutationError(result, "Member not found in this organization.");
    log.info("Member removed", { org: ctx.id, member: id });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
