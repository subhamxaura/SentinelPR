import { NextRequest, NextResponse } from "next/server";
import { requireOrganization, requireMutationRole } from "@/lib/web/session";
import { err } from "@/lib/errors";
import { apiError } from "@/lib/web/api";
import { appInstallationUrl } from "@/lib/github/client";
import { createInstallationState, setInstallationCookie } from "@/lib/github/installation-state";
import { rateLimitPolicies } from "@/lib/web/rate-limit";

export const dynamic = "force-dynamic";

/**
 * GET /api/installations/initiate
 *
 * Initiates an authenticated, cryptographically bound GitHub App installation flow.
 * Restricted to administrators/owners of the active organization.
 */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireOrganization(req, [rateLimitPolicies.installationFlow]);
    requireMutationRole(ctx, "POST");
    if (ctx.role === "member") {
      throw err.authz("Only administrators can connect GitHub App installations.");
    }

    const { state, nonce } = createInstallationState({
      organizationId: ctx.id,
      userId: ctx.user?.id ?? "unknown",
      action: "install",
    });

    const installUrl = appInstallationUrl(state);
    if (!installUrl) {
      return NextResponse.json(
        {
          error: {
            code: "GITHUB_NOT_CONFIGURED",
            message: "GitHub App is not configured.",
            category: "config",
          },
        },
        { status: 503 },
      );
    }

    const res = NextResponse.redirect(installUrl);
    setInstallationCookie(res, nonce);
    return res;
  } catch (e) {
    return apiError(e);
  }
}
