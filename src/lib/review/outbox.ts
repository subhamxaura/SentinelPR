import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { err } from "@/lib/errors";
import { enqueueReviewRun } from "@/lib/queue";
import { logger } from "@/lib/logger";

const log = logger.child({ module: "review-outbox" });
const LEASE_MS = 30_000;
const MAX_BACKOFF_MS = 5 * 60_000;

function retryDelay(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 8));
}

async function dispatchOne(reviewRunId: string): Promise<boolean> {
  const now = new Date();
  const leaseToken = randomUUID();
  const leaseUntil = new Date(now.getTime() + LEASE_MS);
  const existing = await prisma.reviewRunOutbox.findUnique({
    where: { reviewRunId },
    select: { attemptCount: true },
  });
  if (!existing) return false;
  const attempt = existing.attemptCount + 1;
  const claimed = await prisma.reviewRunOutbox.updateMany({
    where: {
      reviewRunId,
      OR: [
        { status: "pending", nextAttemptAt: { lte: now } },
        { status: "dispatching", leaseUntil: { lte: now } },
      ],
    },
    data: {
      status: "dispatching",
      leaseUntil,
      leaseToken,
      attemptCount: { increment: 1 },
    },
  });
  if (claimed.count !== 1) return false;

  try {
    await enqueueReviewRun(reviewRunId);
    await prisma.reviewRunOutbox.updateMany({
      where: { reviewRunId, status: "dispatching", leaseToken },
      data: {
        status: "dispatched",
        dispatchedAt: new Date(),
        leaseUntil: null,
        leaseToken: null,
        lastError: null,
      },
    });
    return true;
  } catch (error) {
    const errorName = error instanceof Error ? error.name.slice(0, 100) : "UnknownError";
    await prisma.reviewRunOutbox.updateMany({
      where: { reviewRunId, status: "dispatching", leaseToken },
      data: {
        status: "pending",
        nextAttemptAt: new Date(Date.now() + retryDelay(attempt)),
        leaseUntil: null,
        leaseToken: null,
        lastError: `Queue dispatch failed (${errorName})`,
      },
    }).catch(() => undefined);
    log.warn("Review outbox dispatch failed; the run remains queued for retry", { reviewRunId, errorName });
    throw err.infra("Review dispatch is temporarily unavailable; the run remains queued for retry.", "QUEUE_UNAVAILABLE");
  }
}

/** Best-effort immediate dispatch used by API requests after the DB commit. */
export async function dispatchReviewRunOutbox(reviewRunId: string): Promise<void> {
  await dispatchOne(reviewRunId);
}

/** Reconcile pending/expired dispatch leases; safe to run from every review worker. */
export async function dispatchPendingReviewOutbox(limit = 50): Promise<number> {
  const now = new Date();
  const entries = await prisma.reviewRunOutbox.findMany({
    where: {
      OR: [
        { status: "pending", nextAttemptAt: { lte: now } },
        { status: "dispatching", leaseUntil: { lte: now } },
      ],
    },
    select: { reviewRunId: true },
    orderBy: { createdAt: "asc" },
    take: Math.min(Math.max(Math.trunc(limit), 1), 200),
  });
  let dispatched = 0;
  for (const entry of entries) {
    try {
      if (await dispatchOne(entry.reviewRunId)) dispatched++;
    } catch (error) {
      log.warn("Review outbox dispatch failed; it will retry", {
        reviewRunId: entry.reviewRunId,
        error: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
  return dispatched;
}

export function reviewOutboxRetryDelay(attempt: number): number {
  return retryDelay(attempt);
}
