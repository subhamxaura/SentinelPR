import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePageOrganization } from "@/lib/web/session";
import { timeAgo, formatDuration, shortSha, formatDateTime } from "@/lib/web/format";
import { PageHeader, Card, CardHeader, RunStatusBadge, RiskBadge, SeverityBadge, Mono, StatusBadge, Button } from "@/components/primitives";
import { KeyValue, ScoreRing } from "@/components/charts";
import type { RiskAssessment } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function PullRequestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const org = await requirePageOrganization();

  const pr = await prisma.pullRequest.findFirst({
    where: { id, repository: { organizationId: org.id } },
    include: {
      repository: { select: { id: true, fullName: true } },
      reviewRuns: {
        orderBy: { createdAt: "desc" },
        take: 10,
        include: { findings: { orderBy: [{ severity: "asc" }, { confidence: "desc" }] } },
      },
      visualRuns: { orderBy: { createdAt: "desc" }, take: 5, include: { snapshots: { select: { status: true, diffRatio: true } } } },
    },
  });
  if (!pr) notFound();

  const latestRun = pr.reviewRuns[0];
  const risk = latestRun?.riskSummary as unknown as RiskAssessment | null;
  const findings = latestRun?.findings ?? [];

  return (
    <div>
      <PageHeader
        title={`${pr.title}`}
        description={`${pr.repository.fullName} · #${pr.number}`}
        actions={
          <>
            {pr.url ? (
              <a href={pr.url} target="_blank" rel="noreferrer">
                <Button variant="secondary">Open on GitHub ↗</Button>
              </a>
            ) : null}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="px-4 py-4">
          <h3 className="mb-3 text-[13px] font-semibold">Pull request</h3>
          <KeyValue
            rows={[
              ["Repository", pr.repository.fullName],
              ["Author", pr.authorLogin ?? "unknown"],
              ["Branch", `${pr.headRef ?? "?"} → ${pr.baseRef ?? "?"}`],
              ["Head", shortSha(pr.headSha)],
              ["Changes", `+${pr.additions ?? "?"} −${pr.deletions ?? "?"} across ${pr.changedFiles ?? "?"} files`],
              ["State", pr.state],
              ["First seen", formatDateTime(pr.createdAt)],
            ]}
          />
        </Card>

        <Card className="px-4 py-4">
          <h3 className="mb-3 text-[13px] font-semibold">Latest review</h3>
          {latestRun ? (
            <div className="flex items-start gap-4">
              {risk ? <ScoreRing score={risk.score} level={risk.level} /> : null}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <RunStatusBadge status={latestRun.status} />
                  <RiskBadge level={latestRun.riskLevel} />
                </div>
                <KeyValue
                  rows={[
                    ["Trigger", latestRun.trigger],
                    ["Findings", String(findings.length)],
                    ["Duration", formatDuration(
                      latestRun.completedAt && latestRun.startedAt
                        ? latestRun.completedAt.getTime() - latestRun.startedAt.getTime()
                        : null,
                    )],
                    ["Commit", shortSha(latestRun.headSha)],
                    ["When", timeAgo(latestRun.createdAt)],
                  ]}
                />
              </div>
            </div>
          ) : (
            <p className="text-[13px] text-faint">No review has run for this PR yet.</p>
          )}
        </Card>

        <Card className="px-4 py-4">
          <h3 className="mb-3 text-[13px] font-semibold">Visual / E2E on this PR</h3>
          {pr.visualRuns.length === 0 ? (
            <p className="text-[13px] text-faint">
              No visual runs are attached. Run a suite against this PR from the Visual Regression section.
            </p>
          ) : (
            <div className="space-y-2">
              {pr.visualRuns.map((run) => {
                const failed = run.snapshots.filter((s) => s.status === "failed").length;
                return (
                  <a key={run.id} href={`/visual/runs/${run.id}`} className="flex items-center justify-between rounded-md border border-line px-3 py-2 hover:bg-surface-2">
                    <span className="text-[13px]">Run {shortSha(run.commitSha)} · {run.snapshots.length} snapshot(s)</span>
                    <span className="flex items-center gap-2">
                      {failed > 0 ? <SeverityBadge severity="high" /> : null}
                      <RunStatusBadge status={run.status} />
                    </span>
                  </a>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      {risk ? (
        <Card className="mt-4">
          <CardHeader title="Unified risk breakdown" sub={risk.recommendedAction} />
          <div className="grid gap-px bg-line sm:grid-cols-2 lg:grid-cols-4">
            {risk.signals.map((signal) => (
              <div key={signal.dimension} className="bg-surface px-4 py-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">{signal.dimension}</span>
                  <RiskBadge level={signal.level} />
                </div>
                <ul className="mt-2 space-y-1">
                  {signal.reasons.map((reason, i) => (
                    <li key={i} className="text-xs leading-relaxed text-muted">{reason}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {latestRun ? (
        <Card className="mt-4">
          <CardHeader title={`Findings (${findings.length})`} sub={`Run from ${timeAgo(latestRun.createdAt)} — earlier runs are in the history below`} />
          {findings.length === 0 ? (
            <div className="px-4 py-8 text-center text-[13px] text-faint">
              No findings in the latest run. Either the diff is clean or the configured thresholds filtered everything out.
            </div>
          ) : (
            <div className="divide-y divide-line">
              {findings.map((f) => (
                <div key={f.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <SeverityBadge severity={f.severity} />
                    <span className="text-[13px] font-medium">{f.title}</span>
                    {f.published ? <StatusBadge tone="success">commented on GitHub</StatusBadge> : null}
                    {f.source === "ai" ? <StatusBadge tone="accent">AI</StatusBadge> : null}
                  </div>
                  <div className="mt-1 font-mono text-xs text-faint">
                    {f.file}{f.startLine ? `:${f.startLine}` : ""} · {f.category} · confidence {(f.confidence * 100).toFixed(0)}% · {f.ruleId ?? "ai"}
                  </div>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{f.description}</p>
                  {f.evidence ? (
                    <pre className="mt-2 overflow-x-auto rounded-md border border-line bg-bg px-3 py-2 font-mono text-xs text-muted">{f.evidence}</pre>
                  ) : null}
                  {f.suggestion ? (
                    <p className="mt-1.5 text-[13px] text-emerald-400/90">Suggestion: {f.suggestion}</p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </Card>
      ) : null}

      <Card className="mt-4">
        <CardHeader title="Run history" />
        {pr.reviewRuns.length === 0 ? (
          <div className="px-4 py-8 text-center text-[13px] text-faint">No runs recorded.</div>
        ) : (
          <div className="divide-y divide-line">
            {pr.reviewRuns.map((run) => (
              <div key={run.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[13px]">
                <div className="flex items-center gap-2">
                  <Mono>{shortSha(run.headSha)}</Mono>
                  <RunStatusBadge status={run.status} />
                  <RiskBadge level={run.riskLevel} />
                  <span className="text-faint">{run.findings.length} finding(s)</span>
                </div>
                <div className="text-xs text-faint">
                  {run.trigger} · {timeAgo(run.createdAt)}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
