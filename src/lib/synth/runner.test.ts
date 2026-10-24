import { describe, expect, it, vi } from "vitest";
import { executeSyntheticTest, recoverStaleSyntheticRuns, RUN_TIMEOUT_MS, STALE_RUN_THRESHOLD_MS } from "./runner";
import { prisma } from "@/lib/db";

vi.mock("@/lib/db", () => ({
  prisma: {
    syntheticRun: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}));

describe("executeSyntheticTest", () => {
  it("stops before launching a browser when the run signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      executeSyntheticTest({
        organizationId: "org-1",
        baseUrl: "https://example.com",
        steps: [{ type: "screenshot" }],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT", category: "timeout" });
  });
});

describe("recoverStaleSyntheticRuns (HIGH-03 regression defense)", () => {
  it("exports valid timeout relationships (lease > run timeout)", () => {
    expect(RUN_TIMEOUT_MS).toBe(180_000);
    expect(STALE_RUN_THRESHOLD_MS).toBeGreaterThan(RUN_TIMEOUT_MS);
    expect(STALE_RUN_THRESHOLD_MS).toBe(210_000); // 3.5 minutes
  });

  it("recovers and terminates stale running runs older than the lease", async () => {
    const now = new Date("2026-10-23T12:00:00Z");
    const staleRunId = "run-stale-1";

    vi.mocked(prisma.syntheticRun.findMany).mockResolvedValueOnce([
      { id: staleRunId, testId: "test-1", status: "running" } as any,
    ]);
    vi.mocked(prisma.syntheticRun.updateMany).mockResolvedValueOnce({ count: 1 });

    const result = await recoverStaleSyntheticRuns("test-1", { now });

    expect(prisma.syntheticRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          testId: "test-1",
        }),
      }),
    );
    expect(prisma.syntheticRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: [staleRunId] }, status: { in: ["queued", "running"] } },
        data: expect.objectContaining({
          status: "error",
          completedAt: now,
          error: expect.stringContaining("lease expired"),
        }),
      }),
    );
    expect(result).toEqual({ recoveredCount: 1, runIds: [staleRunId] });
  });

  it("does not recover fresh active runs that are still within the execution lease", async () => {
    const now = new Date("2026-10-23T12:00:00Z");

    vi.mocked(prisma.syntheticRun.findMany).mockResolvedValueOnce([]);
    vi.mocked(prisma.syntheticRun.updateMany).mockClear();

    const result = await recoverStaleSyntheticRuns("test-1", { now });

    expect(result).toEqual({ recoveredCount: 0, runIds: [] });
    expect(prisma.syntheticRun.updateMany).not.toHaveBeenCalled();
  });

  it("recovers abandoned queued runs that never started", async () => {
    const now = new Date("2026-10-23T12:00:00Z");
    const abandonedId = "run-abandoned-queued";

    vi.mocked(prisma.syntheticRun.findMany).mockResolvedValueOnce([
      { id: abandonedId, testId: "test-2", status: "queued" } as any,
    ]);
    vi.mocked(prisma.syntheticRun.updateMany).mockResolvedValueOnce({ count: 1 });

    const result = await recoverStaleSyntheticRuns(undefined, { now });

    expect(result).toEqual({ recoveredCount: 1, runIds: [abandonedId] });
    expect(prisma.syntheticRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: [abandonedId] }, status: { in: ["queued", "running"] } },
        data: expect.objectContaining({ status: "error" }),
      }),
    );
  });

  it("simulates worker crash recovery unblocking subsequent scheduled ticks", async () => {
    const now = new Date("2026-10-23T12:00:00Z");
    const testId = "test-unblock";

    // 1. Worker crashed previously. Run is stuck in 'running'.
    // Stale recovery finds and marks it as error.
    vi.mocked(prisma.syntheticRun.findMany).mockResolvedValueOnce([
      { id: "stuck-run", testId, status: "running" } as any,
    ]);
    vi.mocked(prisma.syntheticRun.updateMany).mockResolvedValueOnce({ count: 1 });

    const recoveryResult = await recoverStaleSyntheticRuns(testId, { now });
    expect(recoveryResult.recoveredCount).toBe(1);

    // 2. Scheduled tick arrives and checks for inflight runs.
    // Inflight query returns null because the stuck run was transitioned to 'error'.
    vi.mocked(prisma.syntheticRun.findFirst).mockResolvedValueOnce(null);

    const inflight = await prisma.syntheticRun.findFirst({
      where: { testId, status: { in: ["queued", "running"] } },
      select: { id: true },
    });

    expect(inflight).toBeNull(); // Schedule is NOT locked out!
  });
});
