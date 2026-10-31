import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/db";
import { getStorage } from "@/lib/storage";

const log = logger.child({ module: "retention" });
const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_DELETE_BACKOFF_MS = 24 * 60 * 60 * 1_000;

type IdRow = { id: string };
type RetentionOptions = { now?: Date; dryRun?: boolean; batchSize?: number };

export interface RetentionReport {
  skipped: boolean;
  dryRun: boolean;
  expiredSessions: number;
  reviewRuns: number;
  visualRuns: number;
  syntheticRuns: number;
  jobRecords: number;
  webhookDeliveries: number;
  dispatchedReviewOutbox: number;
  auditLogs: number;
  artifactMetadataQueued: number;
  artifactMetadataSkipped: number;
  artifactObjectsDeleted: number;
  artifactObjectRetries: number;
}

function cutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

function emptyReport(dryRun: boolean, skipped: boolean): RetentionReport {
  return {
    skipped, dryRun, expiredSessions: 0, reviewRuns: 0, visualRuns: 0,
    syntheticRuns: 0, jobRecords: 0, webhookDeliveries: 0,
    dispatchedReviewOutbox: 0, auditLogs: 0, artifactMetadataQueued: 0,
    artifactMetadataSkipped: 0, artifactObjectsDeleted: 0, artifactObjectRetries: 0,
  };
}

async function deleteOneBatch(
  ids: () => Promise<IdRow[]>,
  remove: (values: string[]) => Promise<{ count: number }>,
): Promise<number> {
  const rows = await ids();
  if (rows.length === 0) return 0;
  return (await remove(rows.map((row) => row.id))).count;
}

async function countArtifactCandidates(olderThan: Date): Promise<number> {
  return prisma.artifact.count({
    where: {
      createdAt: { lt: olderThan },
      visualBaselines: { none: {} },
      currentSnapshots: { none: {} },
      diffSnapshots: { none: {} },
      syntheticStepResults: { none: {} },
    },
  });
}

async function pruneArtifactMetadata(olderThan: Date, now: Date, batchSize: number, report: RetentionReport): Promise<void> {
  const candidates = await prisma.artifact.findMany({
    where: {
      createdAt: { lt: olderThan },
      visualBaselines: { none: {} },
      currentSnapshots: { none: {} },
      diffSnapshots: { none: {} },
      syntheticStepResults: { none: {} },
    },
    select: { id: true, storageKey: true },
    orderBy: { createdAt: "asc" },
    take: batchSize,
  });

  for (const artifact of candidates) {
    try {
      const removed = await prisma.$transaction(async (tx) => {
        // Recheck every reference while deleting. The required baseline FK is also
        // RESTRICT, so a concurrent approval cannot orphan a live baseline.
        const result = await tx.artifact.deleteMany({
          where: {
            id: artifact.id,
            createdAt: { lt: olderThan },
            visualBaselines: { none: {} },
            currentSnapshots: { none: {} },
            diffSnapshots: { none: {} },
            syntheticStepResults: { none: {} },
          },
        });
        if (result.count !== 1) return false;
        await tx.artifactDeletion.create({ data: { storageKey: artifact.storageKey, nextAttemptAt: now } });
        return true;
      });
      if (removed) report.artifactMetadataQueued += 1;
    } catch (error) {
      // A newly attached reference or transient DB error must preserve the blob.
      report.artifactMetadataSkipped += 1;
      log.warn("Artifact metadata retention skipped", {
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
}

async function processArtifactDeletionOutbox(now: Date, batchSize: number, report: RetentionReport): Promise<void> {
  const pending = await prisma.artifactDeletion.findMany({
    where: { nextAttemptAt: { lte: now } },
    orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
    take: batchSize,
    select: { id: true, storageKey: true, attemptCount: true },
  });

  for (const item of pending) {
    try {
      await getStorage().delete(item.storageKey);
      await prisma.artifactDeletion.deleteMany({ where: { id: item.id } });
      report.artifactObjectsDeleted += 1;
    } catch (error) {
      const nextAttempt = item.attemptCount + 1;
      const delay = Math.min(MAX_DELETE_BACKOFF_MS, 60_000 * 2 ** Math.min(nextAttempt, 10));
      await prisma.artifactDeletion.updateMany({
        where: { id: item.id },
        data: {
          attemptCount: { increment: 1 },
          nextAttemptAt: new Date(now.getTime() + delay),
          lastError: error instanceof Error ? error.name.slice(0, 100) : "UnknownError",
        },
      });
      report.artifactObjectRetries += 1;
      log.warn("Artifact object deletion will retry", {
        errorType: error instanceof Error ? error.name : "UnknownError",
        attempt: nextAttempt,
      });
    }
  }
}

/**
 * Prune one bounded page per data class. Disabled by default; callers must set
 * RETENTION_ENABLED=1. Dry-run reports eligible counts without changing rows or
 * objects. Baselines and all artifact references are excluded from blob cleanup.
 */
export async function runRetention(options: RetentionOptions = {}): Promise<RetentionReport> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? env.retention.dryRun;
  const report = emptyReport(dryRun, !env.retention.enabled);
  if (report.skipped) return report;

  const batchSize = options.batchSize ?? env.retention.batchSize;
  const reviewCutoff = cutoff(now, env.retention.reviewRunDays);
  const visualCutoff = cutoff(now, env.retention.visualRunDays);
  const syntheticCutoff = cutoff(now, env.retention.syntheticRunDays);
  const jobCutoff = cutoff(now, env.retention.jobRecordDays);
  const webhookCutoff = cutoff(now, env.retention.webhookDeliveryDays);
  const artifactCutoff = cutoff(now, env.retention.artifactDays);
  const outboxCutoff = cutoff(now, env.retention.reviewOutboxDays);

  if (dryRun) {
    report.expiredSessions = await prisma.session.count({ where: { expiresAt: { lte: now } } });
    report.reviewRuns = await prisma.reviewRun.count({ where: { status: { in: ["success", "failure", "error"] }, createdAt: { lt: reviewCutoff } } });
    report.visualRuns = await prisma.visualRun.count({ where: { status: { in: ["passed", "failed", "error"] }, createdAt: { lt: visualCutoff } } });
    report.syntheticRuns = await prisma.syntheticRun.count({ where: { status: { in: ["passed", "failed", "error"] }, createdAt: { lt: syntheticCutoff } } });
    report.jobRecords = await prisma.jobRecord.count({ where: { status: { in: ["completed", "failed"] }, finishedAt: { lt: jobCutoff } } });
    report.webhookDeliveries = await prisma.webhookDelivery.count({ where: { status: { in: ["processed", "skipped", "failed"] }, createdAt: { lt: webhookCutoff } } });
    report.dispatchedReviewOutbox = await prisma.reviewRunOutbox.count({ where: { status: "dispatched", dispatchedAt: { lt: outboxCutoff } } });
    report.auditLogs = env.retention.auditLogDays > 0
      ? await prisma.auditLog.count({ where: { createdAt: { lt: cutoff(now, env.retention.auditLogDays) } } })
      : 0;
    report.artifactMetadataQueued = await countArtifactCandidates(artifactCutoff);
    report.artifactObjectsDeleted = await prisma.artifactDeletion.count({ where: { nextAttemptAt: { lte: now } } });
    return report;
  }

  report.expiredSessions = await deleteOneBatch(
    () => prisma.session.findMany({ where: { expiresAt: { lte: now } }, select: { id: true }, orderBy: { expiresAt: "asc" }, take: batchSize }),
    (ids) => prisma.session.deleteMany({ where: { id: { in: ids }, expiresAt: { lte: now } } }),
  );
  report.reviewRuns = await deleteOneBatch(
    () => prisma.reviewRun.findMany({ where: { status: { in: ["success", "failure", "error"] }, createdAt: { lt: reviewCutoff } }, select: { id: true }, orderBy: { createdAt: "asc" }, take: batchSize }),
    (ids) => prisma.reviewRun.deleteMany({ where: { id: { in: ids }, status: { in: ["success", "failure", "error"] }, createdAt: { lt: reviewCutoff } } }),
  );
  report.visualRuns = await deleteOneBatch(
    () => prisma.visualRun.findMany({ where: { status: { in: ["passed", "failed", "error"] }, createdAt: { lt: visualCutoff } }, select: { id: true }, orderBy: { createdAt: "asc" }, take: batchSize }),
    (ids) => prisma.visualRun.deleteMany({ where: { id: { in: ids }, status: { in: ["passed", "failed", "error"] }, createdAt: { lt: visualCutoff } } }),
  );
  report.syntheticRuns = await deleteOneBatch(
    () => prisma.syntheticRun.findMany({ where: { status: { in: ["passed", "failed", "error"] }, createdAt: { lt: syntheticCutoff } }, select: { id: true }, orderBy: { createdAt: "asc" }, take: batchSize }),
    (ids) => prisma.syntheticRun.deleteMany({ where: { id: { in: ids }, status: { in: ["passed", "failed", "error"] }, createdAt: { lt: syntheticCutoff } } }),
  );
  report.jobRecords = await deleteOneBatch(
    () => prisma.jobRecord.findMany({ where: { status: { in: ["completed", "failed"] }, finishedAt: { lt: jobCutoff } }, select: { id: true }, orderBy: { finishedAt: "asc" }, take: batchSize }),
    (ids) => prisma.jobRecord.deleteMany({ where: { id: { in: ids }, status: { in: ["completed", "failed"] }, finishedAt: { lt: jobCutoff } } }),
  );
  report.webhookDeliveries = await deleteOneBatch(
    () => prisma.webhookDelivery.findMany({ where: { status: { in: ["processed", "skipped", "failed"] }, createdAt: { lt: webhookCutoff } }, select: { id: true }, orderBy: { createdAt: "asc" }, take: batchSize }),
    (ids) => prisma.webhookDelivery.deleteMany({ where: { id: { in: ids }, status: { in: ["processed", "skipped", "failed"] }, createdAt: { lt: webhookCutoff } } }),
  );
  report.dispatchedReviewOutbox = await deleteOneBatch(
    () => prisma.reviewRunOutbox.findMany({ where: { status: "dispatched", dispatchedAt: { lt: outboxCutoff } }, select: { id: true }, orderBy: { dispatchedAt: "asc" }, take: batchSize }),
    (ids) => prisma.reviewRunOutbox.deleteMany({ where: { id: { in: ids }, status: "dispatched", dispatchedAt: { lt: outboxCutoff } } }),
  );
  if (env.retention.auditLogDays > 0) {
    const auditCutoff = cutoff(now, env.retention.auditLogDays);
    report.auditLogs = await deleteOneBatch(
      () => prisma.auditLog.findMany({ where: { createdAt: { lt: auditCutoff } }, select: { id: true }, orderBy: { createdAt: "asc" }, take: batchSize }),
      (ids) => prisma.auditLog.deleteMany({ where: { id: { in: ids }, createdAt: { lt: auditCutoff } } }),
    );
  }

  await pruneArtifactMetadata(artifactCutoff, now, batchSize, report);
  await processArtifactDeletionOutbox(now, batchSize, report);
  return report;
}
