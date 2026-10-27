import { describe, it, expect, afterEach } from "vitest";
import { resolveMetricsPort, DEFAULT_METRICS_PORTS } from "./server";

describe("Worker Metrics Port Resolution & Collision Prevention", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("resolves unique non-colliding default ports for each worker process", () => {
    delete process.env.METRICS_PORT;
    delete process.env.REVIEW_WORKER_METRICS_PORT;
    delete process.env.VISUAL_WORKER_METRICS_PORT;
    delete process.env.SYNTHETIC_WORKER_METRICS_PORT;

    const reviewPort = resolveMetricsPort("review-worker");
    const visualPort = resolveMetricsPort("visual-worker");
    const syntheticPort = resolveMetricsPort("synthetic-worker");

    expect(reviewPort).toBe(9464);
    expect(visualPort).toBe(9465);
    expect(syntheticPort).toBe(9466);

    // All ports must be unique
    const uniquePorts = new Set([reviewPort, visualPort, syntheticPort]);
    expect(uniquePorts.size).toBe(3);
  });

  it("applies deterministic offsets when METRICS_PORT is set", () => {
    process.env.METRICS_PORT = "8000";

    const reviewPort = resolveMetricsPort("review-worker");
    const visualPort = resolveMetricsPort("visual-worker");
    const syntheticPort = resolveMetricsPort("synthetic-worker");

    expect(reviewPort).toBe(8000);
    expect(visualPort).toBe(8001);
    expect(syntheticPort).toBe(8002);

    const uniquePorts = new Set([reviewPort, visualPort, syntheticPort]);
    expect(uniquePorts.size).toBe(3);
  });

  it("prioritizes worker-specific environment variables over METRICS_PORT", () => {
    process.env.METRICS_PORT = "8000";
    process.env.VISUAL_WORKER_METRICS_PORT = "8088";

    const reviewPort = resolveMetricsPort("review-worker");
    const visualPort = resolveMetricsPort("visual-worker");

    expect(reviewPort).toBe(8000);
    expect(visualPort).toBe(8088);
  });

  it("prioritizes explicitly passed port", () => {
    const explicitPort = 9999;
    const resolved = resolveMetricsPort("review-worker", explicitPort);
    expect(resolved).toBe(9999);
  });
});
