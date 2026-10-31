import { createHmac, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import IORedis, { type Redis } from "ioredis";
import { env } from "@/lib/env";
import { err } from "@/lib/errors";

export interface RateLimitPolicy {
  /** Namespaces independent limits, e.g. api-write or manual-review. */
  scope: string;
  limit: number;
  windowMs: number;
}

export interface SlidingWindowDecision {
  allowed: boolean;
  timestamps: number[];
  retryAfterMs: number;
  remaining: number;
}

const standardWindowMs = env.rateLimit.standardWindowSeconds * 1_000;
const expensiveWindowMs = env.rateLimit.expensiveWindowSeconds * 1_000;
const READ_POLICY: RateLimitPolicy = { scope: "api", limit: env.rateLimit.readPerMinute, windowMs: standardWindowMs };
const WRITE_POLICY: RateLimitPolicy = { scope: "api-write", limit: env.rateLimit.writePerMinute, windowMs: standardWindowMs };
const ANONYMOUS_POLICY: RateLimitPolicy = { scope: "api-anonymous", limit: env.rateLimit.anonymousPerMinute, windowMs: standardWindowMs };
const REDIS_TIMEOUT_MS = 4_000;
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
const mutatingMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** A rolling-window reference implementation shared by memory mode and tests. */
export function evaluateSlidingWindow(
  timestamps: number[],
  now: number,
  limit: number,
  windowMs: number,
): SlidingWindowDecision {
  const active = timestamps.filter((timestamp) => timestamp > now - windowMs).sort((a, b) => a - b);
  if (active.length >= limit) {
    return {
      allowed: false,
      timestamps: active,
      retryAfterMs: Math.max(1, active[0]! + windowMs - now),
      remaining: 0,
    };
  }
  active.push(now);
  return { allowed: true, timestamps: active, retryAfterMs: 0, remaining: limit - active.length };
}

/**
 * Resolve a client address only when the deployment explicitly trusts the
 * configured number of rightmost proxy hops. Otherwise all anonymous callers
 * share a coarse bucket rather than trusting attacker-supplied forwarding data.
 */
export function rateLimitClientIdentity(
  req: Pick<Request, "headers">,
  trustedProxyHops = env.rateLimit.trustedProxyHops,
): string {
  if (trustedProxyHops <= 0) return "unattributed";
  const chain = req.headers
    .get("x-forwarded-for")
    ?.split(",")
    .map((part) => part.trim());
  if (!chain?.length) return "unattributed";
  const clientIndex = chain.length - trustedProxyHops - 1;
  if (clientIndex < 0) return "unattributed";
  const address = chain[clientIndex];
  return address && isIP(address) ? `ip:${address.toLowerCase()}` : "unattributed";
}

const redisSlidingWindowScript = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local count = redis.call('ZCARD', KEYS[1])
if count >= limit then
  local first = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local retry = window
  if first[2] then retry = tonumber(first[2]) + window - now end
  return {0, count, math.max(1, retry)}
end
redis.call('ZADD', KEYS[1], now, member)
redis.call('PEXPIRE', KEYS[1], window)
return {1, count + 1, 0}
`;

const memoryWindows = new Map<string, number[]>();
let redisClient: Redis | null = null;

function keyFor(scope: string, identity: string): string {
  let secret: string;
  try {
    secret = env.rateLimit.keySecret;
  } catch {
    throw err.config("Rate limiting requires RATE_LIMIT_SECRET or AUTH_STATE_SECRET in production.", "RATE_LIMIT_SECRET_MISSING");
  }
  const mac = createHmac("sha256", secret)
    .update(`sentinelpr-rate-limit:v1:${scope}:${identity}`)
    .digest("hex");
  return `sentinelpr:ratelimit:v1:${mac}`;
}

function validatePolicy(policy: RateLimitPolicy): void {
  if (
    !/^[a-z0-9][a-z0-9:_-]{0,63}$/i.test(policy.scope) ||
    !Number.isSafeInteger(policy.limit) ||
    policy.limit < 1 ||
    !Number.isSafeInteger(policy.windowMs) ||
    policy.windowMs < 1_000 ||
    policy.windowMs > MAX_WINDOW_MS
  ) {
    throw err.internal("Invalid API rate-limit policy");
  }
}

function evaluateMemory(key: string, now: number, policy: RateLimitPolicy): SlidingWindowDecision {
  const decision = evaluateSlidingWindow(memoryWindows.get(key) ?? [], now, policy.limit, policy.windowMs);
  memoryWindows.set(key, decision.timestamps);
  if (memoryWindows.size > 20_000) {
    const oldestAllowed = now - MAX_WINDOW_MS;
    for (const [entryKey, timestamps] of memoryWindows) {
      const current = timestamps.filter((timestamp) => timestamp > oldestAllowed);
      if (current.length) memoryWindows.set(entryKey, current);
      else memoryWindows.delete(entryKey);
    }
  }
  return decision;
}

function getRedisClient(): Redis {
  if (!env.redisUrl) {
    throw err.infra("Rate limiting is temporarily unavailable.", "RATE_LIMIT_UNAVAILABLE");
  }
  if (redisClient?.status === "end") redisClient = null;
  if (!redisClient) {
    redisClient = new IORedis(env.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      enableReadyCheck: true,
      connectTimeout: REDIS_TIMEOUT_MS,
      retryStrategy: () => null,
    });
    redisClient.on("error", () => undefined);
  }
  return redisClient;
}

async function waitForRedis(client: Redis): Promise<void> {
  if (client.status === "ready") return;
  if (client.status === "wait") {
    await client.connect();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("timeout")), REDIS_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      client.off("ready", onReady);
      client.off("error", onError);
      client.off("end", onEnd);
    };
    const finish = (error?: Error) => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onReady = () => finish();
    const onError = () => finish(new Error("unavailable"));
    const onEnd = () => finish(new Error("closed"));
    client.once("ready", onReady);
    client.once("error", onError);
    client.once("end", onEnd);
  });
}

async function evaluateRedis(
  key: string,
  now: number,
  policy: RateLimitPolicy,
): Promise<SlidingWindowDecision> {
  const client = getRedisClient();
  try {
    await waitForRedis(client);
    const result = (await client.eval(
      redisSlidingWindowScript,
      1,
      key,
      now,
      policy.windowMs,
      policy.limit,
      `${now}:${randomUUID()}`,
    )) as Array<number | string>;
    const allowed = Number(result[0]) === 1;
    const count = Number(result[1]);
    const retryAfterMs = Math.max(0, Number(result[2]) || 0);
    return {
      allowed,
      timestamps: [],
      retryAfterMs,
      remaining: Math.max(0, policy.limit - count),
    };
  } catch {
    if (client.status === "end") redisClient = null;
    throw err.infra("Rate limiting is temporarily unavailable.", "RATE_LIMIT_UNAVAILABLE");
  }
}

export async function enforceRateLimit(
  _req: Request,
  policy: RateLimitPolicy,
  identity: string,
): Promise<void> {
  validatePolicy(policy);
  const key = keyFor(policy.scope, identity);
  const now = Date.now();
  const decision =
    process.env.NODE_ENV === "production"
      ? await evaluateRedis(key, now, policy)
      : evaluateMemory(key, now, policy);
  if (!decision.allowed) {
    throw err.apiRateLimit(policy.scope, Math.ceil(decision.retryAfterMs / 1000));
  }
}

export async function enforcePublicApiRateLimit(req: Request, policy: RateLimitPolicy): Promise<void> {
  await enforceRateLimit(req, policy, rateLimitClientIdentity(req));
}

export async function enforceAuthenticatedApiRateLimits(
  req: Request,
  identity: string,
  additionalPolicies: RateLimitPolicy[] = [],
): Promise<void> {
  await enforceRateLimit(req, READ_POLICY, identity);
  if (mutatingMethods.has(req.method.toUpperCase())) {
    await enforceRateLimit(req, WRITE_POLICY, identity);
  }
  for (const policy of additionalPolicies) {
    await enforceRateLimit(req, policy, identity);
  }
}

export const rateLimitPolicies = {
  anonymousApi: ANONYMOUS_POLICY,
  oauthStart: { scope: "oauth-start", limit: env.rateLimit.oauthPerWindow, windowMs: expensiveWindowMs } satisfies RateLimitPolicy,
  oauthCallback: { scope: "oauth-callback", limit: env.rateLimit.oauthPerWindow, windowMs: expensiveWindowMs } satisfies RateLimitPolicy,
  manualReview: { scope: "manual-review", limit: env.rateLimit.manualReviewPerWindow, windowMs: expensiveWindowMs } satisfies RateLimitPolicy,
  visualRun: { scope: "visual-run", limit: env.rateLimit.visualRunPerWindow, windowMs: expensiveWindowMs } satisfies RateLimitPolicy,
  syntheticRun: { scope: "synthetic-run", limit: env.rateLimit.syntheticRunPerWindow, windowMs: expensiveWindowMs } satisfies RateLimitPolicy,
  installationFlow: { scope: "installation-flow", limit: env.rateLimit.installationPerWindow, windowMs: expensiveWindowMs } satisfies RateLimitPolicy,
  accessRequest: { scope: "access-request", limit: env.rateLimit.accessRequestPerWindow, windowMs: expensiveWindowMs } satisfies RateLimitPolicy,
  artifactDownload: { scope: "artifact-download", limit: env.rateLimit.artifactDownloadPerMinute, windowMs: standardWindowMs } satisfies RateLimitPolicy,
};

/** Close the process-local Redis connection during tests and graceful shutdown. */
export async function closeRateLimitConnection(): Promise<void> {
  const client = redisClient;
  redisClient = null;
  if (!client) return;
  try {
    if (client.status === "ready") await client.quit();
    else client.disconnect();
  } catch {
    client.disconnect();
  }
}
