/**
 * Worker metrics runtime: a per-process registry, an HTTP scrape endpoint, and
 * live queue-depth sampling.
 *
 * Zero dependencies (node:http). Each worker serves Prometheus text format on
 * METRICS_PORT (default 9464) at /metrics — point an OTel Collector's
 * Prometheus receiver at it, or scrape with Prometheus/Grafana Agent directly.
 * OTel semantic-convention-compatible naming throughout.
 *
 * Failure-isolation contract: a broken depth sample degrades to a labelled
 * zero series; the endpoint never fails a scrape and metrics never affect
 * job processing.
 */
import { createServer, type Server } from "node:http";
import { getQueueCounts } from "@/lib/queue";
import { logger } from "@/lib/logger";
import {
  createRegistry,
  renderExposition,
  type MetricsRegistry,
} from "./registry";

const log = logger.child({ module: "metrics" });

export interface WorkerMetrics {
  registry: MetricsRegistry;
  server: Server;
  close: () => Promise<void>;
  observeJobCompletion: (outcome: "completed" | "failed", startedAt: number | undefined) => void;
  setActiveJobs: (n: number) => void;
}

const port = Number(process.env.METRICS_PORT ?? 9464);

export function startWorkerMetrics(opts: { queueName: string; workerName: string }): WorkerMetrics {
  const registry = createRegistry();
  let active = 0;

  registry.gauges["sentinelpr_worker_up"].set(1, { worker: opts.workerName });

  // Sample live queue depth on scrape; Redis hiccups degrade to labelled zeros.
  async function sampleDepths(): Promise<Array<Record<string, string | number>>> {
    try {
      const counts = await getQueueCounts(opts.queueName);
      const series: Array<Record<string, string | number>> = [];
      for (const [state, value] of Object.entries(counts)) {
        if (typeof value === "number") series.push({ queue: opts.queueName, state, value });
      }
      return series.length > 0 ? series : [{ queue: opts.queueName, state: "none", value: 0 }];
    } catch (e) {
      log.warn("Queue depth sample failed", { error: e instanceof Error ? e.message : "unknown" });
      return [{ queue: opts.queueName, state: "unavailable", value: 0 }];
    }
  }

  const server = createServer((req, res) => {
    if (req.method !== "GET" || (req.url !== "/metrics" && req.url !== "/")) {
      res.writeHead(404).end();
      return;
    }
    sampleDepths()
      .then((depths) => {
        const body = renderExposition(registry, depths);
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
        res.end(body);
      })
      .catch(() => {
        // Depth sampling is best-effort; still serve the counters/histograms.
        const body = renderExposition(registry, [{ queue: opts.queueName, state: "unavailable", value: 0 }]);
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
        res.end(body);
      });
  });

  server.on("error", (err) => {
    // A port conflict must never kill job processing — log and continue.
    log.error("Metrics server error (job processing continues)", { error: err.message });
  });

  server.listen(port);

  return {
    registry,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    observeJobCompletion: (outcome, startedAt) => {
      registry.counters["sentinelpr_queue_jobs_total"].add(1, { queue: opts.queueName, outcome });
      const durationSec = startedAt ? (Date.now() - startedAt) / 1000 : undefined;
      if (durationSec !== undefined) {
        registry.histograms["sentinelpr_queue_job_duration_seconds"].observe(durationSec, {
          queue: opts.queueName,
          outcome,
        });
      }
    },
    setActiveJobs: (n) => {
      active = n;
      registry.gauges["sentinelpr_queue_active_jobs"].set(n, { queue: opts.queueName });
    },
  };
}

/** Default metrics configuration surfaced by the settings diagnostics. */
export const METRICS_DEFAULTS = { port: 9464, path: "/metrics" };
