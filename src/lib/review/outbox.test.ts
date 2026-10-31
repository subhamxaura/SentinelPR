import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  updateMany: vi.fn(),
  enqueueReviewRun: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  prisma: { reviewRunOutbox: { findUnique: mocks.findUnique, findMany: mocks.findMany, updateMany: mocks.updateMany } },
}));
vi.mock("@/lib/queue", () => ({ enqueueReviewRun: mocks.enqueueReviewRun }));

import { dispatchReviewRunOutbox } from "./outbox";

describe("review dispatch outbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue({ attemptCount: 0 });
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.enqueueReviewRun.mockResolvedValue("review-run-1");
  });

  it("claims a lease, enqueues once, then marks the intent dispatched", async () => {
    await dispatchReviewRunOutbox("run-1");

    expect(mocks.updateMany).toHaveBeenCalledTimes(2);
    expect(mocks.updateMany.mock.calls[0][0].data).toEqual(expect.objectContaining({
      status: "dispatching",
      attemptCount: { increment: 1 },
    }));
    expect(mocks.enqueueReviewRun).toHaveBeenCalledWith("run-1");
    expect(mocks.updateMany.mock.calls[1][0]).toEqual(expect.objectContaining({
      where: expect.objectContaining({ reviewRunId: "run-1", status: "dispatching" }),
      data: expect.objectContaining({ status: "dispatched", leaseToken: null }),
    }));
  });

  it("does not dispatch when another worker already owns the lease", async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 0 });

    await dispatchReviewRunOutbox("run-1");

    expect(mocks.enqueueReviewRun).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
  });

  it("records a bounded retry time and error when queue dispatch fails", async () => {
    mocks.enqueueReviewRun.mockRejectedValue(new Error("redis unavailable"));
    const before = Date.now();

    await expect(dispatchReviewRunOutbox("run-1")).rejects.toThrow(/temporarily unavailable/);

    const failureUpdate = mocks.updateMany.mock.calls[1][0];
    expect(failureUpdate.data).toEqual(expect.objectContaining({
      status: "pending",
      leaseToken: null,
      lastError: "Queue dispatch failed (Error)",
    }));
    expect(failureUpdate.data.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 900);
    expect(failureUpdate.data.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now() + 1_100);
  });
});
