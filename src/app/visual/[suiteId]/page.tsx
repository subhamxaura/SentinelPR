import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireOrganization } from "@/lib/web/session";
import { timeAgo } from "@/lib/web/format";
import { PageHeader, Card, CardHeader, RunStatusBadge, Mono } from "@/components/primitives";
import { KeyValue } from "@/components/charts";
import { CreateTestForm, RunVisualButton, DeleteTestButton } from "@/components/forms";

export const dynamic = "force-dynamic";

export default async function VisualSuitePage({ params }: { params: Promise<{ suiteId: string }> }) {
  const { suiteId } = await params;
  const org = await requireOrganization();

  const suite = await prisma.visualSuite.findFirst({
    where: { id: suiteId, organizationId: org.id },
    include: {
      tests: { orderBy: { createdAt: "asc" }, include: { baselines: { select: { version: true, browser: true, viewportLabel: true, active: true } } } },
      runs: { orderBy: { createdAt: "desc" }, take: 15 },
    },
  });
  if (!suite) notFound();

  return (
    <div>
      <PageHeader
        title={suite.name}
        description={suite.baseUrl}
        actions={<RunVisualButton suiteId={suite.id} label="Run suite" />}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="px-4 py-4">
          <h3 className="mb-3 text-[13px] font-semibold">Suite</h3>
          <KeyValue
            rows={[
              ["Base URL", suite.baseUrl],
              ["Readiness", `${suite.readinessPath} (${suite.readinessTimeoutMs / 1000}s)`],
              ["Tests", String(suite.tests.length)],
              ["Created", timeAgo(suite.createdAt)],
            ]}
          />
          <div className="mt-3">
            <DeleteTestButton testId={suite.id} kind="visual" />
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="Tests" sub="Each test captures every browser × viewport combination" />
          {suite.tests.length === 0 ? (
            <div className="px-4 py-8 text-center text-[13px] text-faint">No tests yet — add the first page to watch.</div>
          ) : (
            <div className="divide-y divide-line">
              {suite.tests.map((test) => {
                const activeBaselines = test.baselines.filter((b) => b.active);
                return (
                  <div key={test.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                    <div>
                      <div className="text-[13px] font-medium">
                        {test.name} {!test.enabled ? <span className="text-faint">(disabled)</span> : null}
                      </div>
                      <div className="mt-0.5 font-mono text-xs text-faint">
                        {test.path} · threshold {(test.threshold * 100).toFixed(1)}% ·{" "}
                        {activeBaselines.length > 0
                          ? activeBaselines.map((b) => `${b.browser}/${b.viewportLabel} v${b.version}`).join(", ")
                          : "no baseline yet"}
                      </div>
                    </div>
                    <RunVisualButton suiteId={suite.id} testId={test.id} label="Run" />
                  </div>
                );
              })}
            </div>
          )}
          <div className="border-t border-line">
            <CreateTestForm suiteId={suite.id} />
          </div>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader title="Run history" />
        {suite.runs.length === 0 ? (
          <div className="px-4 py-8 text-center text-[13px] text-faint">
            Never run. Start the first run to capture baseline candidates.
          </div>
        ) : (
          <div className="divide-y divide-line">
            {suite.runs.map((run) => (
              <a key={run.id} href={`/visual/runs/${run.id}`} className="flex items-center justify-between px-4 py-2.5 text-[13px] hover:bg-surface-2">
                <span className="flex items-center gap-2">
                  <RunStatusBadge status={run.status} />
                  <Mono className="text-faint">{run.id.slice(-8)}</Mono>
                  <span className="text-faint">{run.trigger}</span>
                </span>
                <span className="text-xs text-faint">{timeAgo(run.createdAt)}</span>
              </a>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
