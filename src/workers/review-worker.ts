import { startWorker } from "./shared";
import { processReviewRun } from "@/lib/review/pipeline";
import { dispatchPendingReviewOutbox } from "@/lib/review/outbox";
import { logger } from "@/lib/logger";
import { startRetentionScheduler } from "@/lib/retention/scheduler";

const log = logger.child({ module: "review-outbox-reconciler" });
let dispatchInProgress: Promise<void> | null = null;
const reconcile = () => {
  if (dispatchInProgress) return;
  dispatchInProgress = dispatchPendingReviewOutbox(50)
    .then(() => undefined)
    .catch((error) => {
      log.error("Review outbox reconciliation failed", {
        error: error instanceof Error ? error.name : "UnknownError",
      });
    })
    .finally(() => { dispatchInProgress = null; });
};

// Repair DB-committed review runs whose API process died before dispatch.
reconcile();
const outboxTimer = setInterval(reconcile, 5_000);
outboxTimer.unref();
const stopRetentionScheduler = startRetentionScheduler();

startWorker({
  queueName: "sentinel.review",
  workerName: "review-worker",
  concurrency: 2,
  processor: async (job) => {
    const data = job.data as { reviewRunId: string };
    await processReviewRun(data.reviewRunId, {
      attempt: job.attemptsMade + 1,
      maxAttempts: Math.max(1, job.opts.attempts ?? 1),
    });
  },
  onShutdown: async () => {
    clearInterval(outboxTimer);
    await Promise.all([dispatchInProgress, stopRetentionScheduler()]);
  },
});
