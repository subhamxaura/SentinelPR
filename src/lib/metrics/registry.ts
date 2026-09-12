/**
 * Minimal metrics registry — zero dependencies, Prometheus exposition format.
 *
 * Metric names follow OpenTelemetry semantic-convention mapping
 * (`sentinelpr.queue.jobs` → `sentinelpr_queue_jobs_total`), so an OTel
 * Collector scraping these endpoints produces exactly the series an
 * OTel-native pipeline would. Workers expose them over HTTP; see server.ts.
 *
 * Failure-isolation contract: nothing here throws — metrics must never break
 * job processing.
 */

const HISTOGRAM_BUCKETS = [0.1, 0.5, 1, 5, 10, 30, 60, 120, 300, 600];

export interface HistogramObservation {
  counts: number[];
  sum: number;
  count: number;
}

/** Monotonic counter with label sets. */
export class Counter {
  readonly values = new Map<string, number>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  add(value: number, labels: Record<string, string> = {}): void {
    if (!Number.isFinite(value) || value < 0) return;
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + value);
  }
}

/** Last-value-wins gauge. */
export class Gauge {
  readonly values = new Map<string, number>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  set(value: number, labels: Record<string, string> = {}): void {
    if (!Number.isFinite(value)) return;
    this.values.set(labelKey(labels), value);
  }
}

/** Cumulative histogram with fixed buckets. */
export class Histogram {
  readonly observations = new Map<string, HistogramObservation>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: number[] = HISTOGRAM_BUCKETS,
  ) {}

  observe(value: number, labels: Record<string, string> = {}): void {
    if (!Number.isFinite(value) || value < 0) return;
    const key = labelKey(labels);
    const obs =
      this.observations.get(key) ?? { counts: new Array(this.buckets.length).fill(0) as number[], sum: 0, count: 0 };
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) obs.counts[i] += 1;
    }
    obs.sum += value;
    obs.count += 1;
    this.observations.set(key, obs);
  }
}

function labelKey(labels: Record<string, string>): string {
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`);
  return parts.length > 0 ? parts.join("|") : "";
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function renderLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return `{${entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",")}}`;
}

export interface MetricsRegistry {
  counters: Record<string, Counter>;
  gauges: Record<string, Gauge>;
  histograms: Record<string, Histogram>;
}

export function createRegistry(): MetricsRegistry {
  return {
    counters: {
      "sentinelpr_queue_jobs_total": new Counter(
        "sentinelpr_queue_jobs_total",
        "Queue jobs processed, by outcome (completed, failed — one series per attempt).",
      ),
    },
    gauges: {
      "sentinelpr_queue_active_jobs": new Gauge(
        "sentinelpr_queue_active_jobs",
        "Jobs currently in flight on this worker.",
      ),
      "sentinelpr_queue_depth": new Gauge(
        "sentinelpr_queue_depth",
        "Jobs waiting in the queue, by BullMQ state (waiting, delayed, failed, paused).",
      ),
      "sentinelpr_worker_up": new Gauge("sentinelpr_worker_up", "1 when the worker process is serving metrics."),
    },
    histograms: {
      "sentinelpr_queue_job_duration_seconds": new Histogram(
        "sentinelpr_queue_job_duration_seconds",
        "Wall-clock job processing duration, from BullMQ processedOn to completion.",
      ),
    },
  };
}

/** Render the full registry in Prometheus text exposition format (version 0.0.4). */
export function renderExposition(registry: MetricsRegistry, scrapedDepths: Array<Record<string, string | number>>): string {
  const lines: string[] = [];

  const emitCounter = (c: Counter) => {
    lines.push(`# HELP ${c.name} ${c.help}`);
    lines.push(`# TYPE ${c.name} counter`);
    if (c.values.size === 0) {
      lines.push(`${c.name} 0`);
      return;
    }
    for (const [key, value] of c.values) {
      const labels = keyToLabels(key);
      lines.push(`${c.name}${renderLabels(labels)} ${value}`);
    }
  };

  const emitGauge = (g: Gauge, override?: Array<Record<string, string | number>>) => {
    lines.push(`# HELP ${g.name} ${g.help}`);
    lines.push(`# TYPE ${g.name} gauge`);
    const series = override ?? [...g.values].map(([key, value]) => ({ ...keyToLabels(key), value }));
    for (const s of series) {
      const { value, ...rest } = s;
      // Sampler contract: every entry except `value` is a label string.
      const labels = rest as Record<string, string>;
      lines.push(`${g.name}${renderLabels(labels)} ${value}`);
    }
  };

  const emitHistogram = (h: Histogram) => {
    lines.push(`# HELP ${h.name} ${h.help}`);
    lines.push(`# TYPE ${h.name} histogram`);
    for (const [key, obs] of h.observations) {
      const base = keyToLabels(key);
      h.buckets.forEach((le, i) => {
        lines.push(`${h.name}_bucket${renderLabels({ ...base, le: String(le) })} ${obs.counts[i]}`);
      });
      lines.push(`${h.name}_bucket${renderLabels({ ...base, le: "+Inf" })} ${obs.count}`);
      lines.push(`${h.name}_sum${renderLabels(base)} ${obs.sum}`);
      lines.push(`${h.name}_count${renderLabels(base)} ${obs.count}`);
    }
  };

  Object.values(registry.counters).forEach(emitCounter);
  emitGauge(registry.gauges["sentinelpr_queue_active_jobs"]);
  emitGauge(registry.gauges["sentinelpr_queue_depth"], scrapedDepths);
  emitGauge(registry.gauges["sentinelpr_worker_up"]);
  Object.values(registry.histograms).forEach(emitHistogram);

  return `${lines.join("\n")}\n`;
}

function keyToLabels(key: string): Record<string, string> {
  const labels: Record<string, string> = {};
  if (key === "") return labels;
  for (const part of key.split("|")) {
    const idx = part.indexOf("=");
    if (idx > 0) labels[part.slice(0, idx)] = part.slice(idx + 1);
  }
  return labels;
}
