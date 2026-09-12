import { NextResponse } from "next/server";
import { authMode } from "@/lib/auth/mode";
import { buildAuthorizeUrl } from "@/lib/auth/github-oauth";
import { createSignedState, sanitizeRedirect } from "@/lib/auth/crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/auth/github?redirectTo=/visual — begins the GitHub OAuth flow. */
export async function GET(req: Request) {
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

  const { state } = createSignedState(redirectTo);
  return NextResponse.redirect(buildAuthorizeUrl(state));
}
