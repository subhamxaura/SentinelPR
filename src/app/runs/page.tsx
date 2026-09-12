import { prisma } from "@/lib/db";
import { requireOrganization } from "@/lib/web/session";
import { timeAgo, shortSha, formatDuration } from "@/lib/web/format";
import { PageHeader, Card, RunStatusBadge, RiskBadge, Mono } from "@/components/primitives";
import { EmptyState } from "@/components/states";

export const dynamic = "force-dynamic";

type UnifiedRun = {
  id: string;
  kind: "review" | "visual" | "synthetic";
  label: string;
  sub: string;
  status: string;
  detail: string;
  createdAt: Date;
  href: string;
};

export default async function RunsPage() {
  const org = await requireOrganization();

  const [reviews, visuals, synthetics] = await Promise.all([
    prisma.reviewRun.findMany({
      where: { repository: { organizationId: org.id } },
      orderBy: { createdAt: "desc" },
      take: 25,
      include: { pullRequest: { include: { repository: { select: { fullName: true } } } } },
    }),
    prisma.visualRun.findMany({
      where: { suite: { organizationId: org.id } },
      orderBy: { createdAt: "desc" },
      take: 25,
      include: { suite: { select: { name: true } }, test: { select: { name: true } } },
    }),
    prisma.syntheticRun.findMany({
      where: { test: { organizationId: org.id } },
      orderBy: { createdAt: "desc" },
      take: 25,
      include: { test: { select: { name: true } } },
    }),
  ]);

  const runs: UnifiedRun[] = [
    ...reviews.map((r) => ({
      id: r.id,
      kind: "review" as const,
      label: `PR #${r.pullRequest.number} — ${r.pullRequest.title}`,
      sub: r.pullRequest.repository.fullName,
      status: r.status,
      detail: `risk ${r.riskLevel ?? "—"}`,
      createdAt: r.createdAt,
      href: `/pull-requests/${r.pullRequestId}`,
    })),
    ...visuals.map((r) => ({
      id: r.id,
      kind: "visual" as const,
      label: r.test ? r.test.name : `${r.suite.name} (suite)`,
      sub: r.suite.name,
      status: r.status,
      detail: r.diffRatio ? `Δ ${(r.diffRatio * 100).toFixed(2)}%` : "",
      createdAt: r.createdAt,
      href: `/visual/runs/${r.id}`,
    })),
    ...synthetics.map((r) => ({
      id: r.id,
      kind: "synthetic" as const,
      label: r.test.name,
      sub: r.trigger,
      status: r.status,
      detail: r.durationMs ? formatDuration(r.durationMs) : "",
      createdAt: r.createdAt,
      href: `/synthetic/${r.testId}`,
    })),
  ]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 60);

  return (
    <div>
      <PageHeader title="Runs" description="Every execution across review, visual and synthetic workers." />
      {runs.length === 0 ? (
        <EmptyState title="No runs recorded">
          Runs appear here once the workers process reviews, visual suites or synthetic monitors. This screen
          only shows real executions — it never fabricates history.
        </EmptyState>
      ) : (
        <Card>
          <div className="divide-y divide-line">
            {runs.map((run) => (
              <a key={`${run.kind}-${run.id}`} href={run.href} className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-surface-2">
                <div className="flex min-w-0 items-center gap-3">
                  <KindTag kind={run.kind} />
                  <div className="min-w-0">
                    <div className="truncate text-[13px]">{run.label}</div>
                    <div className="truncate text-[11px] text-faint">
                      {run.sub} {run.detail ? `· ${run.detail}` : ""}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-xs text-faint">{timeAgo(run.createdAt)}</span>
                  <RunStatusBadge status={run.status} />
                </div>
              </a>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function KindTag({ kind }: { kind: string }) {
  const tone = kind === "review" ? "text-accent-strong" : kind === "visual" ? "text-purple-400" : "text-emerald-400";
  return <Mono className={`w-16 shrink-0 text-[10px] uppercase ${tone}`}>{kind}</Mono>;
}
