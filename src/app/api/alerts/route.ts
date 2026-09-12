export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { apiError, parseBody } from "@/lib/web/api";
import { requireMutationRole, requireOrganization } from "@/lib/web/session";

export async function GET(req: Request) {
  try {
    const org = await requireOrganization();
    const alerts = await prisma.alert.findMany({
      where: { organizationId: org.id },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return NextResponse.json({ alerts });
  } catch (e) {
    return apiError(e);
  }
}

const patchSchema = z.object({ status: z.enum(["acknowledged", "resolved"]) });

export async function PATCH(req: Request) {
  try {
    const body = parseBody(patchSchema, await req.json());
    const org = await requireOrganization();
    requireMutationRole(org, req.method);
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: { code: "VALIDATION_ERROR", message: "id query param required", category: "config" } }, { status: 400 });
    }
    const alert = await prisma.alert.findFirst({ where: { id, organizationId: org.id }, select: { id: true } });
    if (!alert) {
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "Alert not found", category: "authz" } }, { status: 404 });
    }
    const updated = await prisma.alert.update({
      where: { id },
      data: { status: body.status, resolvedAt: body.status === "resolved" ? new Date() : null },
    });
    return NextResponse.json({ alert: updated });
  } catch (e) {
    return apiError(e);
  }
}
