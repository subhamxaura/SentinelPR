import type { ReviewRun } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

export function reviewRunIdentity(pullRequestId: string, headSha: string): string {
  return `${pullRequestId}:${headSha}`;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: string }).code === "P2002";
}

/**
 * Create exactly one logical review run for a pull-request commit, with durable
 * dispatch intent committed in the same transaction. The unique database key
 * is authoritative; the outbox repairs crashes between persistence and Redis.
 */
export async function ensureReviewRun(input: {
  pullRequestId: string;
  repositoryId: string;
  headSha: string;
  trigger: "webhook" | "manual";
}): Promise<{ run: ReviewRun; created: boolean; shouldEnqueue: boolean }> {
  const idempotencyKey = reviewRunIdentity(input.pullRequestId, input.headSha);

  try {
    const run = await prisma.$transaction(async (tx) => {
      const created = await tx.reviewRun.create({
        data: { ...input, idempotencyKey, status: "queued" },
      });
      await tx.reviewRunOutbox.create({ data: { reviewRunId: created.id } });
      return created;
    });
    return { run, created: true, shouldEnqueue: true };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }

  return prisma.$transaction(async (tx) => {
    let run = await tx.reviewRun.findUnique({ where: { idempotencyKey } });
    if (!run) throw new Error(`Review run with idempotency key ${idempotencyKey} was not found after a unique-key conflict`);

    let recoveredError = false;
    if (run.status === "error") {
      const reclaimed = await tx.reviewRun.updateMany({
        where: { id: run.id, status: "error" },
        data: {
          status: "queued",
          error: null,
          completedAt: null,
          startedAt: null,
          queuedAt: new Date(),
          trigger: input.trigger,
        },
      });
      recoveredError = reclaimed.count > 0;
      run = await tx.reviewRun.findUnique({ where: { id: run.id } }) ?? run;
    }

    if (run.status === "queued") {
      await tx.reviewRunOutbox.upsert({
        where: { reviewRunId: run.id },
        update: recoveredError
          ? {
              status: "pending",
              attemptCount: 0,
              nextAttemptAt: new Date(),
              leaseUntil: null,
              leaseToken: null,
              lastError: null,
              dispatchedAt: null,
            }
          : {},
        create: { reviewRunId: run.id },
      });
      return { run, created: false, shouldEnqueue: true };
    }
    return { run, created: false, shouldEnqueue: false };
  });
}
