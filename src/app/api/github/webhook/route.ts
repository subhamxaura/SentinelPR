import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { toAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { parseWebhookEvent, shouldReviewPullRequest } from "@/lib/github/webhook";
import { enqueueReviewRun } from "@/lib/queue";

const log = logger.child({ module: "github-webhook" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GitHub webhook receiver.
 * Contract: validate signature → dedupe by delivery id → persist intent →
 * enqueue → respond. Never blocks on AI, Playwright or repository analysis.
 */
export async function POST(req: Request) {
  const secret = env.github.webhookSecret;
  if (!secret) {
    return NextResponse.json(
      { error: { code: "GITHUB_NOT_CONFIGURED", message: "GITHUB_WEBHOOK_SECRET is not set — webhooks are disabled.", category: "config", retryable: false } },
      { status: 503 },
    );
  }

  const rawBody = await req.text();
  const signature = req.headers.get("x-hub-signature-256");
  const event = req.headers.get("x-github-event") ?? "unknown";
  const deliveryId = req.headers.get("x-github-delivery") ?? "";

  if (!verify(secret, rawBody, signature)) {
    log.warn("Webhook signature validation failed", { event, deliveryId });
    return NextResponse.json({ error: { code: "INVALID_SIGNATURE", message: "Signature validation failed" } }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: { code: "INVALID_PAYLOAD", message: "Body is not valid JSON" } }, { status: 400 });
  }

  // Idempotency: GitHub redelivers; only the first delivery of an id acts.
  try {
    await prisma.webhookDelivery.create({
      data: {
        deliveryId,
        event,
        action: (payload as { action?: string }).action ?? null,
        repositoryFullName: ((payload as { repository?: { full_name?: string } }).repository?.full_name ?? null),
      },
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      return NextResponse.json({ ok: true, duplicate: true });
    }
    throw e;
  }

  try {
    const parsed = parseWebhookEvent(Object.fromEntries(req.headers), payload);
    await handleEvent(parsed);
    await prisma.webhookDelivery.update({
      where: { deliveryId },
      data: { status: "processed", processedAt: new Date() },
    });
    // Acknowledge fast — long-running work lives in the queue.
    return NextResponse.json({ ok: true }, { status: 202 });
  } catch (e) {
    const appErr = toAppError(e);
    await prisma.webhookDelivery
      .update({ where: { deliveryId }, data: { status: "failed", error: appErr.message, processedAt: new Date() } })
      .catch(() => undefined);
    log.error("Webhook processing failed", { event, deliveryId, error: appErr.toJSON() });
    return NextResponse.json({ error: appErr.toJSON() }, { status: 500 });
  }
}

function verify(secret: string, body: string, signature: string | null): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(body, "utf8").digest("hex");
  const received = signature.slice(7);
  if (received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: string }).code === "P2002";
}

async function handleEvent(parsed: ReturnType<typeof parseWebhookEvent>): Promise<void> {
  switch (parsed.event) {
    case "installation":
      return handleInstallation(parsed);
    case "installation_repositories":
      return handleInstallationRepos(parsed);
    case "pull_request":
      return handlePullRequest(parsed);
    default:
      return; // acknowledged and recorded, no action
  }
}

async function handleInstallation(parsed: ReturnType<typeof parseWebhookEvent>) {
  if (!parsed.installationId) return;
  const action = parsed.action;
  // Installation.account is the target org/user; sender is whoever clicked install.
  const body = parsed as unknown as {
    sender?: { login?: string };
    installation?: { account?: { login?: string; type?: string } };
  };
  if (action === "created") {
    await prisma.githubInstallation.upsert({
      where: { installationId: parsed.installationId },
      update: { removedAt: null },
      create: {
        installationId: parsed.installationId,
        // Unclaimed: no organization yet. A dashboard admin claims it (and
        // backfills its repositories) from the Repositories page.
        organizationId: null,
        accountLogin: body.installation?.account?.login ?? body.sender?.login ?? "unknown",
        accountType: body.installation?.account?.type ?? "Unknown",
      },
    });
  } else if (action === "deleted") {
    await prisma.githubInstallation.updateMany({
      where: { installationId: parsed.installationId },
      data: { removedAt: new Date() },
    });
  }
}

async function handleInstallationRepos(parsed: ReturnType<typeof parseWebhookEvent>) {
  if (!parsed.installationId) return;
  const body = parsed as unknown as {
    repositories_added?: Array<{ id: number; name: string; full_name: string; private: boolean; default_branch?: string; owner?: { login?: string } }>;
    repositories_removed?: Array<{ id: number }>;
  };
  const installation = await prisma.githubInstallation.findUnique({ where: { installationId: parsed.installationId } });
  if (!installation) return;

  for (const repo of body.repositories_added ?? []) {
    if (!installation.organizationId) {
      // Installation not claimed by an organization yet — repositories are
      // backfilled by the claim action instead of landing in a default org.
      log.info("Skipping repository for unclaimed installation", {
        installation: installation.installationId,
        repo: repo.full_name,
      });
      continue;
    }
    await prisma.repository.upsert({
      where: { githubId: repo.id },
      update: { installationId: installation.id, active: true },
      create: {
        organizationId: installation.organizationId,
        installationId: installation.id,
        githubId: repo.id,
        owner: repo.owner?.login ?? repo.full_name.split("/")[0],
        name: repo.name,
        fullName: repo.full_name,
        private: repo.private,
        defaultBranch: repo.default_branch ?? null,
      },
    });
  }
  for (const repo of body.repositories_removed ?? []) {
    await prisma.repository.updateMany({ where: { githubId: repo.id }, data: { active: false } });
  }
}

async function handlePullRequest(parsed: ReturnType<typeof parseWebhookEvent>) {
  if (!parsed.repository || !parsed.pullRequest) return;
  if (!shouldReviewPullRequest(parsed.event, parsed.action, { draft: parsed.pullRequest.draft })) return;
  if (!parsed.installationId) return;

  const repository = await prisma.repository.findUnique({
    where: { githubId: parsed.repository.id },
  });
  if (!repository || !repository.active) {
    // Repo not registered (App installed but repo not selected) — record and skip.
    log.info("PR event for unregistered repository", { repo: parsed.repository.fullName });
    return;
  }

  const pr = parsed.pullRequest;
  const pullRequestRow = await prisma.pullRequest.upsert({
    where: { repositoryId_number: { repositoryId: repository.id, number: pr.number } },
    update: {
      title: pr.title,
      state: pr.state,
      headSha: pr.headSha,
      headRef: pr.headRef,
      baseRef: pr.baseRef,
      authorLogin: pr.authorLogin,
      authorAvatar: pr.authorAvatar,
      url: pr.url,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
    },
    create: {
      repositoryId: repository.id,
      number: pr.number,
      githubId: pr.id || null,
      title: pr.title,
      state: pr.state,
      headSha: pr.headSha,
      headRef: pr.headRef,
      baseRef: pr.baseRef,
      authorLogin: pr.authorLogin,
      authorAvatar: pr.authorAvatar,
      url: pr.url,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
    },
  });

  // One review per head SHA: redeliveries/synchronize races dedupe here.
  const existing = await prisma.reviewRun.findFirst({
    where: { pullRequestId: pullRequestRow.id, headSha: pr.headSha, status: { in: ["queued", "running", "success", "failure"] } },
    select: { id: true },
  });
  if (existing) return;

  const run = await prisma.reviewRun.create({
    data: {
      pullRequestId: pullRequestRow.id,
      repositoryId: repository.id,
      headSha: pr.headSha,
      trigger: "webhook",
      status: "queued",
    },
  });
  await enqueueReviewRun(run.id);
}


