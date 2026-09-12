import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePageOrganization } from "@/lib/web/session";
import { signArtifactToken } from "@/lib/env";
import { formatDateTime, timeAgo, shortSha } from "@/lib/web/format";
import { PageHeader, Card, CardHeader, RunStatusBadge, Mono } from "@/components/primitives";
import { KeyValue } from "@/components/charts";
import { SnapshotViewer, type ViewerSnapshot } from "@/components/snapshot-viewer";
import { ApproveBaselineButton } from "@/components/forms";

export const dynamic = "force-dynamic";

/** Mint short-lived signed URLs — artifact bytes are never publicly readable. */
function artifactUrl(id: string | null | undefined): string | null {
  if (!id) return null;
  const token = signArtifactToken({ artifactId: id, exp: Date.now() + 2 * 3600 * 1000 });
  return `/api/artifacts/${id}?t=${token}`;
}

export default async function VisualRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const org = await requirePageOrganization();

  const run = await prisma.visualRun.findFirst({
    where: { id: runId, suite: { organizationId: org.id } },
    include: {
      suite: { select: { id: true, name: true, baseUrl: true } },
      test: { select: { id: true, name: true } },
      snapshots: {
        orderBy: { createdAt: "asc" },
        include: {
          test: { select: { name: true, threshold: true } },
          baseline: { select: { artifactId: true, version: true } },
        },
      },
    },
  });
  if (!run) notFound();

  const viewerSnapshots: ViewerSnapshot[] = run.snapshots.map((snap) => ({
    id: snap.id,
    title: `${snap.test.name} · ${snap.browser}/${snap.viewportLabel}`,
    status: snap.status,
    diffRatio: snap.diffRatio,
    threshold: snap.test.threshold,
    changedRegionCount: Array.isArray(snap.changedRegions) ? snap.changedRegions.length : 0,
    domChanges: Array.isArray(snap.domChanges)
      ? (snap.domChanges as Array<{ type: string; detail: string }>).map((c) => `${c.type}: ${c.detail}`)
      : [],
    baselineUrl: snap.baseline ? artifactUrl(snap.baseline.artifactId) : null,
    currentUrl: artifactUrl(snap.currentArtifactId),
    diffUrl: artifactUrl(snap.diffArtifactId),
  }));

  return (
    <div>
      <PageHeader
        title={`Visual run — ${run.suite.name}`}
        description={run.test ? `Single test: ${run.test.name}` : "Suite-wide run"}
      />

      <div className="grid gap-4 lg:grid-cols-4">
        <Card className="px-4 py-4">
          <h3 className="mb-3 text-[13px] font-semibold">Run</h3>
          <KeyValue
            rows={[
              ["Status", run.status],
              ["Trigger", run.trigger],
              ["Commit", shortSha(run.commitSha)],
              ["Started", formatDateTime(run.startedAt ?? run.createdAt)],
              ["Duration", run.completedAt && run.startedAt ? `${Math.round((run.completedAt.getTime() - run.startedAt.getTime()) / 100) / 10}s` : "—"],
              ["Worst Δ", run.diffRatio !== null && run.diffRatio !== undefined ? `${(run.diffRatio * 100).toFixed(2)}%` : "—"],
            ]}
          />
        </Card>
        <Card className="px-4 py-4 lg:col-span-2">
          <h3 className="mb-3 text-[13px] font-semibold">Snapshots ({run.snapshots.length})</h3>
          <div className="flex flex-wrap gap-2">
            {run.snapshots.map((snap) => (
              <span key={snap.id} className="flex items-center gap-1.5">
                <RunStatusBadge status={snap.status} />
                <Mono className="text-xs text-faint">{snap.test.name}/{snap.viewportLabel}</Mono>
              </span>
            ))}
          </div>
          {run.error ? <p className="mt-3 font-mono text-xs text-red-400">{run.error}</p> : null}
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader
          title="Comparison viewer"
          sub="Baselines are explicit and versioned — approving replaces the active baseline deliberately."
        />
        <SnapshotViewer snapshots={viewerSnapshots} />
        {run.snapshots.some((s) => s.status !== "passed") ? (
          <div className="flex flex-wrap gap-3 border-t border-line px-4 py-3">
            {run.snapshots
              .filter((s) => s.status !== "passed")
              .map((snap) => (
                <div key={snap.id} className="flex items-center gap-2">
                  <Mono className="text-xs text-faint">{snap.test.name}/{snap.browser}/{snap.viewportLabel}</Mono>
                  <ApproveBaselineButton snapshotId={snap.id} />
                </div>
              ))}
          </div>
        ) : null}
      </Card>

      <p className="mt-3 text-xs text-faint">
        Run created {timeAgo(run.createdAt)} · <a className="text-accent-strong hover:underline" href={`/visual/${run.suite.id}`}>back to suite</a>
      </p>
    </div>
  );
}
