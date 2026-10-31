import { NextResponse } from "next/server";
import { authMode } from "@/lib/auth/mode";
import { buildAuthorizeUrl } from "@/lib/auth/github-oauth";
import { createSignedState, sanitizeRedirect } from "@/lib/auth/crypto";
import { setOAuthStateCookie } from "@/lib/auth/oauth-cookie";
import { apiError } from "@/lib/web/api";
import { enforcePublicApiRateLimit, rateLimitPolicies } from "@/lib/web/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/auth/github?redirectTo=/visual — begins the GitHub OAuth flow. */
export async function GET(req: Request) {
  try {
    await enforcePublicApiRateLimit(req, rateLimitPolicies.oauthStart);
  } catch (e) {
    return apiError(e);
  }
  if (authMode() !== "oauth") {
    return NextResponse.json(
      {
        error: {
          code: "OAUTH_DISABLED",
          message: "OAuth sign-in is not enabled on this deployment.",
          category: "config",
          retryable: false,
        },
      },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const redirectTo = sanitizeRedirect(url.searchParams.get("redirectTo"));

  const { state, nonce } = createSignedState(redirectTo);
  const response = NextResponse.redirect(buildAuthorizeUrl(state));
  setOAuthStateCookie(response, nonce);
  return response;
}
