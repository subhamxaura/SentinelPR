export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { apiError } from "@/lib/web/api";
import { actorFor, recordAudit, requireMutationRole, requireOrganization } from "@/lib/web/session";
import { enqueueSyntheticRun } from "@/lib/queue";

/** Manual "Run now": create a queued run row and enqueue it. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const org = await requireOrganization();
    requireMutationRole(org, req.method);

    const test = await prisma.syntheticTest.findFirst({
      where: { id, organizationId: org.id },
      select: { id: true, enabled: true },
    });
    if (!test) {
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "Test not found", category: "authz" } }, { status: 404 });
    }
    if (!test.enabled) {
      return NextResponse.json({ error: { code: "TEST_DISABLED", message: "Enable this test before running it.", category: "config" } }, { status: 409 });
    }

    const run = await prisma.syntheticRun.create({
      data: { testId: id, trigger: "manual", status: "queued" },
    });

    try {
      await enqueueSyntheticRun(run.id);
    } catch (e) {
      await prisma.syntheticRun.update({
        where: { id: run.id },
        data: { status: "error", error: `Queue unavailable: ${e instanceof Error ? e.message : "Redis unreachable"}` },
      });
      return NextResponse.json(
        { error: { code: "QUEUE_UNAVAILABLE", message: "Redis is not available. Start it with `docker compose up -d redis`.", category: "infrastructure" } },
        { status: 503 },
      );
    }

    await recordAudit(org.id, actorFor(org), "synthetic_run.triggered", "synthetic_run", run.id);
    return NextResponse.json({ runId: run.id }, { status: 202 });
  } catch (e) {
    return apiError(e);
  }
}
