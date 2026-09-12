import { prisma } from "@/lib/db";
import { requireOrganization } from "@/lib/web/session";
import { integrationStatuses, env } from "@/lib/env";
import { PageHeader, Card, CardHeader, StatusBadge, Mono } from "@/components/primitives";
import { formatDateTime } from "@/lib/web/format";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const org = await requireOrganization();
  const statuses = integrationStatuses();

  const [jobCounts, recentDeliveries, queueState] = await Promise.all([
    prisma.jobRecord.groupBy({ by: ["queue", "status"], _count: true }),
    prisma.webhookDelivery.findMany({ orderBy: { createdAt: "desc" }, take: 10 }),
    redisProbe(),
  ]);

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Honest configuration state: what is connected, what is missing, and what each piece needs."
      />

      <div className="grid gap-4 md:grid-cols-2">
        {statuses.map((status) => (
          <Card key={status.id} className="px-4 py-3.5">
            <div className="flex items-center justify-between">
              <h3 className="text-[13px] font-semibold">{status.label}</h3>
              <StatusBadge tone={status.configured ? "success" : status.required ? "failure" : "warning"}>
                {status.configured ? "configured" : status.required ? "missing (required)" : "not configured"}
              </StatusBadge>
            </div>
            <p className="mt-1 text-[13px] text-muted">{status.detail}</p>
            {status.missing.length > 0 ? (
              <div className="mt-2 space-y-0.5">
                {status.missing.map((m) => (
                  <Mono key={m} className="block text-xs text-amber-400">{m}</Mono>
                ))}
              </div>
            ) : null}
          </Card>
        ))}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Worker / queue state" sub="Live Redis probe + job history from real executions" />
          <div className="px-4 py-3">
            <div className="flex items-center gap-2 text-[13px]">
              <StatusBadge tone={queueState.reachable ? "success" : "failure"}>
                {queueState.reachable ? "Redis reachable" : "Redis unreachable"}
              </StatusBadge>
              {!queueState.reachable ? (
                <Mono className="text-xs text-faint">start with: docker compose up -d redis</Mono>
              ) : null}
            </div>
            <div className="mt-3 space-y-1">
              {jobCounts.length === 0 ? (
                <p className="text-[13px] text-faint">No jobs recorded yet.</p>
              ) : (
                jobCounts.map((row) => (
                  <div key={`${row.queue}-${row.status}`} className="flex items-center justify-between font-mono text-xs">
                    <span className="text-muted">{row.queue} · {row.status}</span>
                    <span className="text-text">{row._count}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Recent webhook deliveries" sub="Idempotency ledger — one row per GitHub delivery id" />
          {recentDeliveries.length === 0 ? (
            <div className="px-4 py-8 text-center text-[13px] text-faint">
              No deliveries received. Point the GitHub App webhook at{" "}
              <Mono>{env.dashboardUrl}/api/github/webhook</Mono>
            </div>
          ) : (
            <div className="divide-y divide-line">
              {recentDeliveries.map((d) => (
                <div key={d.id} className="flex items-center justify-between px-4 py-2 text-[13px]">
                  <span className="flex min-w-0 items-center gap-2">
                    <StatusBadge tone={d.status === "processed" ? "success" : d.status === "failed" ? "failure" : "pending"}>
                      {d.status}
                    </StatusBadge>
                    <Mono className="truncate text-xs">{d.event}{d.action ? `.${d.action}` : ""}</Mono>
                  </span>
                  <span className="shrink-0 text-[11px] text-faint">{formatDateTime(d.createdAt)}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader title="Webhook endpoint" sub="Configure this URL on the GitHub App" />
        <div className="px-4 py-3">
          <Mono className="text-xs">{env.dashboardUrl}/api/github/webhook</Mono>
          <p className="mt-2 text-[13px] text-muted">
            Events: <Mono className="text-xs">pull_request</Mono>, <Mono className="text-xs">installation</Mono>,{" "}
            <Mono className="text-xs">installation_repositories</Mono>. Signature validation (X-Hub-Signature-256)
            is enforced; deliveries are deduplicated by delivery id.
          </p>
        </div>
      </Card>

      <p className="mt-4 text-xs text-faint">
        Organization: {org.name} (<Mono>{org.slug}</Mono>) — local single-tenant mode; see docs/security-model.md.
      </p>
    </div>
  );
}

async function redisProbe(): Promise<{ reachable: boolean }> {
  if (!env.redisUrl) return { reachable: false };
  try {
    const { getQueueConnection } = await import("@/lib/queue");
    const conn = getQueueConnection();
    const pong = await Promise.race([conn.ping(), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 1500))]);
    return { reachable: pong === "PONG" };
  } catch {
    return { reachable: false };
  }
}
