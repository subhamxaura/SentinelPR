import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { toAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { runRuleEngine, resolveRepoReviewConfig, toChangedFiles } from "@/lib/rules/engine";
import { dedupeFindings, normalizeFinding } from "@/lib/review/normalize";
import { getReviewModel } from "@/lib/ai/model";
import { computeRisk } from "@/lib/risk/engine";
import { createCheckRun, fetchPullRequestData, publishReview } from "@/lib/github/client";
import { raiseAlert } from "@/lib/alerts";
import { SEVERITY_RANK, RISK_RANK, type Finding, type RiskAssessment, type RiskLevel, type Severity } from "@/lib/types";

/**
 * Review pipeline: GitHub fetch → deterministic rules → optional AI →
 * normalize/dedupe → persist → GitHub check run + inline comments → unified risk.
 * Never executes repository code — it reads diffs through the GitHub API only.
 */

const log = logger.child({ module: "review-pipeline" });

export async function processReviewRun(reviewRunId: string): Promise<void> {
  const run = await prisma.reviewRun.findUnique({
    where: { id: reviewRunId },
    include: { pullRequest: true, repository: true },
  });
  if (!run) {
    log.warn("Review run not found", { reviewRunId });
    return;
  }
  // Idempotency: retries after success must not re-publish anything.
  if (run.status !== "queued" && run.status !== "running") {
    log.info("Review run already terminal, skipping", { reviewRunId, status: run.status });
    return;
  }

  const runLog = log.child({ reviewRunId, repo: run.repository.fullName, pr: run.pullRequest.number });
  await prisma.reviewRun.update({
    where: { id: run.id },
    data: { status: "running", startedAt: new Date() },
  });

  try {
    const { pr: ghPr, files } = await fetchPullRequestData(
      await repoAuth(run.repository),
      run.pullRequest.number,
    );

    // Keep the local PR row in sync with reality.
    await prisma.pullRequest.update({
      where: { id: run.pullRequest.id },
      data: {
        title: ghPr.title,
        state: ghPr.state,
        headSha: ghPr.headSha,
        authorLogin: ghPr.authorLogin,
        authorAvatar: ghPr.authorAvatar,
        additions: ghPr.additions,
        deletions: ghPr.deletions,
        changedFiles: ghPr.changedFiles,
        url: ghPr.url,
      },
    });

    const config = resolveRepoReviewConfig(run.repository.config);
    const changedFiles = toChangedFiles(files);
    const prContext = {
      number: ghPr.number,
      title: ghPr.title,
      authorLogin: ghPr.authorLogin,
      headSha: ghPr.headSha,
      baseRef: ghPr.baseRef,
      headRef: ghPr.headRef,
      body: null,
    };

    // 1. Deterministic rules — always run, AI or not.
    let findings: Finding[] = runRuleEngine({ pr: prContext, files: changedFiles, config });

    // 2. AI enhancement — best effort, never fatal.
    const model = getReviewModel();
    if (model && files.length > 0) {
      const aiStart = Date.now();
      try {
        const aiFindings = await model.analyze({ pr: prContext, files: changedFiles, config });
        findings = dedupeFindings([...findings, ...aiFindings]);
        runLog.info("AI review completed", {
          model: model.id,
          aiFindings: aiFindings.length,
          durationMs: Date.now() - aiStart,
        });
      } catch (e) {
        // Preserve deterministic findings; record the AI failure honestly.
        runLog.error("AI review failed — continuing with deterministic findings only", {
          error: toAppError(e).toJSON(),
        });
      }
    }

    // 3. Persist.
    if (findings.length) {
      await prisma.reviewFinding.createMany({
        data: findings.map((f) => ({
          runId: run.id,
          repositoryId: run.repositoryId,
          ruleId: f.ruleId,
          source: f.source,
          category: f.category,
          severity: f.severity,
          confidence: f.confidence,
          kind: f.kind,
          file: f.file,
          startLine: f.startLine,
          endLine: f.endLine,
          title: f.title,
          description: f.description,
          evidence: f.evidence,
          suggestion: f.suggestion,
          dedupKey: f.dedupKey,
        })),
        skipDuplicates: true,
      });
    }

    // 4. Unified risk — code signals + any visual runs for this PR + production health.
    const visual = await visualSignalFor(run.pullRequestId, ghPr.headSha);
    const synthetic = await productionSignal(run.repository.organizationId);
    const risk = computeRisk({ findings, visual: visual ?? undefined, synthetic });

    const blocking = findings.filter(isBlocking);
    const status = blocking.length > 0 ? "failure" : "success";

    await prisma.reviewRun.update({
      where: { id: run.id },
      data: {
        status,
        conclusion: status,
        riskLevel: risk.level,
        riskScore: risk.score,
        riskSummary: risk as unknown as object,
        summary: buildRunSummary(risk, findings),
        stats: {
          findings: findings.length,
          bySeverity: countBy(findings, (f) => f.severity),
          byCategory: countBy(findings, (f) => f.category),
          files: changedFiles.length,
          aiEnabled: Boolean(model),
        },
      },
    });

    // 5. GitHub feedback — check run + inline comments (publishable subset only).
    await publishGitHubFeedback(run, ghPr.number, config, findings, risk);

    // 6. Alerts for high-risk or security-bearing reviews.
    const securityFindings = findings.filter((f) => f.category === "security" && SEVERITY_RANK[f.severity] >= SEVERITY_RANK.high);
    if (securityFindings.length > 0) {
      await raiseAlert({
        organizationId: run.repository.organizationId,
        type: "security_finding",
        severity: "critical",
        title: `Security findings in PR #${ghPr.number} (${run.repository.fullName})`,
        body: securityFindings.map((f) => `- [${f.severity}] ${f.title} (${f.file})`).join("\n"),
        entityType: "pull_request",
        entityId: run.pullRequestId,
      });
    } else if (RISK_RANK[risk.level] >= RISK_RANK.high) {
      await raiseAlert({
        organizationId: run.repository.organizationId,
        type: "high_risk_pr",
        severity: "warning",
        title: `High-risk PR #${ghPr.number} (${run.repository.fullName})`,
        body: `Unified risk is ${risk.level.toUpperCase()} (score ${risk.score}). ${risk.recommendedAction}`,
        entityType: "pull_request",
        entityId: run.pullRequestId,
      });
    }

    runLog.info("Review run completed", {
      status,
      risk: risk.level,
      findings: findings.length,
      blocking: blocking.length,
    });
  } catch (e) {
    const appErr = toAppError(e);
    await prisma.reviewRun.update({
      where: { id: run.id },
      data: { status: "error", error: JSON.stringify(appErr.toJSON()), completedAt: new Date() },
    });
    runLog.error("Review run failed", { error: appErr.toJSON() });
  }
}

function isBlocking(f: Finding): boolean {
  return (
    (f.category === "security" && SEVERITY_RANK[f.severity] >= SEVERITY_RANK.high) ||
    f.severity === "critical"
  );
}

function riskToSeverity(level: RiskLevel): Severity {
  switch (level) {
    case "critical":
    case "high":
    case "medium":
    case "low":
      return level;
    default:
      return "info";
  }
}

async function visualSignalFor(pullRequestId: string, headSha: string) {
  const runs = await prisma.visualRun.findMany({
    where: { pullRequestId, commitSha: headSha, status: { in: ["passed", "failed"] } },
    include: { snapshots: { select: { status: true } } },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  if (!runs.length) return null;
  const snapshots = runs.flatMap((r) => r.snapshots);
  const failed = snapshots.filter((s) => s.status === "failed").length;
  const newBaselines = snapshots.filter((s) => s.status === "new" || s.status === "baseline_missing").length;
  return { total: snapshots.length, failed, newBaselines };
}

async function productionSignal(organizationId: string) {
  const tests = await prisma.syntheticTest.findMany({
    where: { organizationId, enabled: true },
    select: { id: true, alertLatencyMs: true },
  });
  if (!tests.length) return null;
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const runs = await prisma.syntheticRun.findMany({
    where: { testId: { in: tests.map((t) => t.id) }, createdAt: { gte: since }, status: { in: ["passed", "failed"] } },
    select: { status: true, testId: true },
    orderBy: { createdAt: "desc" },
    take: 2000,
  });
  if (!runs.length) return null;
  const availability = runs.filter((r) => r.status === "passed").length / runs.length;

  // Worst consecutive-failure streak among currently failing tests.
  let consecutive = 0;
  for (const test of tests) {
    const recent = await prisma.syntheticRun.findMany({
      where: { testId: test.id },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { status: true },
    });
    let streak = 0;
    for (const r of recent) {
      if (r.status === "failed") streak++;
      else break;
    }
    consecutive = Math.max(consecutive, streak);
  }

  return {
    availability,
    consecutiveFailures: consecutive,
    p95Ms: null as number | null,
    latencyThresholdMs: tests.find((t) => t.alertLatencyMs)?.alertLatencyMs ?? null,
  };
}

interface RunForPublish {
  id: string;
  repositoryId: string;
  pullRequestId: string;
  headSha: string;
  repository: { installationId: string | null; fullName: string };
}

async function publishGitHubFeedback(
  run: RunForPublish,
  pullNumber: number,
  config: ReturnType<typeof resolveRepoReviewConfig>,
  findings: Finding[],
  risk: RiskAssessment,
): Promise<void> {
  const repo = await repoAuth(run.repository);

  const checkRunId = await createCheckRun(repo, {
    headSha: run.headSha,
    status: "completed",
    conclusion: findings.some(isBlocking) || SEVERITY_RANK[riskToSeverity(risk.level)] >= SEVERITY_RANK.high ? "failure" : "success",
    title: `SentinelPR — risk ${risk.level.toUpperCase()} (score ${risk.score})`,
    summary: buildCheckSummary(risk, findings, run.id),
    detailsUrl: `${env.dashboardUrl}/pull-requests/${run.pullRequestId}`,
  });
  if (checkRunId) {
    await prisma.reviewRun.update({ where: { id: run.id }, data: { checkRunId } });
  }

  // Inline comments: above thresholds, not already published for this PR+file+line+rule.
  const publishable = findings
    .filter((f) => f.startLine !== null)
    .filter((f) => config.publishSeverities.includes(f.severity))
    .filter((f) => f.confidence >= config.confidenceThreshold)
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
    .slice(0, config.maxComments);

  if (!publishable.length) return;

  const previous = await prisma.reviewFinding.findMany({
    where: {
      repositoryId: run.repositoryId,
      published: true,
      run: { pullRequestId: run.pullRequestId },
    },
    select: { file: true, startLine: true, ruleId: true, dedupKey: true },
  });
  const seen = new Set(previous.map((p) => `${p.ruleId ?? ""}:${p.file}:${p.startLine}`));
  const toPublish = publishable.filter((f) => !seen.has(`${f.ruleId ?? ""}:${f.file}:${f.startLine}`));
  if (!toPublish.length) return;

  const result = await publishReview(
    repo,
    pullNumber,
    run.headSha,
    "",
    toPublish.map((f) => ({
      path: f.file,
      startLine: f.startLine,
      line: f.endLine ?? f.startLine!,
      body: commentBody(f),
    })),
  );
  if (result) {
    await prisma.reviewFinding.updateMany({
      where: { id: { in: (await publishedIds(run.id, toPublish)) } },
      data: { published: true },
    });
  }
}

async function publishedIds(runId: string, findings: Finding[]): Promise<string[]> {
  const rows = await prisma.reviewFinding.findMany({
    where: { runId, dedupKey: { in: findings.map((f) => f.dedupKey) } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

function commentBody(f: Finding): string {
  const parts = [
    `**${f.title}**`,
    `\`${f.category}\` · \`${f.severity}\` · confidence ${(f.confidence * 100).toFixed(0)}% · ${f.source === "ai" ? "AI" : "rule"}: \`${f.ruleId ?? "ai"}\``,
    "",
    f.description,
  ];
  if (f.evidence) parts.push("", `\`\`\`\n${f.evidence}\n\`\`\``);
  if (f.suggestion) parts.push("", `**Suggestion:** ${f.suggestion}`);
  return parts.join("\n");
}

function buildCheckSummary(risk: RiskAssessment, findings: Finding[], runId: string): string {
  const lines: string[] = [
    `**Unified risk: ${risk.level.toUpperCase()}** (score ${risk.score}/100)`,
    "",
    "| Signal | Level | Detail |",
    "| --- | --- | --- |",
    ...risk.signals.map((s) => `| ${s.dimension} | ${s.level} | ${s.reasons.join("; ")} |`),
    "",
    `**Recommended action:** ${risk.recommendedAction}`,
  ];
  const top = findings
    .slice()
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
    .slice(0, 10);
  if (top.length) {
    lines.push("", `<details><summary><strong>${findings.length} finding(s) — top ${top.length}</strong></summary>`, "");
    for (const f of top) {
      lines.push(`- **[${f.severity}] ${f.title}** — \`${f.file}${f.startLine ? `:${f.startLine}` : ""}\``);
      lines.push(`  ${f.description.slice(0, 300)}`);
    }
    lines.push("", "</details>");
  }
  lines.push("", `[View full run on SentinelPR](${env.dashboardUrl}/pull-requests?run=${runId})`);
  return lines.join("\n");
}

function buildRunSummary(risk: RiskAssessment, findings: Finding[]): string {
  const blocking = findings.filter(isBlocking);
  return `Risk ${risk.level.toUpperCase()} (score ${risk.score}). ${findings.length} finding(s), ${blocking.length} blocking. ${risk.recommendedAction}`;
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, item) => {
    const k = key(item);
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
}

/** Resolve the numeric GitHub installation id for repos connected via the App. */
async function repoAuth(repoRow: { installationId: string | null; fullName: string }) {
  let installationId: number | null = null;
  if (repoRow.installationId) {
    const inst = await prisma.githubInstallation.findUnique({
      where: { id: repoRow.installationId },
      select: { installationId: true },
    });
    installationId = inst?.installationId ?? null;
  }
  return { installationId, fullName: repoRow.fullName };
}
