import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { readSession } from "@/lib/auth/session-store";
import { authMode } from "@/lib/auth/mode";
import { defaultOrganization } from "@/lib/auth/provisioning";
import { isAtLeast } from "@/lib/web/roles";
import { recordAudit, requireOrganization } from "@/lib/web/session";
import { apiError, parseBody } from "@/lib/web/api";

export const dynamic = "force-dynamic";

/**
 * POST /api/access-requests — self-serve access request.
 *
 * Note the gate: this route is authenticated by the SESSION, not by
 * requireOrganization — its whole purpose is to serve signed-in users who
 * have no membership anywhere and therefore fail the org gate.
 */
export async function POST(req: Request) {
  try {
    if (authMode() !== "oauth") {
      return NextResponse.json(
        { error: { code: "OAUTH_DISABLED", message: "Access requests apply to OAuth deployments.", category: "config" } },
        { status: 503 },
      );
    }
    const session = await readSession();
    if (!session) {
      return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Sign in first.", category: "auth" } }, { status: 401 });
    }

    // Requests target the default (bootstrap) organization — the one new
    // users would auto-join when AUTH_ALLOW_DEFAULT_ORG_SIGNUP is enabled.
    const org = await defaultOrganization();

    const alreadyMember = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: org.id, userId: session.user.id } },
      select: { id: true },
    });
    if (alreadyMember) {
      return NextResponse.json(
        { error: { code: "ALREADY_MEMBER", message: "You are already a member of this organization.", category: "config" } },
        { status: 409 },
      );
    }

    const pending = await prisma.accessRequest.findFirst({
      where: { organizationId: org.id, userId: session.user.id, status: "pending" },
      select: { id: true },
    });
    if (pending) {
      return NextResponse.json(
        { error: { code: "REQUEST_PENDING", message: "You already have a pending request.", category: "config" } },
        { status: 409 },
      );
    }

    // P2002 safety net: (organizationId, userId, status=pending) is unique.
    const request = await prisma.accessRequest
      .create({
        data: {
          organizationId: org.id,
          userId: session.user.id,
          email: session.user.email,
          githubLogin: session.user.githubLogin,
          role: "member",
        },
      })
      .catch(async (e) => {
        if (typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002") {
          return null;
        }
        throw e;
      });
    if (!request) {
      return NextResponse.json(
        { error: { code: "REQUEST_PENDING", message: "You already have a pending request.", category: "config" } },
        { status: 409 },
      );
    }

    await recordAudit(org.id, `user:${session.user.id}`, "access.requested", "access_request", request.id, {
      email: session.user.email,
    });
    return NextResponse.json({ request: { id: request.id, status: request.status } }, { status: 201 });
  } catch (e) {
    return apiError(e);
  }
}

const decideSchema = z.object({ action: z.enum(["approve", "deny"]) });

/**
 * POST /api/access-requests?id=… { action } — admin approval/denial.
 * Approval creates the membership atomically with the status flip.
 */
export async function PUT(req: Request) {
  try {
    const ctx = await requireOrganization();
    if (!isAtLeast(ctx.role, "admin")) {
      return NextResponse.json(
        { error: { code: "FORBIDDEN", message: "Only admins can decide access requests.", category: "authz" } },
        { status: 403 },
      );
    }
    const body = parseBody(decideSchema, await req.json());
    const id = new URL(req.url).searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: { code: "VALIDATION_ERROR", message: "id query param required", category: "config" } }, { status: 400 });
    }

    const request = await prisma.accessRequest.findFirst({
      where: { id, organizationId: ctx.id, status: "pending" },
    });
    if (!request) {
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message: "No pending request with that id.", category: "authz" } },
        { status: 404 },
      );
    }

    if (body.action === "deny") {
      await prisma.accessRequest.update({
        where: { id },
        data: { status: "denied", decidedAt: new Date(), decidedBy: ctx.user?.id ?? "system" },
      });
      await recordAudit(ctx.id, ctx.user ? `user:${ctx.user.id}` : "system", "access.denied", "access_request", id, {
        email: request.email,
      });
      return NextResponse.json({ ok: true, status: "denied" });
    }

    // Approve: membership + status flip in one transaction. A P2002 race
    // (already became a member another way) still marks the request approved.
    try {
      await prisma.$transaction([
        prisma.organizationMember.create({
          data: { organizationId: ctx.id, userId: request.userId, role: request.role },
        }),
        prisma.accessRequest.update({
          where: { id },
          data: { status: "approved", decidedAt: new Date(), decidedBy: ctx.user?.id ?? "system" },
        }),
      ]);
    } catch (e) {
      if (typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002") {
        await prisma.accessRequest
          .update({ where: { id }, data: { status: "approved", decidedAt: new Date(), decidedBy: ctx.user?.id ?? "system" } })
          .catch(() => undefined);
      } else {
        throw e;
      }
    }

    await recordAudit(ctx.id, ctx.user ? `user:${ctx.user.id}` : "system", "access.granted", "access_request", id, {
      email: request.email,
      role: request.role,
    });
    return NextResponse.json({ ok: true, status: "approved" });
  } catch (e) {
    return apiError(e);
  }
}
