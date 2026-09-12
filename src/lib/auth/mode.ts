import { env } from "@/lib/env";

/**
 * Authentication mode resolution.
 *
 * - "local": single trusted operator; resolveOrganization() bootstraps one org.
 * - "oauth": GitHub OAuth sign-in, database-backed sessions, multi-tenant.
 *
 * SENTINEL_AUTH_MODE pins a mode. Unset = auto: oauth when GitHub OAuth client
 * credentials exist, otherwise local — so existing deployments keep working
 * until the operator opts in. Documented in docs/security-model.md.
 */
export type AuthMode = "oauth" | "local";

export function authMode(): AuthMode {
  return env.auth.configuredMode ?? (env.auth.oauthReady ? "oauth" : "local");
}

export function oauthEnabled(): boolean {
  return authMode() === "oauth";
}
