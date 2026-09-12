import { createHmac, timingSafeEqual } from "node:crypto";
import { err } from "@/lib/errors";

/**
 * GitHub webhook signature validation (X-Hub-Signature-256).
 * Constant-time comparison; raw request body must be the exact bytes received.
 */
export function verifyWebhookSignature(
  rawBody: Buffer | string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmacHex(secret, rawBody);
  const received = signatureHeader.slice("sha256=".length);
  if (received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(received, "hex"), Buffer.from(expected, "hex"));
}

function createHmacHex(secret: string, body: Buffer | string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export interface ParsedWebhookEvent {
  event: string;
  action: string | null;
  deliveryId: string;
  installationId: number | null;
  repository: { id: number; fullName: string; private: boolean; defaultBranch?: string | null } | null;
  pullRequest: {
    number: number;
    id: number;
    title: string;
    state: string;
    draft: boolean;
    headSha: string;
    headRef: string | null;
    baseRef: string | null;
    authorLogin: string | null;
    authorAvatar: string | null;
    additions: number | null;
    deletions: number | null;
    changedFiles: number | null;
    url: string | null;
  } | null;
}

const ACTION_BLACKLIST = new Set(["assigned", "unassigned", "labeled", "unlabeled", "milestoned", "demilestoned"]);

/** Extract the minimal typed shape we act on. Unknown payloads parse to a safe skeleton. */
export function parseWebhookEvent(headers: Record<string, string | undefined>, payload: unknown): ParsedWebhookEvent {
  const event = headers["x-github-event"] ?? "unknown";
  const deliveryId = headers["x-github-delivery"] ?? "";
  if (!deliveryId) throw err.github("Missing X-GitHub-Delivery header", 400);

  const body = (payload ?? {}) as Record<string, unknown>;
  const action = typeof body.action === "string" ? body.action : null;

  const repoRaw = body.repository as Record<string, unknown> | undefined;
  const repository = repoRaw
    ? {
        id: Number(repoRaw.id),
        fullName: String(repoRaw.full_name ?? ""),
        private: Boolean(repoRaw.private),
        defaultBranch: (repoRaw.default_branch as string | undefined) ?? null,
      }
    : null;

  const installationRaw = body.installation as Record<string, unknown> | undefined;
  const installationId = installationRaw ? Number(installationRaw.id) : null;

  let pullRequest: ParsedWebhookEvent["pullRequest"] = null;
  const prRaw = (body.pull_request ?? null) as Record<string, unknown> | null;
  if (prRaw) {
    const head = (prRaw.head ?? {}) as Record<string, unknown>;
    const base = (prRaw.base ?? {}) as Record<string, unknown>;
    const user = (prRaw.user ?? {}) as Record<string, unknown>;
    pullRequest = {
      number: Number(prRaw.number),
      id: Number(prRaw.id ?? 0),
      title: String(prRaw.title ?? ""),
      state: String(prRaw.state ?? "open"),
      draft: Boolean(prRaw.draft),
      headSha: String(head.sha ?? ""),
      headRef: (head.ref as string | undefined) ?? null,
      baseRef: (base.ref as string | undefined) ?? null,
      authorLogin: (user.login as string | undefined) ?? null,
      authorAvatar: (user.avatar_url as string | undefined) ?? null,
      additions: (prRaw.additions as number | undefined) ?? null,
      deletions: (prRaw.deletions as number | undefined) ?? null,
      changedFiles: (prRaw.changed_files as number | undefined) ?? null,
      url: (prRaw.html_url as string | undefined) ?? null,
    };
  }

  return { event, action, deliveryId, installationId, repository, pullRequest };
}

/** Events we spend review capacity on — anything else is acknowledged and skipped. */
export function shouldReviewPullRequest(event: string, action: string | null, pr: { draft: boolean } | null): boolean {
  if (event !== "pull_request" || !pr) return false;
  if (!action || ACTION_BLACKLIST.has(action)) return false;
  if (["closed", "converted_to_draft"].includes(action)) return false;
  if (pr.draft && action !== "ready_for_review") return false;
  return ["opened", "synchronize", "reopened", "ready_for_review"].includes(action);
}
