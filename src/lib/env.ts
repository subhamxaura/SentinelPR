// Central environment access + honest integration status reporting.
// Optional integrations (GitHub App, AI, S3) degrade gracefully; the dashboard
// surfaces exactly what is configured and what is missing.

import { createHmac, timingSafeEqual } from "node:crypto";

function str(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

export const env = {
  get databaseUrl(): string {
    return str("DATABASE_URL") ?? "";
  },
  get redisUrl(): string | undefined {
    return str("REDIS_URL");
  },
  get dashboardUrl(): string {
    return str("DASHBOARD_URL") ?? "http://localhost:3000";
  },
  get orgSlug(): string {
    return str("SENTINEL_ORG_SLUG") ?? "default";
  },
  get orgName(): string {
    return str("SENTINEL_ORG_NAME") ?? "Default Organization";
  },

  github: {
    get appId(): string | undefined {
      return str("GITHUB_APP_ID");
    },
    get appSlug(): string | undefined {
      return str("GITHUB_APP_SLUG");
    },
    /** PEM private key; accepts base64-encoded value to survive env-var escaping. */
    get privateKey(): string | undefined {
      const raw = str("GITHUB_APP_PRIVATE_KEY");
      if (!raw) return undefined;
      if (raw.includes("-----BEGIN")) return raw.replace(/\\n/g, "\n");
      try {
        const decoded = Buffer.from(raw, "base64").toString("utf8");
        if (decoded.includes("-----BEGIN")) return decoded;
      } catch {
        /* not base64 */
      }
      return raw;
    },
    get webhookSecret(): string | undefined {
      return str("GITHUB_WEBHOOK_SECRET");
    },
    get pat(): string | undefined {
      return str("GITHUB_TOKEN");
    },
  },

  ai: {
    get provider(): string | undefined {
      return str("AI_PROVIDER");
    },
    get apiKey(): string | undefined {
      return str("AI_API_KEY");
    },
    get baseUrl(): string {
      return str("AI_BASE_URL") ?? "https://api.openai.com/v1";
    },
    get model(): string {
      return str("AI_MODEL") ?? "gpt-4o-mini";
    },
    get confidenceThreshold(): number {
      const v = Number(str("AI_CONFIDENCE_THRESHOLD") ?? "0.6");
      return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.6;
    },
    get enabled(): boolean {
      return this.provider === "openai-compatible" && !!this.apiKey;
    },
  },

  storage: {
    get driver(): "local" | "s3" {
      return str("ARTIFACT_DRIVER") === "s3" ? "s3" : "local";
    },
    get localDir(): string {
      return str("ARTIFACT_LOCAL_DIR") ?? ".data/artifacts";
    },
    get s3(): {
      endpoint?: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
    } | null {
      const accessKeyId = str("S3_ACCESS_KEY_ID");
      const secretAccessKey = str("S3_SECRET_ACCESS_KEY");
      if (!accessKeyId || !secretAccessKey || !str("S3_BUCKET")) return null;
      return {
        endpoint: str("S3_ENDPOINT"),
        region: str("S3_REGION") ?? "us-east-1",
        bucket: str("S3_BUCKET")!,
        accessKeyId,
        secretAccessKey,
      };
    },
  },

  /** Artifact URL signing secret — stable fallback derived from DATABASE_URL. */
  get tokenSecret(): string {
    return str("ARTIFACT_TOKEN_SECRET") ?? `fallback:${str("DATABASE_URL") ?? "none"}`;
  },

  get allowPrivateTargets(): boolean {
    return str("SENTINEL_ALLOW_PRIVATE_TARGETS") === "1";
  },

  get alertWebhookUrl(): string | undefined {
    return str("ALERT_WEBHOOK_URL");
  },
};

export interface IntegrationStatus {
  id: string;
  label: string;
  configured: boolean;
  required: boolean;
  detail: string;
  missing: string[];
}

export function integrationStatuses(): IntegrationStatus[] {
  const gh = env.github;
  const appParts = [gh.appId, gh.privateKey, gh.webhookSecret];
  const s3 = env.storage.s3;
  return [
    {
      id: "database",
      label: "PostgreSQL",
      configured: !!env.databaseUrl,
      required: true,
      detail: "Durable state for PRs, runs, findings, baselines and history.",
      missing: env.databaseUrl ? [] : ["DATABASE_URL"],
    },
    {
      id: "redis",
      label: "Redis (queues)",
      configured: !!env.redisUrl,
      required: true,
      detail: "BullMQ queues, retries and synthetic job schedulers.",
      missing: env.redisUrl ? [] : ["REDIS_URL"],
    },
    {
      id: "github-app",
      label: "GitHub App",
      configured: appParts.every(Boolean),
      required: false,
      detail: "Webhook-driven PR review with check runs and inline comments.",
      missing: [
        !gh.appId && "GITHUB_APP_ID",
        !gh.privateKey && "GITHUB_APP_PRIVATE_KEY",
        !gh.webhookSecret && "GITHUB_WEBHOOK_SECRET",
      ].filter(Boolean) as string[],
    },
    {
      id: "github-pat",
      label: "GitHub token (fallback)",
      configured: !!gh.pat,
      required: false,
      detail: "Enables manual review runs for repositories not connected via the App.",
      missing: gh.pat ? [] : ["GITHUB_TOKEN"],
    },
    {
      id: "ai",
      label: "AI review model",
      configured: env.ai.enabled,
      required: false,
      detail: "Optional enhancement on top of the deterministic rule engine.",
      missing: env.ai.enabled
        ? []
        : ["AI_PROVIDER=openai-compatible", "AI_API_KEY"].filter((k) =>
            k === "AI_API_KEY" ? !env.ai.apiKey : !env.ai.enabled,
          ),
    },
    {
      id: "storage",
      label: env.storage.driver === "s3" ? "S3 artifact storage" : "Local artifact storage",
      configured: env.storage.driver === "local" ? true : !!s3,
      required: true,
      detail:
        env.storage.driver === "s3"
          ? "Screenshots, diffs, traces and logs in S3-compatible object storage."
          : "Screenshots and diffs stored on local disk (.data/artifacts). Use S3 in production.",
      missing: env.storage.driver === "s3" && !s3 ? ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] : [],
    },
  ];
}

export function signArtifactToken(payload: { artifactId: string; exp: number }): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", env.tokenSecret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyArtifactToken(token: string): { artifactId: string } | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", env.tokenSecret).update(body).digest("base64url");
  if (sig.length !== expected.length || !timingSafeEqualStr(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      artifactId: string;
      exp: number;
    };
    if (!payload.exp || Date.now() > payload.exp) return null;
    return { artifactId: payload.artifactId };
  } catch {
    return null;
  }
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
