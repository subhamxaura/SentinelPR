export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { apiError, parseBody } from "@/lib/web/api";
import { actorFor, recordAudit, requireMutationRole, requireOrganization } from "@/lib/web/session";
import { fetchPullRequestData } from "@/lib/github/client";
import { toAppError } from "@/lib/errors";
import { ensureReviewRun } from "@/lib/review/runs";
import { dispatchReviewRunOutbox } from "@/lib/review/outbox";
import { rateLimitPolicies } from "@/lib/web/rate-limit";

const reviewSchema = z.object({
  pullNumber: z.number().int().min(1).max(100_000),
  headSha: z.string().max(80).optional(),
});

/**
 * Manual review trigger (no webhook required): fetch the PR from GitHub,
 * create a review run and enqueue it. Honest 503 when GitHub credentials are
 * missing — it never pretends to have reviewed.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = parseBody(reviewSchema, await req.json());
    const org = await requireOrganization(req, [rateLimitPolicies.manualReview]);
    requireMutationRole(org, req.method);

    const repository = await prisma.repository.findFirst({
      where: { id, organizationId: org.id },
    });
    if (!repository) {
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "Repository not found", category: "authz" } }, { status: 404 });
    }

    let installationId: number | null = null;
    if (repository.installationId) {
      const inst = await prisma.githubInstallation.findUnique({
        where: { id: repository.installationId },
        select: { installationId: true },
      });
      installationId = inst?.installationId ?? null;
    }

    const { pr } = await fetchPullRequestData({ installationId, fullName: repository.fullName }, body.pullNumber);

    const pullRequestRow = await prisma.pullRequest.upsert({
      where: { repositoryId_number: { repositoryId: repository.id, number: pr.number } },
      update: {
        title: pr.title,
        state: pr.state,
        headSha: pr.headSha,
        authorLogin: pr.authorLogin,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changedFiles,
        url: pr.url,
      },
      create: {
        repositoryId: repository.id,
        number: pr.number,
        githubId: pr.id,
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
      trigger: "manual",
    });

    if (ensured.shouldEnqueue) {
      try {
        await dispatchReviewRunOutbox(ensured.run.id);
      } catch (e) {
        const appErr = toAppError(e);
        return NextResponse.json(
          { error: { code: "QUEUE_UNAVAILABLE", message: "Queue unavailable. Start Redis with `docker compose up -d redis` and try again.", category: "infrastructure", retryable: true } },
          { status: 503 },
        );
      }
    }
    if (ensured.created) {
      await recordAudit(org.id, actorFor(org), "review.triggered", "review_run", ensured.run.id, { repo: repository.fullName, pullNumber: pr.number });
    }
    return NextResponse.json({ runId: ensured.run.id, reused: !ensured.created, status: ensured.run.status }, { status: 202 });
  } catch (e) {
    return apiError(e);
  }
}
