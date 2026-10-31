-- Immutable GitHub identity. Existing accounts are bound on their next OAuth sign-in.
ALTER TABLE "User" ADD COLUMN "githubId" TEXT;
CREATE UNIQUE INDEX "User_githubId_key" ON "User"("githubId");

-- A nullable unique key lets us keep every historical duplicate row while
-- assigning exactly one canonical review identity to each PR/head SHA pair.
ALTER TABLE "ReviewRun" ADD COLUMN "idempotencyKey" TEXT;
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "pullRequestId", "headSha"
      ORDER BY
        CASE "status"
          WHEN 'success' THEN 0
          WHEN 'failure' THEN 0
          WHEN 'error' THEN 0
          WHEN 'running' THEN 1
          WHEN 'queued' THEN 2
          ELSE 3
        END,
        "createdAt" ASC,
        "id" ASC
    ) AS position
  FROM "ReviewRun"
)
UPDATE "ReviewRun" AS run
SET "idempotencyKey" = run."pullRequestId" || ':' || run."headSha"
FROM ranked
WHERE ranked."id" = run."id" AND ranked.position = 1;
CREATE UNIQUE INDEX "ReviewRun_idempotencyKey_key" ON "ReviewRun"("idempotencyKey");

-- Convert one row per target into an immutable version history. Existing rows
-- become version 1; future approvals insert version N+1.
DROP INDEX "VisualBaseline_testId_browser_viewportLabel_key";
CREATE UNIQUE INDEX "VisualBaseline_testId_browser_viewportLabel_version_key"
  ON "VisualBaseline"("testId", "browser", "viewportLabel", "version");
CREATE INDEX "VisualBaseline_testId_browser_viewportLabel_active_idx"
  ON "VisualBaseline"("testId", "browser", "viewportLabel", "active");
-- Prisma does not model PostgreSQL partial indexes. This constraint enforces
-- the product invariant of at most one active baseline per target while
-- allowing unlimited inactive historical versions.
CREATE UNIQUE INDEX "VisualBaseline_one_active_per_target_key"
  ON "VisualBaseline"("testId", "browser", "viewportLabel")
  WHERE "active" = TRUE;
ALTER TABLE "VisualBaseline" DROP CONSTRAINT "VisualBaseline_artifactId_fkey";
ALTER TABLE "VisualBaseline" ADD CONSTRAINT "VisualBaseline_artifactId_fkey"
  FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Durable review dispatch intent. A worker can replay pending entries after an
-- API crash; deterministic BullMQ job IDs make add-before-mark retries safe.
CREATE TABLE "ReviewRunOutbox" (
  "id" TEXT NOT NULL,
  "reviewRunId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseUntil" TIMESTAMP(3),
  "leaseToken" TEXT,
  "lastError" TEXT,
  "dispatchedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReviewRunOutbox_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ReviewRunOutbox_reviewRunId_key" ON "ReviewRunOutbox"("reviewRunId");
CREATE INDEX "ReviewRunOutbox_status_nextAttemptAt_idx" ON "ReviewRunOutbox"("status", "nextAttemptAt");
CREATE INDEX "ReviewRunOutbox_status_leaseUntil_idx" ON "ReviewRunOutbox"("status", "leaseUntil");
ALTER TABLE "ReviewRunOutbox" ADD CONSTRAINT "ReviewRunOutbox_reviewRunId_fkey"
  FOREIGN KEY ("reviewRunId") REFERENCES "ReviewRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
