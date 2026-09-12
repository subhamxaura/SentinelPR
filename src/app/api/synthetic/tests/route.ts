export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { apiError, parseBody } from "@/lib/web/api";
import { actorFor, recordAudit, requireMutationRole, requireOrganization } from "@/lib/web/session";
import { stepsSchema, parseCron } from "@/lib/synth/steps";
import { validatePublicUrl } from "@/lib/net/guard";
import { upsertSyntheticSchedule } from "@/lib/queue";

export async function GET(req: Request) {
  try {
    const org = await requireOrganization();
    const tests = await prisma.syntheticTest.findMany({
      where: { organizationId: org.id },
      orderBy: { createdAt: "desc" },
      include: {
        schedule: { select: { cron: true, paused: true, timezone: true } },
        runs: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true, createdAt: true, durationMs: true } },
      },
    });
    return NextResponse.json({ tests });
  } catch (e) {
    return apiError(e);
  }
}

const createSchema = z.object({
  name: z.string().min(1).max(200),
  baseUrl: z.string().url().max(2048),
  steps: stepsSchema,
  alertLatencyMs: z.number().int().min(500).max(600_000).optional().nullable(),
  maxConsecutiveFailures: z.number().int().min(1).max(50).default(3),
  schedule: z
    .object({
      cron: z.string().min(9).max(100),
      timezone: z.string().max(60).default("UTC"),
    })
    .optional(),
});

export async function POST(req: Request) {
  try {
    const body = parseBody(createSchema, await req.json());
    const org = await requireOrganization();
    requireMutationRole(org, req.method);

    await validatePublicUrl(body.baseUrl); // SSRF guard
    if (body.schedule) parseCron(body.schedule.cron); // fail fast on bad cron

    const test = await prisma.syntheticTest.create({
      data: {
        organizationId: org.id,
        name: body.name,
        baseUrl: body.baseUrl,
        steps: body.steps,
        alertLatencyMs: body.alertLatencyMs ?? null,
        maxConsecutiveFailures: body.maxConsecutiveFailures,
        ...(body.schedule
          ? { schedule: { create: { cron: body.schedule.cron, timezone: body.schedule.timezone } } }
          : {}),
      },
      include: { schedule: true },
    });

    if (body.schedule) {
      // Schedule changes are applied to Redis immediately; workers reconcile on boot.
      try {
        await upsertSyntheticSchedule(test.id, body.schedule.cron, body.schedule.timezone);
      } catch {
        // Redis down: DB row is the source of truth, worker reconciles later. Surfaced in UI.
      }
    }

    await recordAudit(org.id, actorFor(org), "synthetic_test.created", "synthetic_test", test.id, { name: test.name });
    return NextResponse.json({ test }, { status: 201 });
  } catch (e) {
    return apiError(e);
  }
}
