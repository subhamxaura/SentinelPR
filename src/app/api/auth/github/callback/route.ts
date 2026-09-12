import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { authMode } from "@/lib/auth/mode";
import { sanitizeRedirect, verifySignedState } from "@/lib/auth/crypto";
import { exchangeCodeForToken, fetchIdentity } from "@/lib/auth/github-oauth";
import { ensureMemberships, pickDefaultMembership, upsertUserFromIdentity } from "@/lib/auth/provisioning";
import { createSession } from "@/lib/auth/session-store";
import { logger } from "@/lib/logger";

const log = logger.child({ module: "auth/callback" });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/auth/github/callback?code=…&state=… — completes the OAuth flow. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    log.warn("OAuth sign-in refused at GitHub", { error: oauthError });
    return redirectToError(url.origin, oauthError === "access_denied" ? "Sign-in was cancelled." : "GitHub refused the sign-in.");
  }
  if (authMode() !== "oauth") return redirectToError(url.origin, "OAuth sign-in is not enabled on this deployment.");
  if (!code || !stateParam) return redirectToError(url.origin, "Missing code or state parameter.");

  const state = verifySignedState(stateParam);
  if (!state) return redirectToError(url.origin, "Sign-in link expired or invalid — start again.");

  try {
    const token = await exchangeCodeForToken(code);
    const identity = await fetchIdentity(token);
    const user = await upsertUserFromIdentity(identity);
    await ensureMemberships(user);

    const ipHash = req.headers.get("x-forwarded-for")
      ? createHash("sha256").update(req.headers.get("x-forwarded-for") as string).digest("hex")
      : null;
    await createSession({
      userId: user.id,
      userAgent: req.headers.get("user-agent"),
      ipAddressHash: ipHash,
    });

    log.info("User signed in", { user: user.id });
    return NextResponse.redirect(`${url.origin}${state.redirectTo}`);
  } catch (e) {
    log.error("OAuth callback failed", { error: e instanceof Error ? e.message : "unknown" });
    return redirectToError(url.origin, "Sign-in failed — please try again.");
  }
}

function redirectToError(origin: string, message: string): NextResponse {
  const params = new URLSearchParams({ error: message });
  return NextResponse.redirect(`${origin}/signin?${params.toString()}`);
}
