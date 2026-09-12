import { describe, expect, it } from "vitest";
import { computeMetrics, percentile } from "./metrics";

describe("percentile", () => {
  it("handles empty input", () => {
    expect(percentile([], 95)).toBeNull();
  });

  it("interpolates between order statistics", () => {
    expect(percentile([100, 200, 300, 400], 50)).toBe(250);
    expect(percentile([100, 200, 300, 400], 95)).toBeCloseTo(385, 0);
    expect(percentile([42], 99)).toBe(42);
  });
});

describe("computeMetrics", () => {
  it("computes availability and consecutive failures (newest first)", () => {
    const runs = [
      { status: "failed", durationMs: 1000 },
      { status: "failed", durationMs: 1100 },
      { status: "passed", durationMs: 500 },
      { status: "passed", durationMs: 600 },
    ];
    const m = computeMetrics(runs);
    expect(m.total).toBe(4);
    expect(m.passed).toBe(2);
    expect(m.availability).toBe(0.5);
    expect(m.consecutiveFailures).toBe(2);
    expect(m.p50Ms).toBe(550);
  });

  it("counts durations only from passing runs", () => {
    const m = computeMetrics([
      { status: "failed", durationMs: 99999 },
      { status: "passed", durationMs: 100 },
    ]);
    expect(m.p95Ms).toBe(100);
    expect(m.avgMs).toBe(100);
  });

  it("reports zero consecutive failures when the newest run passed", () => {
    const m = computeMetrics([
      { status: "passed", durationMs: 100 },
      { status: "failed", durationMs: 100 },
    ]);
    expect(m.consecutiveFailures).toBe(0);
  });
});
