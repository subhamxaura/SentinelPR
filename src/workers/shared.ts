import { Worker, type Processor } from "bullmq";
import { getQueueConnection } from "@/lib/queue";
import { prisma } from "@/lib/db";
import { toAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

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

  worker.on("active", async (job) => {
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
    await prisma.jobRecord
      .updateMany({ where: { jobId: String(job.id) }, data: { status: "completed", finishedAt: new Date() } })
      .catch(() => undefined);
    log.info("Job completed", { queue: opts.queueName, jobId: job.id });
  });

  worker.on("failed", async (job, err) => {
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
    await worker.close().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log.info("Worker started", { worker: opts.workerName, queue: opts.queueName, concurrency: opts.concurrency });
  return worker;
}
