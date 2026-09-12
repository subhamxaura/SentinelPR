import { NextResponse } from "next/server";
import { authMode } from "@/lib/auth/mode";
import { setActiveOrganization } from "@/lib/auth/session-store";
import { resolveOrganization } from "@/lib/web/session";
import { apiError } from "@/lib/web/api";

export const dynamic = "force-dynamic";

interface MembershipView {
  organizationId: string;
  name: string;
  slug: string;
  role: string;
}

/** GET /api/session — current user, memberships, active organization. */
export async function GET() {
  try {
    if (authMode() === "local") {
      return NextResponse.json({ mode: "local", user: null, memberships: [], organization: null });
    }
    const ctx = await resolveOrganization();
    if (!ctx) return NextResponse.json({ mode: "oauth", user: null, memberships: [], organization: null });

    const memberships = await listMemberships(ctx.user!.id);
    return NextResponse.json({
      mode: "oauth",
      user: { id: ctx.user!.id, email: ctx.user!.email, name: ctx.user!.name, githubLogin: ctx.user!.githubLogin, avatarUrl: ctx.user!.avatarUrl },
      memberships,
      organization: memberships.find((m) => m.organizationId === ctx.id) ?? null,
    });
  } catch (e) {
    return apiError(e);
  }
}

/** POST /api/session { organizationId } — switch active organization. */
export async function POST(req: Request) {
  try {
    const ctx = await resolveOrganization();
    if (!ctx || !ctx.sessionId) {
      return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Sign in first.", category: "auth" } }, { status: 401 });
    }
    const body = (await req.json().catch(() => null)) as { organizationId?: string } | null;
    const organizationId = body?.organizationId;
    if (!organizationId || typeof organizationId !== "string") {
      return NextResponse.json({ error: { code: "VALIDATION_ERROR", message: "organizationId is required", category: "config" } }, { status: 400 });
    }
    const member = await isMember(ctx.user!.id, organizationId);
    if (!member) {
      return NextResponse.json({ error: { code: "FORBIDDEN", message: "You are not a member of that organization.", category: "authz" } }, { status: 403 });
    }
    await setActiveOrganization(ctx.sessionId, organizationId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return apiError(e);
  }
}

async function listMemberships(userId: string): Promise<MembershipView[]> {
  const { prisma } = await import("@/lib/db");
  const rows = await prisma.organizationMember.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { organizationId: true, role: true, organization: { select: { name: true, slug: true } } },
  });
  return rows.map((r) => ({ organizationId: r.organizationId, name: r.organization.name, slug: r.organization.slug, role: r.role }));
}

async function isMember(userId: string, organizationId: string): Promise<boolean> {
  const { prisma } = await import("@/lib/db");
  const row = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: { id: true },
  });
  return !!row;
}
