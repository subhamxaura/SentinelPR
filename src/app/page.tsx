import { prisma } from "@/lib/db";
import { requireOrganization } from "@/lib/web/session";
import { integrationStatuses } from "@/lib/env";
import { timeAgo } from "@/lib/web/format";
import { PageHeader, MetricCard, Card, CardHeader, RunStatusBadge, RiskBadge, StatusBadge, Mono } from "@/components/primitives";
import { EmptyState } from "@/components/states";
import { AvailabilityDots } from "@/components/charts";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const org = await requireOrganization();
  const since7d = new Date(Date.now() - 7 * 24 * 3600 * 1000);

  const [
    repoCount,
    openPrCount,
    highRiskRuns,
    reviewRuns7d,
    visualFailures7d,
    syntheticTests,
    recentRuns,
    openAlerts,
    latestSyntheticRuns,
  ] = await Promise.all([
    prisma.repository.count({ where: { organizationId: org.id, active: true } }),
    prisma.pullRequest.count({ where: { repository: { organizationId: org.id }, state: "open" } }),
    prisma.reviewRun.findMany({
      where: { repository: { organizationId: org.id }, riskLevel: { in: ["high", "critical"] }, pullRequest: { state: "open" } },
      distinct: ["pullRequestId"],
      select: { id: true, riskLevel: true, pullRequest: { select: { id: true, number: true, title: true, repository: { select: { fullName: true } } } } },
      take: 10,
    }),
    prisma.reviewRun.count({ where: { repository: { organizationId: org.id }, createdAt: { gte: since7d } } }),
    prisma.visualSnapshot.count({
      where: { run: { suite: { organizationId: org.id }, createdAt: { gte: since7d } }, status: "failed" },
    }),
    prisma.syntheticTest.count({ where: { organizationId: org.id, enabled: true } }),
    prisma.reviewRun.findMany({
      where: { repository: { organizationId: org.id } },
      orderBy: { createdAt: "desc" },
      take: 8,
      include: { pullRequest: { include: { repository: { select: { fullName: true } } } } },
    }),
    prisma.alert.findMany({
      where: { organizationId: org.id, status: { in: ["open", "acknowledged"] } },
      orderBy: { createdAt: "desc" },
      take: 6,
    }),
    prisma.syntheticRun.findMany({
      where: { test: { organizationId: org.id } },
      orderBy: { createdAt: "desc" },
      take: 40,
      select: { status: true, testId: true },
    }),
  ]);

  const syntheticPassed = latestSyntheticRuns.filter((r) => r.status === "passed").length;
  const syntheticAvailability = latestSyntheticRuns.length
    ? Math.round((syntheticPassed / latestSyntheticRuns.length) * 100)
    : null;

  const anyConfigured = repoCount > 0 || syntheticTests > 0 || reviewRuns7d > 0;

  return (
    <div>
      <PageHeader
        title="Overview"
        description="What is happening across code review, user experience and production health."
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <MetricCard label="Repositories" value={repoCount} />
        <MetricCard label="Open PRs" value={openPrCount} />
        <MetricCard label="High-risk PRs" value={highRiskRuns.length} tone={highRiskRuns.length ? "failure" : "success"} />
        <MetricCard label="Reviews (7d)" value={reviewRuns7d} />
        <MetricCard label="Visual fails (7d)" value={visualFailures7d} tone={visualFailures7d ? "failure" : "success"} />
        <MetricCard
          label="Synthetic health"
          value={syntheticAvailability === null ? "—" : `${syntheticAvailability}%`}
          tone={syntheticAvailability !== null && syntheticAvailability < 95 ? "failure" : "success"}
          sub={syntheticTests ? `${syntheticTests} monitor${syntheticTests === 1 ? "" : "s"}` : "no monitors"}
        />
      </div>

      {!anyConfigured && <SetupNextSteps statuses={integrationStatuses()} />}

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Recent review runs" sub="Latest pull request reviews across all repositories" />
          {recentRuns.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <EmptyStateFlat
                title="No reviews yet"
                body={
                  <>
                    Reviews start from a GitHub webhook or a manual run.{" "}
                    {repoCount === 0
                      ? "Add a repository first — see Repositories."
                      : "Trigger a review from any pull request page."}
                  </>
                }
              />
            </div>
          ) : (
            <div className="divide-y divide-line">
              {recentRuns.map((run) => (
                <a key={run.id} href={`/pull-requests/${run.pullRequestId}`} className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-surface-2">
                  <div className="min-w-0">
                    <div className="truncate text-[13px]">
                      <Mono className="text-faint">{run.pullRequest.repository.fullName}</Mono>{" "}
                      <span className="text-accent-strong">#{run.pullRequest.number}</span> {run.pullRequest.title}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-faint">
                      <Mono>{run.headSha.slice(0, 7)}</Mono>
                      <span>{run.trigger}</span>
                      <time dateTime={run.createdAt.toISOString()}>{timeAgo(run.createdAt)}</time>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <RiskBadge level={run.riskLevel} />
                    <RunStatusBadge status={run.status} />
                  </div>
                </a>
              ))}
            </div>
          )}
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Active alerts" action={<a href="/alerts" className="text-xs text-accent-strong hover:underline">All</a>} />
            {openAlerts.length === 0 ? (
              <div className="px-4 py-8 text-center text-[13px] text-faint">No open alerts.</div>
            ) : (
              <div className="divide-y divide-line">
                {openAlerts.map((alert) => (
                  <div key={alert.id} className="px-4 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[13px]">{alert.title}</span>
                      <StatusBadge tone={alert.severity === "critical" ? "failure" : "warning"}>{alert.severity}</StatusBadge>
                    </div>
                    <div className="mt-0.5 text-[11px] text-faint">{timeAgo(alert.createdAt)}</div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="Synthetic monitors" sub="Latest outcomes across all monitors" action={<a href="/synthetic" className="text-xs text-accent-strong hover:underline">Open</a>} />
            <div className="px-4 py-4">
              {latestSyntheticRuns.length === 0 ? (
                <p className="text-[13px] text-faint">
                  No runs yet. Create a monitor to watch a critical user journey on a schedule.
                </p>
              ) : (
                <AvailabilityDots statuses={latestSyntheticRuns.map((r) => r.status)} />
              )}
            </div>
          </Card>
        </div>
      </div>

      {highRiskRuns.length > 0 ? (
        <Card className="mt-4">
          <CardHeader title="High-risk pull requests" sub="Open PRs whose latest review scored high or critical risk" />
          <div className="divide-y divide-line">
            {highRiskRuns.map((run) => (
              <a key={run.id} href={`/pull-requests/${run.pullRequest.id}`} className="flex items-center justify-between px-4 py-2.5 hover:bg-surface-2">
                <div className="min-w-0 truncate">
                  <Mono className="text-faint">{run.pullRequest.repository.fullName}</Mono>{" "}
                  <span className="text-accent-strong">#{run.pullRequest.number}</span> {run.pullRequest.title}
                </div>
                <RiskBadge level={run.riskLevel} />
              </a>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function EmptyStateFlat({ title, body }: { title: string; body: React.ReactNode }) {
  return (
    <div>
      <div className="text-sm font-semibold">{title}</div>
      <p className="mx-auto mt-1 max-w-md text-[13px] text-muted">{body}</p>
    </div>
  );
}

function SetupNextSteps({ statuses }: { statuses: ReturnType<typeof integrationStatuses> }) {
  const missing = statuses.filter((s) => s.required && !s.configured);
  return (
    <Card className="mt-4 border-accent/25 bg-accent-dim/40 px-5 py-4">
      <h3 className="text-[13px] font-semibold text-accent-strong">Get started</h3>
      <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-[13px] text-muted">
        <li>
          Start the infrastructure: <Mono>docker compose up -d</Mono> (PostgreSQL, Redis, MinIO)
        </li>
        <li>
          Apply the schema: <Mono>pnpm db:migrate</Mono>
        </li>
        <li>
          Connect GitHub (App for webhooks, or a token for manual runs) in{" "}
          <a href="/settings" className="text-accent-strong hover:underline">Settings</a>
        </li>
        <li>
          Add your first repository in{" "}
          <a href="/repositories" className="text-accent-strong hover:underline">Repositories</a>
        </li>
      </ol>
      {missing.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {missing.map((m) => (
            <StatusBadge key={m.id} tone="warning">missing: {m.missing.join(", ")}</StatusBadge>
          ))}
        </div>
      ) : null}
    </Card>
  );
}
