import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getQueueConnection, upsertSyntheticSchedule, removeSyntheticSchedule } from "@/lib/queue";
import { QUEUE_NAMES } from "@/lib/types";
import { processSyntheticRun, recoverStaleSyntheticRuns } from "@/lib/synth/runner";
import { startWorker } from "./shared";

const log = logger.child({ module: "synthetic-worker" });

/**
 * Scheduled ticks arrive from BullMQ job schedulers with { testId, trigger }.
 * Manual runs arrive with { syntheticRunId } (the API created the row).
 */

async function handleJob(data: { syntheticRunId?: string; testId?: string; trigger?: string }) {
  if (data.syntheticRunId) {
    await processSyntheticRun(data.syntheticRunId);
    return;
  }
  if (data.testId) {
    const test = await prisma.syntheticTest.findUnique({
      where: { id: data.testId },
      select: { enabled: true, schedule: { select: { paused: true } } },
    });
    if (!test?.enabled || !test.schedule || test.schedule.paused) {
      log.info("Skipping scheduled tick — test or schedule is inactive", { testId: data.testId });
      return;
    }

    // Recover any abandoned runs for this test before checking inflight status.
    await recoverStaleSyntheticRuns(data.testId);

    // Duplicate prevention: skip if a tick for this test is already queued/running.
    const inflight = await prisma.syntheticRun.findFirst({
      where: { testId: data.testId, status: { in: ["queued", "running"] } },
      select: { id: true },
    });
    if (inflight) {
      log.info("Skipping scheduled tick — run already in flight", { testId: data.testId });
      return;
    }
    const run = await prisma.syntheticRun.create({
      data: { testId: data.testId, trigger: data.trigger ?? "schedule", status: "queued" },
    });
    await prisma.syntheticSchedule.updateMany({
      where: { testId: data.testId },
      data: { lastEnqueuedAt: new Date() },
    });
    await processSyntheticRun(run.id);
  }
}

startWorker({
  queueName: QUEUE_NAMES.synthetic,
  workerName: "synthetic-worker",
  concurrency: 2,
  processor: async (job) => handleJob(job.data as { syntheticRunId?: string; testId?: string; trigger?: string }),
});

/** Reconcile DB schedules with Redis at startup (drift-proof: the DB is the source of truth). */
async function reconcileSchedules() {
  await recoverStaleSyntheticRuns().catch((e) => {
    log.warn("Startup stale run recovery failed", { error: String(e) });
  });

  const schedules = await prisma.syntheticSchedule.findMany({
    where: { paused: false, test: { enabled: true } },
    select: { testId: true, cron: true, timezone: true },
  });
  const wanted = new Set(schedules.map((s) => `synthetic-test-${s.testId}`));

  for (const s of schedules) {
    await upsertSyntheticSchedule(s.testId, s.cron, s.timezone).catch((e) => {
      log.warn("Schedule upsert failed", { testId: s.testId, error: String(e) });
    });
  }

  const connection = getQueueConnection();
  const { Queue } = await import("bullmq");
  const q = new Queue(QUEUE_NAMES.synthetic, { connection });
  const existing = (await q.getJobSchedulers(0, 2000))
    .map((s) => s.id)
    .filter((id): id is string => typeof id === "string");
  for (const id of existing) {
    if (!wanted.has(id) && id.startsWith("synthetic-test-")) {
      await removeSyntheticSchedule(id.replace("synthetic-test-", ""));
    }
  }
  await q.close();
  log.info("Synthetic schedules reconciled", { active: schedules.length });
}

reconcileSchedules().catch((e) => {
  log.error("Schedule reconciliation failed", { error: e instanceof Error ? e.message : String(e) });
});
