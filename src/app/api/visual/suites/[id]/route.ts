export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { apiError, parseBody } from "@/lib/web/api";
import { requireMutationRole, requireOrganization } from "@/lib/web/session";
import { validatePublicUrl } from "@/lib/net/guard";

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  baseUrl: z.string().url().max(2048).optional(),
  readinessPath: z.string().max(500).optional(),
  readinessTimeoutMs: z.number().int().min(1000).max(300_000).optional(),
  enabled: z.boolean().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = parseBody(updateSchema, await req.json());
    const org = await requireOrganization();
    requireMutationRole(org, req.method);

    const suite = await prisma.visualSuite.findFirst({ where: { id, organizationId: org.id } });
    if (!suite) {
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "Suite not found", category: "authz" } }, { status: 404 });
    }
    if (body.baseUrl) await validatePublicUrl(body.baseUrl);

    const updated = await prisma.visualSuite.update({ where: { id }, data: body });
    return NextResponse.json({ suite: updated });
  } catch (e) {
    return apiError(e);
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const org = await requireOrganization();
    requireMutationRole(org, req.method);
    const suite = await prisma.visualSuite.findFirst({ where: { id, organizationId: org.id }, select: { id: true } });
    if (!suite) {
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "Suite not found", category: "authz" } }, { status: 404 });
    }
    await prisma.visualSuite.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return apiError(e);
  }
}
