-- Retention lookup indexes keep cleanup bounded as history grows.
CREATE INDEX "ReviewRun_status_createdAt_idx" ON "ReviewRun"("status", "createdAt");
CREATE INDEX "VisualRun_status_createdAt_idx" ON "VisualRun"("status", "createdAt");
CREATE INDEX "SyntheticRun_status_createdAt_idx" ON "SyntheticRun"("status", "createdAt");
CREATE INDEX "WebhookDelivery_status_createdAt_idx" ON "WebhookDelivery"("status", "createdAt");
CREATE INDEX "Artifact_createdAt_idx" ON "Artifact"("createdAt");
CREATE INDEX "JobRecord_status_finishedAt_idx" ON "JobRecord"("status", "finishedAt");

-- Metadata deletion and object-store deletion cannot be one distributed transaction.
-- This durable outbox is written atomically with the Artifact row deletion and retried
-- until storage confirms deletion. Storage keys are unique to make replay idempotent.
CREATE TABLE "ArtifactDeletion" (
  "id" TEXT NOT NULL,
  "storageKey" TEXT NOT NULL,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ArtifactDeletion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ArtifactDeletion_storageKey_key" ON "ArtifactDeletion"("storageKey");
CREATE INDEX "ArtifactDeletion_nextAttemptAt_createdAt_idx" ON "ArtifactDeletion"("nextAttemptAt", "createdAt");
