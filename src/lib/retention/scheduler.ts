import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { getQueueConnection } from "@/lib/queue";
import { logger } from "@/lib/logger";
import { runRetention } from "./service";

const log = logger.child({ module: "retention-scheduler" });
const LEASE_KEY = "sentinelpr:maintenance:retention-lease";
const LEASE_TTL_MS = 60 * 60 * 1_000;
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

async function runWithLease(): Promise<void> {
  if (!env.retention.enabled) return;
  const redis = getQueueConnection();
  const token = randomUUID();
  const acquired = await redis.set(LEASE_KEY, token, "PX", LEASE_TTL_MS, "NX");
  if (acquired !== "OK") return;

  try {
    const report = await runRetention();
    if (!report.skipped) log.info("Retention pass finished", report as unknown as Record<string, unknown>);
  } catch (error) {
    log.error("Retention pass failed", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
  } finally {
    await redis.eval(RELEASE_SCRIPT, 1, LEASE_KEY, token).catch(() => undefined);
  }
}

/** Start opt-in recurring retention; Redis SET NX serializes all worker replicas. */
export function startRetentionScheduler(): () => Promise<void> {
  if (!env.retention.enabled) {
    log.info("Retention scheduler is disabled; set RETENTION_ENABLED=1 to enable");
    return async () => undefined;
  }

  let current: Promise<void> | null = null;
  const tick = () => {
    if (current) return;
    current = runWithLease()
      .catch((error) => {
        log.error("Retention scheduler tick failed", {
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
      })
      .finally(() => { current = null; });
  };

  const initial = setTimeout(tick, 60_000);
  const interval = setInterval(tick, env.retention.intervalHours * 60 * 60 * 1_000);
  initial.unref();
  interval.unref();

  return async () => {
    clearTimeout(initial);
    clearInterval(interval);
    await current;
  };
}
