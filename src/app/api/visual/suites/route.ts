export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { apiError, parseBody } from "@/lib/web/api";
import { requireOrganization } from "@/lib/web/session";
import { validatePublicUrl } from "@/lib/net/guard";

export async function GET() {
  try {
    const org = await requireOrganization();
    const suites = await prisma.visualSuite.findMany({
      where: { organizationId: org.id },
      orderBy: { createdAt: "desc" },
      include: {
        tests: { select: { id: true, enabled: true } },
        runs: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, status: true, createdAt: true } },
      },
    });
    return NextResponse.json({ suites });
  } catch (e) {
    return apiError(e);
  }
}

const createSuiteSchema = z.object({
  name: z.string().min(1).max(120),
  baseUrl: z.string().url().max(2048),
  repositoryId: z.string().cuid().optional().nullable(),
  readinessPath: z.string().max(500).default("/"),
  readinessTimeoutMs: z.number().int().min(1000).max(300_000).default(30_000),
});

export async function POST(req: Request) {
  try {
    const body = parseBody(createSuiteSchema, await req.json());
    const org = await requireOrganization();

    await validatePublicUrl(body.baseUrl); // SSRF guard applies to suites too

    if (body.repositoryId) {
      const repo = await prisma.repository.findFirst({ where: { id: body.repositoryId, organizationId: org.id }, select: { id: true } });
      if (!repo) {
        return NextResponse.json({ error: { code: "NOT_FOUND", message: "Repository not found in this organization", category: "authz" } }, { status: 404 });
      }
    }

    const suite = await prisma.visualSuite.create({
      data: {
        organizationId: org.id,
        repositoryId: body.repositoryId ?? null,
        name: body.name,
        baseUrl: body.baseUrl,
        readinessPath: body.readinessPath,
        readinessTimeoutMs: body.readinessTimeoutMs,
      },
    });
    return NextResponse.json({ suite }, { status: 201 });
  } catch (e) {
    return apiError(e);
  }
}
