import { startWorker } from "./shared";
import { processVisualRun } from "@/lib/visual/runner";

// One at a time: browser automation is resource-heavy and each run is serial by design.
startWorker({
  queueName: "sentinel.visual",
  workerName: "visual-worker",
  concurrency: 1,
  processor: async (job) => {
    const data = job.data as { visualRunId: string };
    await processVisualRun(data.visualRunId);
  },
});
