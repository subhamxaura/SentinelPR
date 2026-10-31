import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { runRetention } from "./service";

const retentionStorage = vi.hoisted(() => ({ deletedKeys: [] as string[], failOnceKeys: new Set<string>() }));
vi.mock("@/lib/storage", () => ({
  getStorage: () => ({
    delete: async (key: string) => {
      if (retentionStorage.failOnceKeys.delete(key)) throw new Error("simulated object-store outage");
      retentionStorage.deletedKeys.push(key);
    },
  }),
}));

const enabled = process.env.RUN_DB_INTEGRATION === "1" && !!process.env.DATABASE_URL;
const DAY_MS = 24 * 60 * 60 * 1_000;
const oldDate = (days: number) => new Date(Date.now() - days * DAY_MS);

describe.skipIf(!enabled)("retention service (PostgreSQL integration)", () => {
  const suffix = randomUUID();
  const retryStorageKey = `retention/${suffix}/retry.png`;
  const keys: string[] = [];
  let organizationId = "";
  let userId = "";
  let oldReviewId = "";
  let activeReviewId = "";
  let retainedReviewId = "";
  let oldSyntheticId = "";
  let activeSyntheticId = "";
  let oldVisualId = "";
  let expiredSessionId = "";
  let activeSessionId = "";
  let orphanArtifactId = "";
  let retryArtifactId = "";
  let baselineArtifactId = "";
  let auditId = "";
  let now = new Date();

  beforeAll(async () => {
    vi.stubEnv("RETENTION_ENABLED", "1");
    vi.stubEnv("RETENTION_DRY_RUN", "0");
    vi.stubEnv("RETENTION_BATCH_SIZE", "50");
    retentionStorage.deletedKeys.length = 0;
    retentionStorage.failOnceKeys.clear();

    const org = await prisma.organization.create({
      data: { name: `Retention ${suffix}`, slug: `retention-${suffix}` },
    });
    organizationId = org.id;
    const user = await prisma.user.create({
      data: { email: `retention-${suffix}@example.test`, name: "Retention test" },
    });
    userId = user.id;

    const repository = await prisma.repository.create({
      data: {
        organizationId,
        githubId: Math.floor(Math.random() * 1_000_000_000) + 1_000_000_000,
        owner: "retention-test",
        name: "fixture",
        fullName: `retention-test/fixture-${suffix}`,
      },
    });
    const pullRequest = await prisma.pullRequest.create({
      data: {
        repositoryId: repository.id,
        number: Math.floor(Math.random() * 1_000_000) + 1,
        title: "Retention fixture",
        headSha: "e".repeat(40),
        createdAt: oldDate(400),
        updatedAt: oldDate(400),
      },
    });
    const oldReview = await prisma.reviewRun.create({
      data: {
        pullRequestId: pullRequest.id,
        repositoryId: repository.id,
        headSha: "e".repeat(40),
        status: "success",
        createdAt: oldDate(400),
        completedAt: oldDate(400),
      },
    });
    oldReviewId = oldReview.id;
    const activeReview = await prisma.reviewRun.create({
      data: {
        pullRequestId: pullRequest.id,
        repositoryId: repository.id,
        headSha: "f".repeat(40),
        status: "running",
        createdAt: oldDate(400),
      },
    });
    activeReviewId = activeReview.id;
    const retainedReview = await prisma.reviewRun.create({
      data: {
        pullRequestId: pullRequest.id,
        repositoryId: repository.id,
        headSha: "a".repeat(40),
        status: "success",
        createdAt: oldDate(60),
        completedAt: oldDate(60),
      },
    });
    retainedReviewId = retainedReview.id;
    await prisma.reviewRunOutbox.create({
      data: {
        reviewRunId: retainedReviewId,
        status: "dispatched",
        dispatchedAt: oldDate(40),
        createdAt: oldDate(40),
      },
    });

    const visualSuite = await prisma.visualSuite.create({
      data: { organizationId, name: "Retention suite", baseUrl: "https://example.test" },
    });
    const visualTest = await prisma.visualTest.create({
      data: { suiteId: visualSuite.id, name: "baseline fixture" },
    });
    const baseline = await prisma.artifact.create({
      data: {
        organizationId,
        kind: "baseline",
        storageKey: `retention/${suffix}/baseline.png`,
        contentType: "image/png",
        sizeBytes: 1,
        createdAt: oldDate(400),
      },
    });
    baselineArtifactId = baseline.id;
    keys.push(baseline.storageKey);
    await prisma.visualBaseline.create({
      data: { testId: visualTest.id, browser: "chromium", viewportLabel: "desktop", artifactId: baseline.id },
    });
    const visualRun = await prisma.visualRun.create({
      data: { suiteId: visualSuite.id, testId: visualTest.id, status: "failed", createdAt: oldDate(400) },
    });
    oldVisualId = visualRun.id;
    await prisma.visualSnapshot.create({
      data: {
        runId: visualRun.id,
        testId: visualTest.id,
        browser: "chromium",
        viewportLabel: "desktop",
        viewport: { label: "desktop", width: 1280, height: 720 },
        status: "failed",
        currentArtifactId: baseline.id,
        createdAt: oldDate(400),
      },
    });

    const syntheticTest = await prisma.syntheticTest.create({
      data: { organizationId, name: "Retention monitor", baseUrl: "https://example.test", steps: [] },
    });
    const orphan = await prisma.artifact.create({
      data: {
        organizationId,
        kind: "screenshot",
        storageKey: `retention/${suffix}/orphan.png`,
        contentType: "image/png",
        sizeBytes: 1,
        createdAt: oldDate(400),
      },
    });
    orphanArtifactId = orphan.id;
    keys.push(orphan.storageKey);
    const retryArtifact = await prisma.artifact.create({
      data: {
        organizationId,
        kind: "screenshot",
        storageKey: retryStorageKey,
        contentType: "image/png",
        sizeBytes: 1,
        createdAt: oldDate(400),
      },
    });
    retryArtifactId = retryArtifact.id;
    keys.push(retryArtifact.storageKey);
    const oldSynthetic = await prisma.syntheticRun.create({
      data: { testId: syntheticTest.id, status: "passed", createdAt: oldDate(400), completedAt: oldDate(400) },
    });
    oldSyntheticId = oldSynthetic.id;
    await prisma.syntheticStepResult.create({
      data: {
        runId: oldSynthetic.id,
        index: 0,
        type: "screenshot",
        status: "passed",
        screenshotArtifactId: orphan.id,
      },
    });
    const activeSynthetic = await prisma.syntheticRun.create({
      data: { testId: syntheticTest.id, status: "running", createdAt: oldDate(400) },
    });
    activeSyntheticId = activeSynthetic.id;

    const expired = await prisma.session.create({
      data: { tokenHash: `expired-${suffix}`, userId, expiresAt: oldDate(1), createdAt: oldDate(400) },
    });
    expiredSessionId = expired.id;
    const active = await prisma.session.create({
      data: { tokenHash: `active-${suffix}`, userId, expiresAt: new Date(Date.now() + DAY_MS) },
    });
    activeSessionId = active.id;

    const delivery = await prisma.webhookDelivery.create({
      data: {
        deliveryId: `retention-${suffix}`,
        event: "pull_request",
        repositoryFullName: repository.fullName,
        status: "processed",
        createdAt: oldDate(120),
        processedAt: oldDate(120),
      },
    });
    void delivery;
    await prisma.jobRecord.create({
      data: { id: `retention-job-${suffix}`, queue: "test", type: "review", status: "completed", createdAt: oldDate(60), finishedAt: oldDate(60) },
    });
    const audit = await prisma.auditLog.create({
      data: { organizationId, actor: "system", action: "retention-test", createdAt: oldDate(400) },
    });
    auditId = audit.id;
    now = new Date();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (baselineArtifactId) await prisma.visualBaseline.deleteMany({ where: { artifactId: baselineArtifactId } });
    if (keys.length) await prisma.artifactDeletion.deleteMany({ where: { storageKey: { in: keys } } });
    if (organizationId) await prisma.organization.deleteMany({ where: { id: organizationId } });
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("dry-runs without mutation, prunes only eligible terminal data, and retries object deletion durably", async () => {
    const preview = await runRetention({ now, dryRun: true, batchSize: 50 });
    expect(preview).toMatchObject({ skipped: false, dryRun: true });
    expect(preview.reviewRuns).toBeGreaterThanOrEqual(1);
    // The referenced screenshot only becomes eligible after its terminal run cascades.
    expect(preview.artifactMetadataQueued).toBe(1);
    expect(await prisma.reviewRun.findUnique({ where: { id: oldReviewId } })).not.toBeNull();
    expect(await prisma.artifact.findUnique({ where: { id: orphanArtifactId } })).not.toBeNull();
    expect(retentionStorage.deletedKeys).toEqual([]);

    retentionStorage.failOnceKeys.add(retryStorageKey);
    const result = await runRetention({ now, dryRun: false, batchSize: 50 });
    expect(result).toMatchObject({ skipped: false, dryRun: false });
    expect(result.reviewRuns).toBe(1);
    expect(result.visualRuns).toBe(1);
    expect(result.syntheticRuns).toBe(1);
    expect(result.expiredSessions).toBe(1);
    expect(result.webhookDeliveries).toBe(1);
    expect(result.jobRecords).toBe(1);
    expect(result.dispatchedReviewOutbox).toBe(1);
    expect(result.artifactMetadataQueued).toBe(2);
    expect(result.artifactObjectsDeleted).toBe(1);
    expect(result.artifactObjectRetries).toBe(1);

    expect(await prisma.reviewRun.findUnique({ where: { id: oldReviewId } })).toBeNull();
    expect(await prisma.reviewRun.findUnique({ where: { id: activeReviewId } })).not.toBeNull();
    expect(await prisma.reviewRun.findUnique({ where: { id: retainedReviewId } })).not.toBeNull();
    expect(await prisma.reviewRunOutbox.count({ where: { reviewRunId: retainedReviewId } })).toBe(0);
    expect(await prisma.visualRun.findUnique({ where: { id: oldVisualId } })).toBeNull();
    expect(await prisma.syntheticRun.findUnique({ where: { id: oldSyntheticId } })).toBeNull();
    expect(await prisma.syntheticRun.findUnique({ where: { id: activeSyntheticId } })).not.toBeNull();
    expect(await prisma.session.findUnique({ where: { id: expiredSessionId } })).toBeNull();
    expect(await prisma.session.findUnique({ where: { id: activeSessionId } })).not.toBeNull();
    expect(await prisma.artifact.findUnique({ where: { id: orphanArtifactId } })).toBeNull();
    expect(await prisma.artifact.findUnique({ where: { id: retryArtifactId } })).toBeNull();
    expect(await prisma.artifact.findUnique({ where: { id: baselineArtifactId } })).not.toBeNull();
    expect(await prisma.auditLog.findUnique({ where: { id: auditId } })).not.toBeNull();
    expect(retentionStorage.deletedKeys).toContain(`retention/${suffix}/orphan.png`);
    expect(retentionStorage.deletedKeys).not.toContain(retryStorageKey);
    expect(retentionStorage.deletedKeys).not.toContain(`retention/${suffix}/baseline.png`);

    const retryRow = await prisma.artifactDeletion.findUnique({ where: { storageKey: retryStorageKey } });
    expect(retryRow).toMatchObject({ attemptCount: 1, lastError: "Error" });
    expect(retryRow?.nextAttemptAt.getTime()).toBeGreaterThan(now.getTime());

    const retryPass = await runRetention({ now: new Date(now.getTime() + 3 * 60_000), dryRun: false, batchSize: 50 });
    expect(retryPass.artifactObjectsDeleted).toBe(1);
    expect(await prisma.artifactDeletion.findUnique({ where: { storageKey: retryStorageKey } })).toBeNull();
    expect(retentionStorage.deletedKeys).toContain(retryStorageKey);
  });
});
