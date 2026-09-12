export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { apiError, parseBody } from "@/lib/web/api";
import { requireMutationRole, requireOrganization } from "@/lib/web/session";

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  path: z.string().max(2000).optional(),
  browsers: z.array(z.enum(["chromium", "firefox", "webkit"])).min(1).optional(),
  viewports: z
    .array(
      z.object({
        label: z.string().min(1).max(40),
        width: z.number().int().min(200).max(4000),
        height: z.number().int().min(200).max(4000),
      }),
    )
    .min(1)
    .optional(),
  fullPage: z.boolean().optional(),
  threshold: z.number().min(0).max(1).optional(),
  enabled: z.boolean().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = parseBody(updateSchema, await req.json());
    const org = await requireOrganization();
    requireMutationRole(org, req.method);

    const test = await prisma.visualTest.findFirst({ where: { id, suite: { organizationId: org.id } } });
    if (!test) {
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "Test not found", category: "authz" } }, { status: 404 });
    }
    const updated = await prisma.visualTest.update({ where: { id }, data: body });
    return NextResponse.json({ test: updated });
  } catch (e) {
    return apiError(e);
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const org = await requireOrganization();
    requireMutationRole(org, req.method);
    const test = await prisma.visualTest.findFirst({ where: { id, suite: { organizationId: org.id } }, select: { id: true } });
    if (!test) {
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "Test not found", category: "authz" } }, { status: 404 });
    }
    await prisma.visualTest.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return apiError(e);
  }
}
