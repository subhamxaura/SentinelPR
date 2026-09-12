import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireOrganization } from "@/lib/web/session";
import { timeAgo, formatDateTime, formatDuration } from "@/lib/web/format";
import { PageHeader, Card, CardHeader, RunStatusBadge, Mono, MetricCard } from "@/components/primitives";
import { LatencyBars, KeyValue, AvailabilityDots } from "@/components/charts";
import { computeMetrics } from "@/lib/synth/metrics";
import { RunNowButton, PauseResumeButton, DeleteTestButton } from "@/components/forms";
import type { SyntheticStep } from "@/lib/synth/steps";

export const dynamic = "force-dynamic";

export default async function SyntheticTestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const org = await requireOrganization();

  const test = await prisma.syntheticTest.findFirst({
    where: { id, organizationId: org.id },
    include: {
      schedule: true,
      runs: { orderBy: { createdAt: "desc" }, take: 40 },
    },
  });
  if (!test) notFound();

  const runs = test.runs;
  const metrics = computeMetrics(runs.map((r) => ({ status: r.status, durationMs: r.durationMs })));
  const steps = (Array.isArray(test.steps) ? test.steps : []) as SyntheticStep[];
  const selectedRun = runs[0] ?? null;
  const selectedSteps = selectedRun
    ? await prisma.syntheticStepResult.findMany({ where: { runId: selectedRun.id }, orderBy: { index: "asc" } })
    : [];

  return (
    <div>
      <PageHeader
        title={test.name}
        description={test.baseUrl}
        actions={
          <>
            <RunNowButton testId={test.id} />
            {test.schedule ? <PauseResumeButton testId={test.id} paused={test.schedule.paused} /> : null}
            <DeleteTestButton testId={test.id} kind="synthetic" />
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <MetricCard
          label="Availability"
          value={`${Math.round(metrics.availability * 100)}%`}
          tone={metrics.availability < 0.95 && metrics.total > 0 ? "failure" : "success"}
          sub={`${metrics.passed}/${metrics.total} runs`}
        />
        <MetricCard label="P50" value={metrics.p50Ms !== null ? `${metrics.p50Ms}ms` : "—"} />
        <MetricCard label="P95" value={metrics.p95Ms !== null ? `${metrics.p95Ms}ms` : "—"} tone={test.alertLatencyMs && metrics.p95Ms !== null && metrics.p95Ms > test.alertLatencyMs ? "warning" : undefined} />
        <MetricCard label="Consecutive fails" value={metrics.consecutiveFailures} tone={metrics.consecutiveFailures > 0 ? "failure" : "success"} sub={`alert at ${test.maxConsecutiveFailures}`} />
        <MetricCard label="Schedule" value={test.schedule ? (test.schedule.paused ? "paused" : "active") : "manual"} sub={test.schedule?.cron} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="px-4 py-4">
          <h3 className="mb-3 text-[13px] font-semibold">Configuration</h3>
          <KeyValue
            rows={[
              ["Base URL", test.baseUrl],
              ["Enabled", String(test.enabled)],
              ["Latency alert", test.alertLatencyMs ? `${test.alertLatencyMs}ms (P95)` : "off"],
              ["Cron", test.schedule ? `${test.schedule.cron} (${test.schedule.timezone})` : "—"],
              ["Last enqueued", test.schedule?.lastEnqueuedAt ? timeAgo(test.schedule.lastEnqueuedAt) : "—"],
              ["Created", timeAgo(test.createdAt)],
            ]}
          />
        </Card>

        <Card className="px-4 py-4 lg:col-span-2">
          <h3 className="mb-3 text-[13px] font-semibold">Journey steps ({steps.length})</h3>
          <ol className="space-y-1.5">
            {steps.map((step, i) => (
              <li key={i} className="flex items-center gap-2 font-mono text-xs">
                <span className="w-6 text-right text-faint">{i + 1}</span>
                <span className="rounded bg-surface-2 px-1.5 py-0.5 text-accent-strong">{step.type}</span>
                <span className="truncate text-muted">
                  {"url" in step ? step.url : "selector" in step ? step.selector : "key" in step ? step.key : step.name ?? ""}
                </span>
              </li>
            ))}
          </ol>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="px-4 py-4">
          <h3 className="mb-3 text-[13px] font-semibold">Latency (passed runs)</h3>
          <LatencyBars values={runs.filter((r) => r.status === "passed" && r.durationMs).slice(0, 30).map((r) => r.durationMs as number).reverse()} />
          <div className="mt-2">
            <AvailabilityDots statuses={runs.map((r) => r.status)} />
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="Run history" sub="Most recent first — click a run to see its steps below" />
          {runs.length === 0 ? (
            <div className="px-4 py-8 text-center text-[13px] text-faint">No runs yet. Use “Run now” or wait for the schedule.</div>
          ) : (
            <div className="max-h-72 divide-y divide-line overflow-y-auto">
              {runs.map((run) => (
                <div key={run.id} className="flex items-center justify-between px-4 py-2 text-[13px]">
                  <span className="flex items-center gap-2">
                    <RunStatusBadge status={run.status} />
                    <Mono className="text-faint">{formatDateTime(run.createdAt)}</Mono>
                    {run.failedStepIndex !== null ? <span className="text-xs text-red-400">step {run.failedStepIndex + 1}</span> : null}
                  </span>
                  <span className="flex items-center gap-3 text-xs text-faint">
                    <span>{run.trigger}</span>
                    <span>{formatDuration(run.durationMs)}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {selectedRun ? (
        <Card className="mt-4">
          <CardHeader
            title={`Latest run steps — ${selectedRun.status}`}
            sub={`${formatDateTime(selectedRun.createdAt)} · ${formatDuration(selectedRun.durationMs)}`}
          />
          <div className="divide-y divide-line">
            {selectedSteps.map((step) => (
              <div key={step.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[13px]">
                <span className="flex items-center gap-2">
                  <RunStatusBadge status={step.status} />
                  <Mono className="text-xs">
                    {step.index + 1}. {step.type}
                    {step.name ? ` (${step.name})` : ""}
                  </Mono>
                </span>
                <span className="flex items-center gap-3 text-xs text-faint">
                  {step.durationMs !== null ? <span>{formatDuration(step.durationMs)}</span> : null}
                  {step.error ? <span className="max-w-md truncate font-mono text-red-400">{step.error}</span> : null}
                </span>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
