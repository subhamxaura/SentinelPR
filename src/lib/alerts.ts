import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * In-app alerts with dedup, plus optional outgoing webhook fan-out.
 * The channel architecture is deliberately simple: raiseAlert() persists the
 * alert row; transport adapters (in-app always, webhook when configured) run
 * after the row exists so state never depends on delivery success.
 */

export type AlertType =
  | "high_risk_pr"
  | "security_finding"
  | "visual_regression"
  | "synthetic_failure"
  | "consecutive_failures"
  | "latency_threshold";

export interface RaiseAlertInput {
  organizationId: string;
  type: AlertType;
  severity: "info" | "warning" | "critical";
  title: string;
  body?: string;
  entityType?: string;
  entityId?: string;
  dedupKey?: string;
}

/** Dedup key is unique per org: an open duplicate alert is updated, not re-created. */
export async function raiseAlert(input: RaiseAlertInput): Promise<void> {
  const dedupKey = input.dedupKey ?? `${input.type}:${input.entityType ?? ""}:${input.entityId ?? ""}`;
  try {
    await prisma.alert.upsert({
      where: { organizationId_dedupKey: { organizationId: input.organizationId, dedupKey } },
      update: {
        severity: input.severity,
        title: input.title,
        body: input.body,
        status: "open",
        resolvedAt: null,
      },
      create: {
        organizationId: input.organizationId,
        type: input.type,
        severity: input.severity,
        title: input.title,
        body: input.body,
        entityType: input.entityType,
        entityId: input.entityId,
        dedupKey,
        channels: ["in_app", ...(env.alertWebhookUrl ? ["webhook"] : [])],
      },
    });
  } catch (e) {
    logger.error("Failed to persist alert", { error: e instanceof Error ? e.message : String(e) });
    return;
  }
  if (env.alertWebhookUrl) {
    void deliverWebhook(input);
  }
}

async function deliverWebhook(input: RaiseAlertInput): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    await fetch(env.alertWebhookUrl!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `SentinelPR ${input.severity}: ${input.title}`,
        alert: { ...input, dedupKey: input.dedupKey ?? `${input.type}:${input.entityType}:${input.entityId}` },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (e) {
    // Delivery failure never blocks the pipeline.
    logger.warn("Alert webhook delivery failed", { error: e instanceof Error ? e.message : String(e) });
  }
}

/** Resolve open alerts for an entity (e.g. synthetic test recovered). */
export async function resolveAlerts(organizationId: string, dedupKeyPrefix: string): Promise<void> {
  const open = await prisma.alert.findMany({
    where: {
      organizationId,
      status: "open",
      dedupKey: { startsWith: dedupKeyPrefix },
    },
    select: { id: true },
  });
  if (!open.length) return;
  await prisma.alert.updateMany({
    where: { id: { in: open.map((a) => a.id) } },
    data: { status: "resolved", resolvedAt: new Date() },
  });
}
