import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  transaction: vi.fn(),
  outboxCreate: vi.fn(),
  outboxUpsert: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  prisma: { $transaction: mocks.transaction },
}));

import { ensureReviewRun, reviewRunIdentity } from "./runs";

const queuedRun = { id: "run-1", status: "queued" } as never;

describe("review run idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation((callback: (tx: unknown) => Promise<unknown>) => callback({
      reviewRun: { create: mocks.create, findUnique: mocks.findUnique, updateMany: mocks.updateMany },
      reviewRunOutbox: { create: mocks.outboxCreate, upsert: mocks.outboxUpsert },
    }));
    mocks.outboxCreate.mockResolvedValue({ id: "outbox-1" });
    mocks.outboxUpsert.mockResolvedValue({ id: "outbox-1" });
  });

  it("derives a stable key from the PR row and exact commit SHA", () => {
    expect(reviewRunIdentity("pr-row-1", "abc123")).toBe("pr-row-1:abc123");
  });

  it("creates and queues the first run", async () => {
    mocks.create.mockResolvedValue(queuedRun);
    const result = await ensureReviewRun({ pullRequestId: "pr-1", repositoryId: "repo-1", headSha: "abc", trigger: "webhook" });
    expect(result).toEqual({ run: queuedRun, created: true, shouldEnqueue: true });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ idempotencyKey: "pr-1:abc", status: "queued" }),
    }));
    expect(mocks.outboxCreate).toHaveBeenCalledWith({ data: { reviewRunId: "run-1" } });
  });

  it("resolves a concurrent unique-key collision to the existing queued run", async () => {
    mocks.create.mockRejectedValue({ code: "P2002" });
    mocks.findUnique.mockResolvedValue(queuedRun);
    const result = await ensureReviewRun({ pullRequestId: "pr-1", repositoryId: "repo-1", headSha: "abc", trigger: "manual" });
    expect(result).toEqual({ run: queuedRun, created: false, shouldEnqueue: true });
    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { idempotencyKey: "pr-1:abc" } });
  });

  it("atomically reclaims a queue-failed run and requests enqueue", async () => {
    const errored = { id: "run-1", status: "error" } as never;
    mocks.create.mockRejectedValue({ code: "P2002" });
    mocks.findUnique.mockResolvedValueOnce(errored).mockResolvedValueOnce(queuedRun);
    mocks.updateMany.mockResolvedValue({ count: 1 });
    const result = await ensureReviewRun({ pullRequestId: "pr-1", repositoryId: "repo-1", headSha: "abc", trigger: "webhook" });
    expect(result).toEqual({ run: queuedRun, created: false, shouldEnqueue: true });
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "run-1", status: "error" },
      data: expect.objectContaining({ status: "queued", error: null }),
    }));
    expect(mocks.outboxUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { reviewRunId: "run-1" },
      update: expect.objectContaining({ status: "pending", dispatchedAt: null }),
    }));
  });

  it("does not re-enqueue a completed run", async () => {
    const complete = { id: "run-1", status: "success" } as never;
    mocks.create.mockRejectedValue({ code: "P2002" });
    mocks.findUnique.mockResolvedValue(complete);
    const result = await ensureReviewRun({ pullRequestId: "pr-1", repositoryId: "repo-1", headSha: "abc", trigger: "webhook" });
    expect(result.shouldEnqueue).toBe(false);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});
