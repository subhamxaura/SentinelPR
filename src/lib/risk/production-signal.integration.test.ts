import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { productionSignal } from "@/lib/review/pipeline";

const enabled = process.env.RUN_DB_INTEGRATION === "1" && !!process.env.DATABASE_URL;

describe.skipIf(!enabled)("production risk aggregates (PostgreSQL integration)", () => {
  let organizationId = "";
  const suffix = randomUUID();
  const measuredTestName = `Measured monitor ${suffix}`;
  const underSampledTestName = `Under-sampled monitor ${suffix}`;

  beforeAll(async () => {
    const organization = await prisma.organization.create({
      data: { name: `Production metrics ${suffix}`, slug: `production-metrics-${suffix}` },
    });
    organizationId = organization.id;

    const measured = await prisma.syntheticTest.create({
      data: {
        organizationId,
        name: measuredTestName,
        baseUrl: "https://example.test",
        steps: [],
        alertLatencyMs: 500,
      },
    });
    const underSampled = await prisma.syntheticTest.create({
      data: {
        organizationId,
        name: underSampledTestName,
        baseUrl: "https://example.test",
        steps: [],
        alertLatencyMs: 500,
      },
    });

    const baseTime = Date.now() - 60_000;
    for (const [index, durationMs] of [100, 200, 300, 400, 600].entries()) {
      await prisma.syntheticRun.create({
        data: {
          testId: measured.id,
          status: "passed",
          durationMs,
          createdAt: new Date(baseTime + index * 1_000),
        },
      });
    }
    await prisma.syntheticRun.create({
      data: { testId: measured.id, status: "failed", createdAt: new Date(baseTime + 10_000) },
    });
    for (const [index, durationMs] of [1_000, 1_100, 1_200, 1_300].entries()) {
      await prisma.syntheticRun.create({
        data: {
          testId: underSampled.id,
          status: "passed",
          durationMs,
          createdAt: new Date(baseTime + index * 1_000),
        },
      });
    }
  });

  afterAll(async () => {
    if (organizationId) await prisma.organization.delete({ where: { id: organizationId } });
  });

  it("keeps monitor samples separate and qualifies only adequately sampled P95 breaches", async () => {
    const signal = await productionSignal(organizationId);

    expect(signal?.availability).toBeCloseTo(0.9);
    expect(signal?.consecutiveFailures).toBe(1);
    expect(signal?.latencyBreaches).toEqual([
      expect.objectContaining({
        testName: measuredTestName,
        p95Ms: 560,
        thresholdMs: 500,
        sampleCount: 5,
      }),
    ]);
    expect(signal?.latencyBreaches?.some((breach) => breach.testName === underSampledTestName)).toBe(false);
  });
});
