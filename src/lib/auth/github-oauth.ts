/**
 * Minimal GitHub OAuth app client (authorization-code flow).
 *
 * Dependencies intentionally avoided: the flow is three HTTP calls, and the
 * project keeps its dependency surface small and strictly typed.
 * Callback URL must be registered as `{DASHBOARD_URL}/api/auth/github/callback`.
 */
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

const log = logger.child({ module: "auth/github-oauth" });

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const EMAILS_URL = "https://api.github.com/user/emails";

export interface GitHubIdentity {
  githubId: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  /** Primary, verified email when available. */
  email: string;
}

export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.auth.githubClientId ?? "",
    redirect_uri: `${env.dashboardUrl}/api/auth/github/callback`,
    scope: "read:user user:email",
    state,
    allow_signup: "true",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

export async function exchangeCodeForToken(code: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_id: env.auth.githubClientId,
      client_secret: env.auth.githubClientSecret,
      code,
      redirect_uri: `${env.dashboardUrl}/api/auth/github/callback`,
    }),
    // Never let a hung GitHub stall sign-in indefinitely.
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => null)) as TokenResponse | null;
  if (!res.ok || !body?.access_token) {
    log.warn("OAuth token exchange failed", { status: res.status, error: body?.error ?? "unknown" });
    throw new Error(body?.error_description ?? body?.error ?? `token exchange failed (${res.status})`);
  }
  return body.access_token;
}

interface GitHubUserApi {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
}

export async function fetchIdentity(accessToken: string): Promise<GitHubIdentity> {
  const headers = {
    authorization: `Bearer ${accessToken}`,
    accept: "application/vnd.github+json",
    "user-agent": "SentinelPR",
  };
  const userRes = await fetch(USER_URL, { headers, signal: AbortSignal.timeout(10_000) });
  if (!userRes.ok) throw new Error(`GitHub /user failed (${userRes.status})`);
  const user = (await userRes.json()) as GitHubUserApi;

  // Identity uses GitHub's verified primary email only. /user.email may be a
  // stale or unverified public profile value and must not merge local accounts.
  let email: string | null = null;
  const emailsRes = await fetch(EMAILS_URL, { headers, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (emailsRes?.ok) {
    const emails = (await emailsRes.json().catch(() => null)) as Array<{ email?: string; primary?: boolean; verified?: boolean }> | null;
    email = emails?.find((e) => e.primary === true && e.verified === true && typeof e.email === "string")?.email ?? null;
  }
  if (!email) email = `${user.id}+${user.login}@users.noreply.github.com`;

  return {
    githubId: user.id,
    login: user.login,
    name: user.name,
    avatarUrl: user.avatar_url,
    email: email.toLowerCase(),
  };
}
