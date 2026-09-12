export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { apiError, parseBody } from "@/lib/web/api";
import { recordAudit, requireOrganization } from "@/lib/web/session";
import { enqueueVisualRun } from "@/lib/queue";

const createRunSchema = z.object({
  suiteId: z.string().cuid(),
  testId: z.string().cuid().optional().nullable(),
  pullRequestId: z.string().cuid().optional().nullable(),
  commitSha: z.string().max(80).optional().nullable(),
});

/** Create a visual run and enqueue it for the visual worker. */
export async function POST(req: Request) {
  try {
    const body = parseBody(createRunSchema, await req.json());
    const org = await requireOrganization();

    const suite = await prisma.visualSuite.findFirst({ where: { id: body.suiteId, organizationId: org.id } });
    if (!suite) {
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "Suite not found", category: "authz" } }, { status: 404 });
    }
    if (suite.enabled === false) {
      return NextResponse.json({ error: { code: "SUITE_DISABLED", message: "This suite is disabled.", category: "config" } }, { status: 409 });
    }
    if (body.testId) {
      const test = await prisma.visualTest.findFirst({ where: { id: body.testId, suiteId: suite.id } });
      if (!test) {
        return NextResponse.json({ error: { code: "NOT_FOUND", message: "Test not found in this suite", category: "authz" } }, { status: 404 });
      }
    }
    if (body.pullRequestId) {
      const pr = await prisma.pullRequest.findFirst({ where: { id: body.pullRequestId, repository: { organizationId: org.id } } });
      if (!pr) {
        return NextResponse.json({ error: { code: "NOT_FOUND", message: "Pull request not found", category: "authz" } }, { status: 404 });
      }
    }

    const run = await prisma.visualRun.create({
      data: {
        suiteId: suite.id,
        testId: body.testId ?? null,
        pullRequestId: body.pullRequestId ?? null,
        commitSha: body.commitSha ?? null,
        trigger: "manual",
        status: "queued",
      },
    });

    try {
      await enqueueVisualRun(run.id);
    } catch (e) {
      await prisma.visualRun.update({
        where: { id: run.id },
        data: { status: "error", error: `Queue unavailable: ${e instanceof Error ? e.message : "Redis unreachable"}` },
      });
      return NextResponse.json(
        { error: { code: "QUEUE_UNAVAILABLE", message: "Redis is not available. Start it with `docker compose up -d redis`.", category: "infrastructure" } },
        { status: 503 },
      );
    }

    await recordAudit(org.id, "user", "visual_run.triggered", "visual_run", run.id);
    return NextResponse.json({ runId: run.id }, { status: 202 });
  } catch (e) {
    return apiError(e);
  }
}
