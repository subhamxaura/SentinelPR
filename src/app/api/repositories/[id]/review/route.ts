export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { apiError, parseBody } from "@/lib/web/api";
import { recordAudit, requireOrganization } from "@/lib/web/session";
import { enqueueReviewRun, getQueueConnection } from "@/lib/queue";
import { fetchPullRequestData } from "@/lib/github/client";
import { toAppError } from "@/lib/errors";

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
    const org = await requireOrganization();

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

    const run = await prisma.reviewRun.create({
      data: {
        pullRequestId: pullRequestRow.id,
        repositoryId: repository.id,
        headSha: pr.headSha,
        trigger: "manual",
        status: "queued",
      },
    });

    const jobId = await enqueueReviewRun(run.id);
    if (!jobId) {
      // Redis missing → the run stays queued forever; be honest instead.
      await prisma.reviewRun.update({
        where: { id: run.id },
        data: {
          status: "error",
          error: "Queue unavailable: REDIS_URL is not configured or Redis is unreachable.",
        },
      });
      return NextResponse.json(
        { error: { code: "QUEUE_UNAVAILABLE", message: "Redis is not available. Start it with `docker compose up -d redis`.", category: "infrastructure" } },
        { status: 503 },
      );
    }
    void getQueueConnection;
    await recordAudit(org.id, "user", "review.triggered", "review_run", run.id, { repo: repository.fullName, pullNumber: pr.number });
    return NextResponse.json({ runId: run.id }, { status: 202 });
  } catch (e) {
    return apiError(e);
  }
}
