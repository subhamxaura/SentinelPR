/** Pure latency/availability math used by the synthetic monitoring UI and alerts. */

export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const t = idx - lo;
  return Math.round(sorted[lo] * (1 - t) + sorted[hi] * t);
}

export interface RunStat {
  status: string;
  durationMs: number | null;
}

export interface SynthMetrics {
  total: number;
  passed: number;
  failed: number;
  availability: number; // 0..1
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  avgMs: number | null;
  consecutiveFailures: number;
}

export function computeMetrics(runsNewestFirst: RunStat[]): SynthMetrics {
  const total = runsNewestFirst.length;
  const passed = runsNewestFirst.filter((r) => r.status === "passed").length;
  const durations = runsNewestFirst
    .filter((r) => r.status === "passed" && r.durationMs !== null)
    .map((r) => r.durationMs as number)
    .sort((a, b) => a - b);

  let consecutiveFailures = 0;
  for (const r of runsNewestFirst) {
    if (r.status === "failed") consecutiveFailures++;
    else break;
  }

  return {
    total,
    passed,
    failed: total - passed,
    availability: total ? passed / total : 0,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    p99Ms: percentile(durations, 99),
    avgMs: durations.length
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : null,
    consecutiveFailures,
  };
}
