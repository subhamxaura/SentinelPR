import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { toAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { parseWebhookEvent, shouldReviewPullRequest, verifyWebhookSignature } from "@/lib/github/webhook";
import { registerRepository } from "@/lib/repositories/registration";
import { ensureReviewRun } from "@/lib/review/runs";
import { dispatchReviewRunOutbox } from "@/lib/review/outbox";

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

  if (!verifyWebhookSignature(rawBody, signature, secret)) {
    log.warn("Webhook signature validation failed", { event, deliveryId });
    return NextResponse.json({ error: { code: "INVALID_SIGNATURE", message: "Signature validation failed" } }, { status: 401 });
  }
  if (!deliveryId || deliveryId.length > 255) {
    return NextResponse.json({ error: { code: "MISSING_DELIVERY_ID", message: "Missing or invalid X-GitHub-Delivery header" } }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: { code: "INVALID_PAYLOAD", message: "Body is not valid JSON" } }, { status: 400 });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return NextResponse.json({ error: { code: "INVALID_PAYLOAD", message: "Webhook body must be a JSON object" } }, { status: 400 });
  }

  const body = payload as Record<string, unknown>;
  const action = typeof body.action === "string" ? body.action : null;
  const repositoryFullName =
    typeof (body.repository as Record<string, unknown> | undefined)?.full_name === "string"
      ? ((body.repository as Record<string, unknown>).full_name as string)
      : null;

  // Idempotency: GitHub redelivers; only the first delivery of an id acts.
  // A failed delivery may be retried by GitHub and must be reprocessed.
  try {
    await prisma.webhookDelivery.create({
      data: { deliveryId, event, action, repositoryFullName },
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const existing = await prisma.webhookDelivery.findUnique({
      where: { deliveryId },
      select: { status: true },
    });
    if (existing?.status !== "failed") {
      return NextResponse.json({ ok: true, duplicate: true });
    }
    const reclaimed = await prisma.webhookDelivery.updateMany({
      where: { deliveryId, status: "failed" },
      data: { status: "received", error: null, processedAt: null, event, action, repositoryFullName },
    });
    if (reclaimed.count === 0) {
      return NextResponse.json({ ok: true, duplicate: true });
    }
    log.info("Reprocessing failed webhook delivery", { event, deliveryId });
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
    await registerRepository(prisma, {
      organizationId: installation.organizationId,
      installationId: installation.id,
      githubId: repo.id,
      owner: repo.owner?.login ?? repo.full_name.split("/")[0],
      name: repo.name,
      fullName: repo.full_name,
      private: repo.private,
      defaultBranch: repo.default_branch ?? null,
    });
  }
  if (installation.organizationId) {
    for (const repo of body.repositories_removed ?? []) {
      await prisma.repository.updateMany({
        where: { githubId: repo.id, organizationId: installation.organizationId },
        data: { active: false },
      });
    }
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

  const ensured = await ensureReviewRun({
    pullRequestId: pullRequestRow.id,
    repositoryId: repository.id,
    headSha: pr.headSha,
    trigger: "webhook",
  });
  if (!ensured.shouldEnqueue) return;
  await dispatchReviewRunOutbox(ensured.run.id);
}


