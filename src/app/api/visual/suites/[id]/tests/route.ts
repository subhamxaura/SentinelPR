export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { apiError, parseBody } from "@/lib/web/api";
import { requireOrganization } from "@/lib/web/session";

const createTestSchema = z.object({
  name: z.string().min(1).max(200),
  path: z.string().max(2000).default("/"),
  browsers: z.array(z.enum(["chromium", "firefox", "webkit"])).min(1).default(["chromium"]),
  viewports: z
    .array(
      z.object({
        label: z.string().min(1).max(40),
        width: z.number().int().min(200).max(4000),
        height: z.number().int().min(200).max(4000),
      }),
    )
    .min(1)
    .default([{ label: "desktop", width: 1280, height: 720 }]),
  fullPage: z.boolean().default(false),
  threshold: z.number().min(0).max(1).default(0.1),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = parseBody(createTestSchema, await req.json());
    const org = await requireOrganization();

    const suite = await prisma.visualSuite.findFirst({ where: { id, organizationId: org.id }, select: { id: true } });
    if (!suite) {
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "Suite not found", category: "authz" } }, { status: 404 });
    }

    const test = await prisma.visualTest.create({
      data: {
        suiteId: id,
        name: body.name,
        path: body.path,
        browsers: body.browsers,
        viewports: body.viewports,
        fullPage: body.fullPage,
        threshold: body.threshold,
      },
    });
    return NextResponse.json({ test }, { status: 201 });
  } catch (e) {
    return apiError(e);
  }
}
