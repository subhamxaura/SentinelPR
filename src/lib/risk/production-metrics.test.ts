import { describe, expect, it } from "vitest";
import { qualifyLatencyBreaches } from "./production-metrics";

const checkout = { testId: "test-a", testName: "Checkout", p95Ms: 250, thresholdMs: 100, sampleCount: 10 };

describe("qualifyLatencyBreaches", () => {
  it("reports measured P95 against each monitor's own threshold", () => {
    expect(qualifyLatencyBreaches([
      checkout,
      { testId: "test-b", testName: "Search", p95Ms: 400, thresholdMs: 500, sampleCount: 20 },
    ])).toEqual([checkout]);
  });

  it("does not flag a noisy percentile with fewer than five successful samples", () => {
    expect(qualifyLatencyBreaches([{ ...checkout, sampleCount: 4 }])).toEqual([]);
  });

  it("ignores invalid thresholds and non-finite database values", () => {
    expect(qualifyLatencyBreaches([
      { ...checkout, p95Ms: Number.NaN },
      { ...checkout, thresholdMs: 0 },
    ])).toEqual([]);
  });
});
