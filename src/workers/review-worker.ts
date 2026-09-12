import { startWorker } from "./shared";
import { processReviewRun } from "@/lib/review/pipeline";

startWorker({
  queueName: "sentinel.review",
  workerName: "review-worker",
  concurrency: 2,
  processor: async (job) => {
    const data = job.data as { reviewRunId: string };
    await processReviewRun(data.reviewRunId);
  },
});
