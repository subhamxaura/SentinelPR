import { Queue, JobsOptions } from "bullmq";
import IORedis, { Redis } from "ioredis";
import { env } from "@/lib/env";
import { QUEUE_NAMES } from "@/lib/types";

/**
 * Control plane never executes work — it enqueues. Workers are separate
 * processes (src/workers) with their own concurrency limits.
 *
 * Connection note: BullMQ requires maxRetriesPerRequest: null so long-running
 * workers don't die on a transient Redis blip.
 */

let connection: Redis | null = null;

export function getQueueConnection(): Redis {
  if (!env.redisUrl) {
    throw new Error(
      "REDIS_URL is not configured. Start Redis (docker compose up -d redis) and set REDIS_URL in .env — workers and queues cannot run without it.",
    );
  }
  if (!connection) {
    connection = new IORedis(env.redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
  }
  return connection;
}

const queues = new Map<string, Queue>();

function getQueue(name: string): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: getQueueConnection() });
    queues.set(name, q);
  }
  return q;
}

/** BullMQ job counts by state for a queue — consumed by the metrics sampler. */
export async function getQueueCounts(queueName: string): Promise<Record<string, number>> {
  const q = getQueue(queueName);
  return q.getJobCounts();
}

async function enqueue(queueName: string, jobName: string, data: unknown, jobId: string): Promise<string | null> {
  const q = getQueue(queueName);
  const opts: JobsOptions = {
    jobId,
    attempts: 3,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: { age: 24 * 3600, count: 1000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  };
  const job = await q.add(jobName, data, opts);
  return job.id ?? jobId;
}

export async function enqueueReviewRun(reviewRunId: string): Promise<string | null> {
  // Deterministic job id per run → natural dedup for webhook redeliveries.
  return enqueue(QUEUE_NAMES.review, "review", { reviewRunId }, `review-run-${reviewRunId}`);
}

export async function enqueueVisualRun(visualRunId: string): Promise<string | null> {
  return enqueue(QUEUE_NAMES.visual, "visual", { visualRunId }, `visual-run-${visualRunId}`);
}

export async function enqueueSyntheticRun(syntheticRunId: string): Promise<string | null> {
  return enqueue(QUEUE_NAMES.synthetic, "synthetic", { syntheticRunId }, `synthetic-run-${syntheticRunId}`);
}

// ── Scheduled synthetic runs (BullMQ Job Schedulers — BullMQ v5+ API) ────
// One updatable scheduler per test; pause/resume = upsert/remove. Never uses
// the deprecated `repeat` API.

export async function upsertSyntheticSchedule(
  testId: string,
  cron: string,
  timezone: string,
): Promise<void> {
  const q = getQueue(QUEUE_NAMES.synthetic);
  await q.upsertJobScheduler(
    `synthetic-test-${testId}`,
    { pattern: cron, tz: timezone },
    {
      name: "synthetic-scheduled",
      data: { testId, trigger: "schedule" as const },
    },
  );
}

export async function removeSyntheticSchedule(testId: string): Promise<void> {
  const q = getQueue(QUEUE_NAMES.synthetic);
  await q.removeJobScheduler(`synthetic-test-${testId}`);
}

/** Reconcile all enabled schedules with Redis (called at synthetic worker startup). */
export async function listSyntheticSchedulers(): Promise<string[]> {
  const q = getQueue(QUEUE_NAMES.synthetic);
  const schedulers = await q.getJobSchedulers(0, 1000);
  return schedulers.map((s) => s.id).filter((id): id is string => typeof id === "string");
}

export async function closeQueues(): Promise<void> {
  for (const q of queues.values()) await q.close();
  queues.clear();
  if (connection) {
    await connection.quit().catch(() => connection?.disconnect());
    connection = null;
  }
}
