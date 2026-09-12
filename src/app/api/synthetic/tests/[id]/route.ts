export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { apiError, parseBody } from "@/lib/web/api";
import { actorFor, recordAudit, requireMutationRole, requireOrganization } from "@/lib/web/session";
import { stepsSchema, parseCron } from "@/lib/synth/steps";
import { validatePublicUrl } from "@/lib/net/guard";
import { upsertSyntheticSchedule, removeSyntheticSchedule } from "@/lib/queue";

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  baseUrl: z.string().url().max(2048).optional(),
  steps: stepsSchema.optional(),
  enabled: z.boolean().optional(),
  alertLatencyMs: z.number().int().min(500).max(600_000).optional().nullable(),
  maxConsecutiveFailures: z.number().int().min(1).max(50).optional(),
  schedule: z
    .object({
      cron: z.string().min(9).max(100),
      timezone: z.string().max(60).default("UTC"),
    })
    .optional()
    .nullable(), // null = remove schedule
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = parseBody(updateSchema, await req.json());
    const org = await requireOrganization();
    requireMutationRole(org, req.method);

    const test = await prisma.syntheticTest.findFirst({ where: { id, organizationId: org.id } });
    if (!test) {
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "Test not found", category: "authz" } }, { status: 404 });
    }
    if (body.baseUrl) await validatePublicUrl(body.baseUrl);

    const updated = await prisma.syntheticTest.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl } : {}),
        ...(body.steps !== undefined ? { steps: body.steps } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.alertLatencyMs !== undefined ? { alertLatencyMs: body.alertLatencyMs } : {}),
        ...(body.maxConsecutiveFailures !== undefined ? { maxConsecutiveFailures: body.maxConsecutiveFailures } : {}),
        ...(body.schedule
          ? {
              schedule: {
                upsert: {
                  create: { cron: body.schedule.cron, timezone: body.schedule.timezone },
                  update: { cron: body.schedule.cron, timezone: body.schedule.timezone },
                },
              },
            }
          : {}),
        ...(body.schedule === null ? { schedule: { delete: true } } : {}),
      },
      include: { schedule: true },
    });

    // Sync Redis scheduler with the DB state (DB is source of truth).
    try {
      if (updated.schedule && !updated.schedule.paused && updated.enabled && body.schedule) {
        await upsertSyntheticSchedule(updated.id, updated.schedule.cron, updated.schedule.timezone);
      } else if (body.schedule === null || updated.enabled === false) {
        await removeSyntheticSchedule(updated.id);
      }
    } catch {
      // Redis unavailable — worker reconciles on next start; UI shows scheduler state.
    }

    await recordAudit(org.id, actorFor(org), "synthetic_test.updated", "synthetic_test", id);
    return NextResponse.json({ test: updated });
  } catch (e) {
    return apiError(e);
  }
}

/** Pause/resume is schedule-level state. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = parseBody(z.object({ paused: z.boolean() }), await req.json());
    const org = await requireOrganization();
    requireMutationRole(org, req.method);

    const test = await prisma.syntheticTest.findFirst({
      where: { id, organizationId: org.id },
      include: { schedule: true },
    });
    if (!test) {
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "Test not found", category: "authz" } }, { status: 404 });
    }
    if (!test.schedule) {
      return NextResponse.json({ error: { code: "NO_SCHEDULE", message: "This test has no schedule to pause.", category: "config" } }, { status: 409 });
    }

    await prisma.syntheticSchedule.update({ where: { testId: id }, data: { paused: body.paused } });
    try {
      if (body.paused || !test.enabled) await removeSyntheticSchedule(id);
      else await upsertSyntheticSchedule(id, test.schedule.cron, test.schedule.timezone);
    } catch {
      // Redis unavailable — reconciled on worker start.
    }
    await recordAudit(org.id, actorFor(org), body.paused ? "synthetic_test.paused" : "synthetic_test.resumed", "synthetic_test", id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return apiError(e);
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const org = await requireOrganization();
    requireMutationRole(org, req.method);
    const test = await prisma.syntheticTest.findFirst({ where: { id, organizationId: org.id }, select: { id: true } });
    if (!test) {
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "Test not found", category: "authz" } }, { status: 404 });
    }
    try {
      await removeSyntheticSchedule(id);
    } catch {
      // Redis unavailable; schedule dies with the test row anyway on reconcile.
    }
    await prisma.syntheticTest.delete({ where: { id } });
    await recordAudit(org.id, actorFor(org), "synthetic_test.deleted", "synthetic_test", id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return apiError(e);
  }
}
