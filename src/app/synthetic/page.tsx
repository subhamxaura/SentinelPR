import { prisma } from "@/lib/db";
import { requireOrganization } from "@/lib/web/session";
import { timeAgo } from "@/lib/web/format";
import { PageHeader, Card, RunStatusBadge, Mono } from "@/components/primitives";
import { EmptyState } from "@/components/states";
import { AvailabilityDots } from "@/components/charts";
import { CreateSyntheticTestForm } from "@/components/forms";

export const dynamic = "force-dynamic";

export default async function SyntheticPage() {
  const org = await requireOrganization();

  const tests = await prisma.syntheticTest.findMany({
    where: { organizationId: org.id },
    orderBy: { createdAt: "desc" },
    include: {
      schedule: { select: { cron: true, paused: true, timezone: true } },
      runs: { orderBy: { createdAt: "desc" }, take: 30, select: { status: true, durationMs: true, createdAt: true } },
    },
  });

  return (
    <div>
      <PageHeader
        title="Synthetic Monitoring"
        description="Scheduled user journeys against your deployed applications — the production-health signal."
      />

      <CreateSyntheticTestForm />

      {tests.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="No monitors yet">
            Monitors replay critical user journeys (login, search, checkout, API health) on a schedule and
            turn failures into alerts with latency percentiles and availability history.
          </EmptyState>
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {tests.map((test) => {
            const runs = test.runs;
            const passed = runs.filter((r) => r.status === "passed").length;
            const availability = runs.length ? Math.round((passed / runs.length) * 100) : null;
            const durations = runs.filter((r) => r.status === "passed" && r.durationMs).map((r) => r.durationMs as number);
            const p95 = durations.length ? Math.round(durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)]) : null;
            return (
              <Card key={test.id}>
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-3.5">
                  <div className="min-w-0">
                    <a href={`/synthetic/${test.id}`} className="text-[14px] font-semibold hover:text-accent-strong">
                      {test.name}
                    </a>
                    <div className="mt-0.5 truncate font-mono text-xs text-faint">{test.baseUrl}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Mono className="text-xs text-faint">
                      {test.schedule ? `${test.schedule.paused ? "paused" : "every"} ${test.schedule.cron}` : "manual only"}
                    </Mono>
                    <RunStatusBadge status={runs[0]?.status ?? "queued"} />
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="flex items-center gap-4">
                    <AvailabilityDots statuses={runs.map((r) => r.status)} />
                    <span className="text-xs text-faint">
                      {runs.length > 0 ? `${availability}% availability · P95 ${p95 ?? "—"}ms · last run ${timeAgo(runs[0].createdAt)}` : "no runs yet"}
                    </span>
                  </div>
                  <a href={`/synthetic/${test.id}`} className="text-xs text-accent-strong hover:underline">
                    Details →
                  </a>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
