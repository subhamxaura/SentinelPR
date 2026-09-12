import { describe, expect, it } from "vitest";
import { Counter, Gauge, Histogram, createRegistry, renderExposition } from "./registry";

describe("Counter", () => {
  it("accumulates per label set and defaults to unlabeled", () => {
    const c = new Counter("jobs_total", "Jobs");
    c.add(1, { outcome: "completed" });
    c.add(2, { outcome: "completed" });
    c.add(5, { outcome: "failed" });
    c.add(3); // no labels
    expect(c.values.get("outcome=completed")).toBe(3);
    expect(c.values.get("outcome=failed")).toBe(5);
    expect(c.values.get("")).toBe(3);
  });

  it("rejects negative and non-finite increments (no series corruption)", () => {
    const c = new Counter("jobs_total", "Jobs");
    c.add(-1);
    c.add(Number.NaN);
    c.add(Number.POSITIVE_INFINITY);
    expect(c.values.size).toBe(0);
  });
});

describe("Gauge", () => {
  it("is last-value-wins", () => {
    const g = new Gauge("depth", "Depth");
    g.set(3, { state: "waiting" });
    g.set(9, { state: "waiting" });
    expect(g.values.get("state=waiting")).toBe(9);
  });

  it("rejects non-finite values", () => {
    const g = new Gauge("depth", "Depth");
    g.set(Number.NaN);
    expect(g.values.size).toBe(0);
  });
});

describe("Histogram", () => {
  it("categorizes observations into buckets cumulatively", () => {
    const h = new Histogram("dur_seconds", "Duration", [1, 10, 100]);
    h.observe(0.5);
    h.observe(5);
    h.observe(50);
    h.observe(500);
    const obs = h.observations.get("")!;
    // le=1 catches 0.5; le=10 catches 0.5,5; le=100 catches 0.5,5,50; +Inf catches all
    expect(obs.counts).toEqual([1, 2, 3]);
    expect(obs.count).toBe(4);
    expect(obs.sum).toBeCloseTo(555.5);
  });

  it("separates observations by label key", () => {
    const h = new Histogram("dur_seconds", "Duration", [10]);
    h.observe(1, { outcome: "completed" });
    h.observe(9, { outcome: "failed" });
    expect(h.observations.size).toBe(2);
    expect(h.observations.get("outcome=completed")!.count).toBe(1);
    expect(h.observations.get("outcome=failed")!.count).toBe(1);
  });
});

describe("renderExposition", () => {
  it("renders a spec-valid scrape body from a live-shaped registry", () => {
    const reg = createRegistry();
    reg.counters["sentinelpr_queue_jobs_total"].add(1, { queue: "review", outcome: "completed" });
    reg.gauges["sentinelpr_queue_active_jobs"].set(2, { queue: "review" });
    reg.gauges["sentinelpr_worker_up"].set(1, { worker: "review-worker" });
    reg.histograms["sentinelpr_queue_job_duration_seconds"].observe(1.23, { queue: "review", outcome: "completed" });

    const body = renderExposition(reg, [
      { queue: "review", state: "waiting", value: 4 },
      { queue: "review", state: "delayed", value: 1 },
    ]);

    const lines = body.split("\n");
    expect(lines[lines.length - 1]).toBe(""); // file ends with newline

    // Counter with labels
    expect(body).toContain("# TYPE sentinelpr_queue_jobs_total counter");
    expect(body).toContain('sentinelpr_queue_jobs_total{outcome="completed",queue="review"} 1');

    // Depth gauge comes from live scrape series, with every state represented
    expect(body).toContain('sentinelpr_queue_depth{queue="review",state="waiting"} 4');
    expect(body).toContain('sentinelpr_queue_depth{queue="review",state="delayed"} 1');

    // Histogram: cumulative buckets, +Inf, sum, count
    expect(body).toContain("# TYPE sentinelpr_queue_job_duration_seconds histogram");
    expect(body).toContain('sentinelpr_queue_job_duration_seconds_bucket{outcome="completed",queue="review",le="1"} 0');
    expect(body).toContain('sentinelpr_queue_job_duration_seconds_bucket{outcome="completed",queue="review",le="+Inf"} 1');
    expect(body).toContain('sentinelpr_queue_job_duration_seconds_sum{outcome="completed",queue="review"} 1.23');
    expect(body).toContain('sentinelpr_queue_job_duration_seconds_count{outcome="completed",queue="review"} 1');

    // Up gauge
    expect(body).toContain('sentinelpr_worker_up{worker="review-worker"} 1');
  });

  it("emits a zero sample for untouched counters (Prometheus needs a series to exist)", () => {
    const reg = createRegistry();
    const body = renderExposition(reg, [{ queue: "review", state: "none", value: 0 }]);
    expect(body).toContain("sentinelpr_queue_jobs_total 0");
    expect(body).toContain('sentinelpr_queue_depth{queue="review",state="none"} 0');
  });

  it("escapes backslashes, quotes and newlines in label values", () => {
    const reg = createRegistry();
    reg.counters["sentinelpr_queue_jobs_total"].add(1, { outcome: 'a"b\\c\nd' });
    const body = renderExposition(reg, []);
    expect(body).toContain('outcome="a\\"b\\\\c\\nd"');
  });
});
