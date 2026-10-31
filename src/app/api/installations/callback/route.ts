import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireOrganization, requireMutationRole, recordAudit, actorFor } from "@/lib/web/session";
import { err, toAppError } from "@/lib/errors";
import { listInstallationRepositories, getInstallationDetails } from "@/lib/github/client";
import { registerRepository } from "@/lib/repositories/registration";
import {
  verifyInstallationState,
  consumeInstallationNonce,
  verifyNonceMatches,
  clearInstallationCookie,
  INSTALLATION_STATE_COOKIE,
} from "@/lib/github/installation-state";
import { logger } from "@/lib/logger";
import { rateLimitPolicies } from "@/lib/web/rate-limit";

const log = logger.child({ module: "installations/callback" });

export const dynamic = "force-dynamic";

/**
 * GET /api/installations/callback
 *
 * GitHub redirects here after an admin installs the GitHub App.
 * Verifies signed state, session ownership, single-use nonce, and GitHub API identity.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const installationIdStr = url.searchParams.get("installation_id");
  const stateParam = url.searchParams.get("state");

  const errorRedirect = (msg: string) => {
    const res = NextResponse.redirect(`${url.origin}/repositories?error=${encodeURIComponent(msg)}`);
    clearInstallationCookie(res);
    return res;
  };

  if (!installationIdStr || !stateParam) {
    return errorRedirect("Missing installation_id or state parameter.");
  }

  const installationId = parseInt(installationIdStr, 10);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    return errorRedirect("Invalid installation_id parameter.");
  }

  try {
    const ctx = await requireOrganization(req, [rateLimitPolicies.installationFlow]);
    requireMutationRole(ctx, "POST");
    if (ctx.role === "member") {
      throw err.authz("Only administrators can complete GitHub App installations.");
    }

    // 1. Verify state signature and bound org
    const verified = verifyInstallationState(stateParam, {
      organizationId: ctx.id,
      userId: ctx.user?.id,
    });
    if (!verified) {
      log.warn("Invalid or expired installation state", { org: ctx.id });
      return errorRedirect("Installation session expired or invalid. Please try again.");
    }

    // 2. Verify nonce cookie against browser session
    const cookieNonce = req.cookies.get(INSTALLATION_STATE_COOKIE)?.value;
    if (!verifyNonceMatches(verified.nonce, cookieNonce)) {
      log.warn("Installation state nonce cookie mismatch", { org: ctx.id });
      return errorRedirect("Security validation failed (browser session mismatch). Please try again.");
    }

    // 3. Prevent replay: single-use nonce
    const consumed = await consumeInstallationNonce(verified.nonce, ctx.id, actorFor(ctx));
    if (!consumed) {
      log.warn("Installation state nonce already consumed", { org: ctx.id });
      return errorRedirect("This installation link has already been used.");
    }

    // 4. Verify installation against GitHub App API
    const details = await getInstallationDetails(installationId);
    if (!details) {
      return errorRedirect("GitHub App installation could not be verified with GitHub.");
    }

    // 5. Transactional binding & registration
    const repos = await listInstallationRepositories(installationId).catch(() => []);

    await prisma.$transaction(
      async (tx) => {
        const existing = await tx.githubInstallation.findUnique({
          where: { installationId },
        });

        if (existing) {
          if (existing.organizationId && existing.organizationId !== ctx.id) {
            throw err.authz("This GitHub App installation is already bound to another organization.");
          }
          await tx.githubInstallation.update({
            where: { id: existing.id },
            data: {
              organizationId: ctx.id,
              accountLogin: details.accountLogin,
              accountType: details.accountType,
              removedAt: null,
            },
          });
        } else {
          await tx.githubInstallation.create({
            data: {
              installationId,
              organizationId: ctx.id,
              accountLogin: details.accountLogin,
              accountType: details.accountType,
            },
          });
        }

        const inst = await tx.githubInstallation.findUniqueOrThrow({
          where: { installationId },
        });

        for (const repo of repos) {
          await registerRepository(tx, {
            organizationId: ctx.id,
            installationId: inst.id,
            githubId: repo.id,
            owner: repo.owner,
            name: repo.name,
            fullName: repo.fullName,
            private: repo.private,
            defaultBranch: repo.defaultBranch,
          });
        }
      },
      { timeout: 30_000 },
    );

    await recordAudit(ctx.id, actorFor(ctx), "installation.connected", "github_installation", String(installationId), {
      accountLogin: details.accountLogin,
      repositories: repos.length,
    });

    log.info("Installation securely bound to organization", {
      installationId,
      org: ctx.id,
      repos: repos.length,
    });

    const successRes = NextResponse.redirect(`${url.origin}/repositories?connected=true`);
    clearInstallationCookie(successRes);
    return successRes;
  } catch (e) {
    const appErr = toAppError(e);
    log.error("Failed to complete installation callback", { error: appErr.toJSON() });
    return errorRedirect(appErr.message);
  }
}
