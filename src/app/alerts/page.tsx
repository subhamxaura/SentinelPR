import { prisma } from "@/lib/db";
import { requireOrganization } from "@/lib/web/session";
import { timeAgo, formatDateTime } from "@/lib/web/format";
import { PageHeader, Card, StatusBadge } from "@/components/primitives";
import { EmptyState } from "@/components/states";
import { AlertActions } from "@/components/forms";

export const dynamic = "force-dynamic";

export default async function AlertsPage() {
  const org = await requireOrganization();

  const alerts = await prisma.alert.findMany({
    where: { organizationId: org.id },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return (
    <div>
      <PageHeader
        title="Alerts"
        description="Security findings, high-risk PRs, visual regressions and synthetic failures."
      />
      {alerts.length === 0 ? (
        <EmptyState title="No alerts">
          Alerts are raised by real signals: high-risk reviews, security findings, visual regressions, and
          synthetic failures or threshold breaches. Nothing has fired yet.
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {alerts.map((alert) => (
            <Card key={alert.id} className="px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge tone={alert.severity === "critical" ? "failure" : alert.severity === "warning" ? "warning" : "neutral"}>
                      {alert.severity}
                    </StatusBadge>
                    <span className="text-[13px] font-medium">{alert.title}</span>
                    <StatusBadge tone={alert.status === "open" ? "failure" : alert.status === "acknowledged" ? "warning" : "success"}>
                      {alert.status}
                    </StatusBadge>
                  </div>
                  {alert.body ? <p className="mt-1.5 whitespace-pre-wrap text-[13px] text-muted">{alert.body}</p> : null}
                  <div className="mt-1 text-[11px] text-faint">
                    {alert.type} · {formatDateTime(alert.createdAt)} · {timeAgo(alert.createdAt)}
                    {alert.resolvedAt ? ` · resolved ${timeAgo(alert.resolvedAt)}` : ""}
                  </div>
                </div>
                <AlertActions alertId={alert.id} status={alert.status} />
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
