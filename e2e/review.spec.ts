import { createHmac } from "node:crypto";
import IORedis from "ioredis";
import { Queue } from "bullmq";
import { test, expect, E2E_WEBHOOK_SECRET } from "./fixtures";
import { QUEUE_NAMES } from "../src/lib/types";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3100";
const PR_NUMBER = 73;
const PR_TITLE = "E2E critical review workflow";
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

test("a signed pull-request webhook creates and dispatches a queued review", async ({ page, e2e }) => {
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await page.route("https://fonts.gstatic.com/**", (route) => route.fulfill({ status: 204, body: "" }));

  const payload = {
    action: "opened",
    installation: { id: e2e.installationId },
    repository: {
      id: e2e.repositoryGithubId,
      full_name: e2e.repositoryFullName,
      private: false,
      default_branch: "main",
    },
    pull_request: {
      number: PR_NUMBER,
      id: e2e.repositoryGithubId + 1,
      title: PR_TITLE,
      state: "open",
      draft: false,
      head: { sha: HEAD_SHA, ref: "feature/e2e" },
      base: { ref: "main" },
      user: { login: e2e.githubLogin, avatar_url: null },
      additions: 4,
      deletions: 1,
      changed_files: 2,
      html_url: `https://github.com/${e2e.repositoryFullName}/pull/${PR_NUMBER}`,
    },
  };
  const rawBody = JSON.stringify(payload);
  const deliveryId = `e2e-${e2e.key}`;
  const signature = createHmac("sha256", E2E_WEBHOOK_SECRET).update(rawBody).digest("hex");

  const webhookResponse = await page.request.post(`${BASE_URL}/api/github/webhook`, {
    data: rawBody,
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": `sha256=${signature}`,
    },
  });
  expect(webhookResponse.status()).toBe(202);
  expect(await webhookResponse.json()).toEqual({ ok: true });

  const delivery = await e2e.pool.query('SELECT "status" FROM "WebhookDelivery" WHERE "deliveryId" = $1', [deliveryId]);
  expect(delivery.rows[0]?.status).toBe("processed");

  const pullRequest = await e2e.pool.query(
    'SELECT "id", "title" FROM "PullRequest" WHERE "repositoryId" = $1 AND "number" = $2',
    [e2e.repositoryId, PR_NUMBER],
  );
  expect(pullRequest.rowCount).toBe(1);
  const pullRequestId = pullRequest.rows[0].id as string;
  expect(pullRequest.rows[0].title).toBe(PR_TITLE);

  const runs = await e2e.pool.query(
    'SELECT rr."id", rr."status", rr."trigger", ro."status" AS "outboxStatus" FROM "ReviewRun" rr LEFT JOIN "ReviewRunOutbox" ro ON ro."reviewRunId" = rr."id" WHERE rr."pullRequestId" = $1 ORDER BY rr."createdAt" DESC LIMIT 1',
    [pullRequestId],
  );
  expect(runs.rowCount).toBe(1);
  const reviewRun = runs.rows[0];
  expect(reviewRun.status).toBe("queued");
  expect(reviewRun.trigger).toBe("webhook");
  expect(reviewRun.outboxStatus).toBe("dispatched");

  const redisUrl = process.env.E2E_REDIS_URL;
  if (!redisUrl) throw new Error("E2E_REDIS_URL was not set by Playwright configuration.");
  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: 1, connectTimeout: 5_000 });
  const queue = new Queue(QUEUE_NAMES.review, { connection: redis });
  const jobId = `review-run-${reviewRun.id as string}`;
  try {
    const job = await queue.getJob(jobId);
    expect(job).not.toBeNull();
    expect(job?.data).toEqual({ reviewRunId: reviewRun.id });
    expect(await job?.getState()).toBe("waiting");
  } finally {
    try {
      const job = await queue.getJob(jobId);
      await job?.remove();
    } finally {
      await queue.close();
    }
  }

  await page.goto(`/pull-requests/${pullRequestId}`);
  await expect(page.getByRole("heading", { name: PR_TITLE })).toBeVisible();
  await expect(page.getByText(e2e.repositoryFullName, { exact: false }).first()).toBeVisible();
  await expect(page.getByText("queued", { exact: true }).first()).toBeVisible();
});
