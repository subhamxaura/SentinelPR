-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationMember" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GithubInstallation" (
    "id" TEXT NOT NULL,
    "installationId" INTEGER NOT NULL,
    "organizationId" TEXT,
    "accountLogin" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GithubInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Repository" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "installationId" TEXT,
    "githubId" INTEGER NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "private" BOOLEAN NOT NULL DEFAULT false,
    "defaultBranch" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Repository_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PullRequest" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "githubId" INTEGER,
    "title" TEXT NOT NULL,
    "authorLogin" TEXT,
    "authorAvatar" TEXT,
    "state" TEXT NOT NULL DEFAULT 'open',
    "baseRef" TEXT,
    "headRef" TEXT,
    "headSha" TEXT NOT NULL,
    "url" TEXT,
    "additions" INTEGER,
    "deletions" INTEGER,
    "changedFiles" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PullRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewRun" (
    "id" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "trigger" TEXT NOT NULL DEFAULT 'webhook',
    "conclusion" TEXT,
    "riskLevel" TEXT,
    "riskScore" INTEGER,
    "riskSummary" JSONB,
    "summary" TEXT,
    "stats" JSONB,
    "checkRunId" TEXT,
    "error" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewFinding" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "ruleId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'rule',
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "kind" TEXT NOT NULL DEFAULT 'finding',
    "file" TEXT NOT NULL,
    "startLine" INTEGER,
    "endLine" INTEGER,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "evidence" TEXT,
    "suggestion" TEXT,
    "dedupKey" TEXT NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisualSuite" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "repositoryId" TEXT,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "readinessPath" TEXT NOT NULL DEFAULT '/',
    "readinessTimeoutMs" INTEGER NOT NULL DEFAULT 30000,
    "env" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VisualSuite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisualTest" (
    "id" TEXT NOT NULL,
    "suiteId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL DEFAULT '/',
    "browsers" JSONB NOT NULL DEFAULT '["chromium"]',
    "viewports" JSONB NOT NULL DEFAULT '[{"label":"desktop","width":1280,"height":720}]',
    "fullPage" BOOLEAN NOT NULL DEFAULT false,
    "threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VisualTest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisualRun" (
    "id" TEXT NOT NULL,
    "suiteId" TEXT NOT NULL,
    "testId" TEXT,
    "pullRequestId" TEXT,
    "commitSha" TEXT,
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "diffRatio" DOUBLE PRECISION,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisualRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisualSnapshot" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "browser" TEXT NOT NULL,
    "viewportLabel" TEXT NOT NULL,
    "viewport" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "diffRatio" DOUBLE PRECISION,
    "currentArtifactId" TEXT,
    "diffArtifactId" TEXT,
    "baselineId" TEXT,
    "changedRegions" JSONB,
    "domChanges" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisualSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisualBaseline" (
    "id" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "browser" TEXT NOT NULL,
    "viewportLabel" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "commitSha" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisualBaseline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyntheticTest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "alertLatencyMs" INTEGER,
    "maxConsecutiveFailures" INTEGER NOT NULL DEFAULT 3,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyntheticTest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyntheticSchedule" (
    "id" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "lastEnqueuedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyntheticSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyntheticRun" (
    "id" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'schedule',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "durationMs" INTEGER,
    "failedStepIndex" INTEGER,
    "error" TEXT,
    "browser" TEXT NOT NULL DEFAULT 'chromium',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyntheticRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyntheticStepResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT,
    "status" TEXT NOT NULL,
    "durationMs" INTEGER,
    "error" TEXT,
    "screenshotArtifactId" TEXT,

    CONSTRAINT "SyntheticStepResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "action" TEXT,
    "repositoryFullName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'received',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRecord" (
    "id" TEXT NOT NULL,
    "queue" TEXT NOT NULL,
    "jobId" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "refType" TEXT,
    "refId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "JobRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "dedupKey" TEXT,
    "channels" JSONB NOT NULL DEFAULT '["in_app"]',
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "OrganizationMember_userId_idx" ON "OrganizationMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMember_organizationId_userId_key" ON "OrganizationMember"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "GithubInstallation_installationId_key" ON "GithubInstallation"("installationId");

-- CreateIndex
CREATE INDEX "GithubInstallation_organizationId_idx" ON "GithubInstallation"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Repository_githubId_key" ON "Repository"("githubId");

-- CreateIndex
CREATE INDEX "Repository_fullName_idx" ON "Repository"("fullName");

-- CreateIndex
CREATE UNIQUE INDEX "Repository_organizationId_fullName_key" ON "Repository"("organizationId", "fullName");

-- CreateIndex
CREATE INDEX "PullRequest_repositoryId_state_updatedAt_idx" ON "PullRequest"("repositoryId", "state", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PullRequest_repositoryId_number_key" ON "PullRequest"("repositoryId", "number");

-- CreateIndex
CREATE INDEX "ReviewRun_repositoryId_createdAt_idx" ON "ReviewRun"("repositoryId", "createdAt");

-- CreateIndex
CREATE INDEX "ReviewRun_pullRequestId_headSha_idx" ON "ReviewRun"("pullRequestId", "headSha");

-- CreateIndex
CREATE INDEX "ReviewRun_status_idx" ON "ReviewRun"("status");

-- CreateIndex
CREATE INDEX "ReviewFinding_repositoryId_severity_createdAt_idx" ON "ReviewFinding"("repositoryId", "severity", "createdAt");

-- CreateIndex
CREATE INDEX "ReviewFinding_runId_idx" ON "ReviewFinding"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewFinding_runId_dedupKey_key" ON "ReviewFinding"("runId", "dedupKey");

-- CreateIndex
CREATE INDEX "VisualSuite_organizationId_idx" ON "VisualSuite"("organizationId");

-- CreateIndex
CREATE INDEX "VisualTest_suiteId_idx" ON "VisualTest"("suiteId");

-- CreateIndex
CREATE INDEX "VisualRun_suiteId_createdAt_idx" ON "VisualRun"("suiteId", "createdAt");

-- CreateIndex
CREATE INDEX "VisualRun_testId_createdAt_idx" ON "VisualRun"("testId", "createdAt");

-- CreateIndex
CREATE INDEX "VisualSnapshot_runId_idx" ON "VisualSnapshot"("runId");

-- CreateIndex
CREATE INDEX "VisualSnapshot_testId_createdAt_idx" ON "VisualSnapshot"("testId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "VisualBaseline_testId_browser_viewportLabel_key" ON "VisualBaseline"("testId", "browser", "viewportLabel");

-- CreateIndex
CREATE INDEX "SyntheticTest_organizationId_idx" ON "SyntheticTest"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "SyntheticSchedule_testId_key" ON "SyntheticSchedule"("testId");

-- CreateIndex
CREATE INDEX "SyntheticRun_testId_createdAt_idx" ON "SyntheticRun"("testId", "createdAt");

-- CreateIndex
CREATE INDEX "SyntheticRun_status_idx" ON "SyntheticRun"("status");

-- CreateIndex
CREATE INDEX "SyntheticStepResult_runId_idx" ON "SyntheticStepResult"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_deliveryId_key" ON "WebhookDelivery"("deliveryId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_createdAt_idx" ON "WebhookDelivery"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Artifact_storageKey_key" ON "Artifact"("storageKey");

-- CreateIndex
CREATE INDEX "JobRecord_queue_createdAt_idx" ON "JobRecord"("queue", "createdAt");

-- CreateIndex
CREATE INDEX "JobRecord_refId_idx" ON "JobRecord"("refId");

-- CreateIndex
CREATE INDEX "Alert_organizationId_status_createdAt_idx" ON "Alert"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Alert_organizationId_dedupKey_key" ON "Alert"("organizationId", "dedupKey");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_createdAt_idx" ON "AuditLog"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GithubInstallation" ADD CONSTRAINT "GithubInstallation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Repository" ADD CONSTRAINT "Repository_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Repository" ADD CONSTRAINT "Repository_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "GithubInstallation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PullRequest" ADD CONSTRAINT "PullRequest_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRun" ADD CONSTRAINT "ReviewRun_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRun" ADD CONSTRAINT "ReviewRun_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewFinding" ADD CONSTRAINT "ReviewFinding_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ReviewRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewFinding" ADD CONSTRAINT "ReviewFinding_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualSuite" ADD CONSTRAINT "VisualSuite_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualSuite" ADD CONSTRAINT "VisualSuite_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualTest" ADD CONSTRAINT "VisualTest_suiteId_fkey" FOREIGN KEY ("suiteId") REFERENCES "VisualSuite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualRun" ADD CONSTRAINT "VisualRun_suiteId_fkey" FOREIGN KEY ("suiteId") REFERENCES "VisualSuite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualRun" ADD CONSTRAINT "VisualRun_testId_fkey" FOREIGN KEY ("testId") REFERENCES "VisualTest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualRun" ADD CONSTRAINT "VisualRun_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualSnapshot" ADD CONSTRAINT "VisualSnapshot_runId_fkey" FOREIGN KEY ("runId") REFERENCES "VisualRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualSnapshot" ADD CONSTRAINT "VisualSnapshot_testId_fkey" FOREIGN KEY ("testId") REFERENCES "VisualTest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualSnapshot" ADD CONSTRAINT "VisualSnapshot_baselineId_fkey" FOREIGN KEY ("baselineId") REFERENCES "VisualBaseline"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualSnapshot" ADD CONSTRAINT "VisualSnapshot_currentArtifactId_fkey" FOREIGN KEY ("currentArtifactId") REFERENCES "Artifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualSnapshot" ADD CONSTRAINT "VisualSnapshot_diffArtifactId_fkey" FOREIGN KEY ("diffArtifactId") REFERENCES "Artifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualBaseline" ADD CONSTRAINT "VisualBaseline_testId_fkey" FOREIGN KEY ("testId") REFERENCES "VisualTest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualBaseline" ADD CONSTRAINT "VisualBaseline_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyntheticTest" ADD CONSTRAINT "SyntheticTest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyntheticSchedule" ADD CONSTRAINT "SyntheticSchedule_testId_fkey" FOREIGN KEY ("testId") REFERENCES "SyntheticTest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyntheticRun" ADD CONSTRAINT "SyntheticRun_testId_fkey" FOREIGN KEY ("testId") REFERENCES "SyntheticTest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyntheticStepResult" ADD CONSTRAINT "SyntheticStepResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SyntheticRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyntheticStepResult" ADD CONSTRAINT "SyntheticStepResult_screenshotArtifactId_fkey" FOREIGN KEY ("screenshotArtifactId") REFERENCES "Artifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

