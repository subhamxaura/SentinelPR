import { Queue, JobsOptions } from "bullmq";
import IORedis, { Redis } from "ioredis";
import { env } from "@/lib/env";
import { err } from "@/lib/errors";
import { QUEUE_NAMES } from "@/lib/types";

/**
 * Control plane never executes work — it enqueues. Workers are separate
 * processes (src/workers) with their own concurrency limits.
 *
 * Workers use maxRetriesPerRequest: null so long-running jobs survive a
 * transient Redis blip. API producers use a separate fail-fast connection so a
 * dead Redis can never hang a request.
 */

let workerConnection: Redis | null = null;
let producerConnection: Redis | null = null;

function redisUrl(): string {
  if (!env.redisUrl) {
    throw new Error(
      "REDIS_URL is not configured. Start Redis (docker compose up -d redis) and set REDIS_URL in .env — workers and queues cannot run without it.",
    );
  }
  return env.redisUrl;
}

export function getQueueConnection(): Redis {
  if (!workerConnection) {
    workerConnection = new IORedis(redisUrl(), {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
  }
  return workerConnection;
}

function getProducerConnection(): Redis {
  if (!producerConnection) {
    const connection = new IORedis(redisUrl(), {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      enableReadyCheck: true,
      connectTimeout: 3_000,
    });
    connection.on("error", () => undefined);
    producerConnection = connection;
  }
  return producerConnection;
}

/**
 * The producer connection disables the offline queue so a dead Redis cannot
 * buffer commands forever. Wait briefly for the initial handshake, then let
 * BullMQ commands fail fast instead of hanging the request.
 */
function waitForProducerReady(): Promise<Redis> {
  const connection = getProducerConnection();
  if (connection.status === "ready") return Promise.resolve(connection);
  if (connection.status === "end") {
    return Promise.reject(err.infra("Queue unavailable: Redis connection is closed.", "QUEUE_UNAVAILABLE"));
  }

  return new Promise<Redis>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      connection.off("ready", onReady);
      connection.off("error", onError);
      connection.off("end", onEnd);
    };
    const fail = (message: string) => {
      cleanup();
      reject(err.infra(message, "QUEUE_UNAVAILABLE"));
    };
    const onReady = () => {
      cleanup();
      resolve(connection);
    };
    const onError = () => fail("Queue unavailable: Redis connection failed.");
    const onEnd = () => fail("Queue unavailable: Redis connection closed.");
    timer = setTimeout(() => fail("Queue unavailable: Redis connection timed out."), 3_500);
    connection.once("ready", onReady);
    connection.once("error", onError);
    connection.once("end", onEnd);
    if (connection.status === "ready") onReady();
  });
}

const queues = new Map<string, Queue>();

function getQueue(name: string): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: getProducerConnection() });
    queues.set(name, q);
  }
  return q;
}

async function producerQueue(name: string): Promise<Queue> {
  await waitForProducerReady();
  return getQueue(name);
}

/** BullMQ job counts by state for a queue — consumed by the metrics sampler. */
export async function getQueueCounts(queueName: string): Promise<Record<string, number>> {
  const q = await producerQueue(queueName);
  return q.getJobCounts();
}

async function enqueue(queueName: string, jobName: string, data: unknown, jobId: string): Promise<string | null> {
  const q = await producerQueue(queueName);
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
  const q = await producerQueue(QUEUE_NAMES.synthetic);
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
  const q = await producerQueue(QUEUE_NAMES.synthetic);
  await q.removeJobScheduler(`synthetic-test-${testId}`);
}

/** Reconcile all enabled schedules with Redis (called at synthetic worker startup). */
export async function listSyntheticSchedulers(): Promise<string[]> {
  const q = await producerQueue(QUEUE_NAMES.synthetic);
  const schedulers = await q.getJobSchedulers(0, 1000);
  return schedulers.map((s) => s.id).filter((id): id is string => typeof id === "string");
}

export async function closeQueues(): Promise<void> {
  for (const q of queues.values()) await q.close();
  queues.clear();
  if (producerConnection) {
    await producerConnection.quit().catch(() => producerConnection?.disconnect());
    producerConnection = null;
  }
  if (workerConnection) {
    await workerConnection.quit().catch(() => workerConnection?.disconnect());
    workerConnection = null;
  }
}
