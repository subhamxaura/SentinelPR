import { Worker, type Processor, type Job } from "bullmq";
import { getQueueConnection } from "@/lib/queue";
import { prisma } from "@/lib/db";
import { toAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { startWorkerMetrics, type WorkerMetrics } from "@/lib/metrics/server";

/**
 * Shared worker scaffolding: BullMQ worker + JobRecord bookkeeping + graceful
 * shutdown. Workers are separate OS processes from the API — untrusted work
 * (Playwright, repo analysis) never runs inside request handling.
 */

const log = logger.child({ module: "worker" });

export function startWorker(opts: {
  queueName: string;
  workerName: string;
  concurrency: number;
  processor: Processor;
}) {
  const worker = new Worker(opts.queueName, opts.processor, {
    connection: getQueueConnection(),
    concurrency: opts.concurrency,
    lockDuration: 10 * 60 * 1000, // Playwright runs are slow; keep the lock
    stalledInterval: 60 * 1000,
  });

  const metrics: WorkerMetrics = startWorkerMetrics({
    queueName: opts.queueName,
    workerName: opts.workerName,
  });

  // BullMQ exposes no per-worker in-flight count; track it from the events we
  // already handle. Every attempt ends in exactly one "completed" or "failed",
  // and a retry re-fires "active" — so decrementing on every failure is
  // drift-free, and during a backoff the job is genuinely not active (it is
  // visible in queue_depth{state="delayed"} instead). Process death resets the
  // gauge, which is exactly what a scrape-based monitor wants.
  let inFlight = 0;

  worker.on("active", async (job) => {
    metrics.setActiveJobs(++inFlight);
    await prisma.jobRecord
      .upsert({
        where: { id: `na-${job.id}` },
        update: { status: "active", startedAt: new Date() },
        create: {
          id: `na-${job.id}`,
          queue: opts.queueName,
          jobId: String(job.id),
          type: job.name,
          status: "active",
          startedAt: new Date(),
        },
      })
      .catch(() => undefined);
  });

  worker.on("completed", async (job) => {
    metrics.setActiveJobs(Math.max(0, --inFlight));
    metrics.observeJobCompletion("completed", job.processedOn);
    await prisma.jobRecord
      .updateMany({ where: { jobId: String(job.id) }, data: { status: "completed", finishedAt: new Date() } })
      .catch(() => undefined);
    log.info("Job completed", { queue: opts.queueName, jobId: job.id });
  });

  worker.on("failed", async (job: Job | undefined, err) => {
    metrics.setActiveJobs(Math.max(0, --inFlight));
    metrics.observeJobCompletion("failed", job?.processedOn);
    const appErr = toAppError(err);
    await prisma.jobRecord
      .updateMany({
        where: { jobId: job ? String(job.id) : "unknown" },
        data: { status: "failed", error: appErr.message, finishedAt: new Date() },
      })
      .catch(() => undefined);
    log.error("Job failed", { queue: opts.queueName, jobId: job?.id, error: appErr.toJSON() });
  });

  worker.on("error", (err) => {
    log.error("Worker error", { queue: opts.queueName, error: err.message });
  });

  const shutdown = async () => {
    log.info("Worker shutting down", { worker: opts.workerName });
    await metrics.close().catch(() => undefined);
    await worker.close().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log.info("Worker started", { worker: opts.workerName, queue: opts.queueName, concurrency: opts.concurrency });
  return worker;
}
