import { prisma } from "@/lib/db";
import { requireOrganization } from "@/lib/web/session";
import { timeAgo } from "@/lib/web/format";
import { PageHeader, Card, RunStatusBadge, Button } from "@/components/primitives";
import { EmptyState } from "@/components/states";
import { CreateSuiteForm } from "@/components/forms";

export const dynamic = "force-dynamic";

export default async function VisualPage() {
  const org = await requireOrganization();

  const suites = await prisma.visualSuite.findMany({
    where: { organizationId: org.id },
    orderBy: { createdAt: "desc" },
    include: {
      tests: { select: { id: true, enabled: true, name: true } },
      runs: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, status: true, createdAt: true } },
    },
  });

  return (
    <div>
      <PageHeader
        title="Visual Regression"
        description="Pixel and DOM-level comparison of real pages against explicit, versioned baselines."
      />

      <CreateSuiteForm />

      {suites.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="No visual suites yet">
            A suite points at a running web app (local, preview deployment, or production URL) and holds the
            pages you want to watch. Run it once to capture first-candidates, approve them as baselines, and
            every later run is compared against them.
          </EmptyState>
        </div>
      ) : (
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {suites.map((suite) => {
            const lastRun = suite.runs[0];
            const enabledTests = suite.tests.filter((t) => t.enabled).length;
            return (
              <Card key={suite.id}>
                <div className="flex items-start justify-between px-4 pt-3.5">
                  <div className="min-w-0">
                    <a href={`/visual/${suite.id}`} className="text-[14px] font-semibold hover:text-accent-strong">
                      {suite.name}
                    </a>
                    <div className="mt-0.5 truncate font-mono text-xs text-faint">{suite.baseUrl}</div>
                  </div>
                  <RunStatusBadge status={lastRun?.status ?? "queued"} />
                </div>
                <div className="flex items-center justify-between px-4 py-3 text-xs text-faint">
                  <span>
                    {enabledTests} enabled test{enabledTests === 1 ? "" : "s"} · {suite.tests.length} total
                  </span>
                  <span>{lastRun ? `last run ${timeAgo(lastRun.createdAt)}` : "never run"}</span>
                </div>
                <div className="flex gap-2 border-t border-line px-4 py-2.5">
                  <a href={`/visual/${suite.id}`}>
                    <Button variant="secondary">Open suite</Button>
                  </a>
                  {lastRun ? (
                    <a href={`/visual/runs/${lastRun.id}`}>
                      <Button variant="ghost">Latest run →</Button>
                    </a>
                  ) : null}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
