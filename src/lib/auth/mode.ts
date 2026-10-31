import { env } from "@/lib/env";

/**
 * Authentication mode resolution.
 *
 * - "local": single trusted operator; resolveOrganization() bootstraps one org.
 * - "oauth": GitHub OAuth sign-in, database-backed sessions, multi-tenant.
 *
 * SENTINEL_AUTH_MODE can pin a mode in development. Unset = OAuth when GitHub
 * OAuth credentials exist, otherwise local in development only. Production
 * requires OAuth credentials and never falls back to unauthenticated local mode.
 */
export type AuthMode = "oauth" | "local";

export function authMode(): AuthMode {
  if (process.env.NODE_ENV === "production") {
    if (!env.auth.oauthReady || env.auth.configuredMode === "local") {
      throw new Error(
        "Production authentication requires GitHub OAuth credentials and cannot use SENTINEL_AUTH_MODE=local. " +
        "Unauthenticated local mode is development-only.",
      );
    }
    return "oauth";
  }
  return env.auth.configuredMode ?? (env.auth.oauthReady ? "oauth" : "local");
}

export function oauthEnabled(): boolean {
  return authMode() === "oauth";
}
