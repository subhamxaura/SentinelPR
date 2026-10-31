import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { AppError, err } from "@/lib/errors";
import { apiError } from "@/lib/web/api";
import { actorFor, recordAudit, requireMutationRole, requireOrganization } from "@/lib/web/session";
import { listInstallationRepositories, getInstallationDetails } from "@/lib/github/client";
import { registerRepository } from "@/lib/repositories/registration";
import { verifyInstallationState, consumeInstallationNonce } from "@/lib/github/installation-state";
import { logger } from "@/lib/logger";
import { rateLimitPolicies } from "@/lib/web/rate-limit";

const log = logger.child({ module: "api/installations" });

export const dynamic = "force-dynamic";

/**
 * POST /api/installations/:id/claim
 *
 * Claims a GitHub App installation for the acting organization.
 * Security requirements:
 * 1. Actor must be admin or owner of the active organization.
 * 2. Requires a cryptographically signed installation state token bound to the organization.
 * 3. Token must be unexpired and single-use (replay protected).
 * 4. Verifies installation exists and is active via GitHub App API.
 * 5. Transactionally binds installation and backfills repositories.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = await requireOrganization(req, [rateLimitPolicies.installationFlow]);
    requireMutationRole(ctx, req.method);
    if (ctx.role === "member") throw err.authz("Only admins can claim installations.");

    // Claiming requires explicit, signed proof of initiation to prevent cross-tenant enumeration/claiming
    let stateToken: string | null = null;
    try {
      const body = (await req.json()) as { state?: string };
      if (typeof body?.state === "string") stateToken = body.state;
    } catch {
      // Body may be empty
    }

    if (!stateToken) {
      return NextResponse.json(
        {
          error: {
            code: "STATE_REQUIRED",
            message: "Installation claiming requires a signed installation state token bound to your organization.",
            category: "authz",
          },
        },
        { status: 403 },
      );
    }

    const verified = verifyInstallationState(stateToken, {
      organizationId: ctx.id,
      userId: ctx.user?.id,
    });
    if (!verified) {
      return NextResponse.json(
        {
          error: {
            code: "INVALID_STATE",
            message: "Installation state token is invalid, expired, or bound to another organization.",
            category: "authz",
          },
        },
        { status: 403 },
      );
    }

    const consumed = await consumeInstallationNonce(verified.nonce, ctx.id, actorFor(ctx));
    if (!consumed) {
      return NextResponse.json(
        {
          error: {
            code: "STATE_REPLAYED",
            message: "Installation state token has already been consumed.",
            category: "authz",
          },
        },
        { status: 403 },
      );
    }

    const installation = await prisma.githubInstallation.findUnique({ where: { id } });
    if (!installation) {
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "Installation not found.", category: "config" } }, { status: 404 });
    }
    if (installation.organizationId && installation.organizationId !== ctx.id) {
      return NextResponse.json(
        { error: { code: "ALREADY_CLAIMED", message: "Installation already belongs to another organization.", category: "authz" } },
        { status: 409 },
      );
    }
    if (installation.removedAt) {
      return NextResponse.json(
        { error: { code: "INSTALLATION_REMOVED", message: "This installation has been removed and cannot be claimed.", category: "config" } },
        { status: 409 },
      );
    }

    // Server-side verification with GitHub
    await getInstallationDetails(installation.installationId);

    const repos = await listInstallationRepositories(installation.installationId);

    await prisma.$transaction(
      async (tx) => {
        const claimed = await tx.githubInstallation.updateMany({
          where: { id: installation.id, organizationId: null, removedAt: null },
          data: { organizationId: ctx.id },
        });
        if (claimed.count !== 1 && installation.organizationId !== ctx.id) {
          throw new AppError({
            code: "INSTALLATION_UNAVAILABLE",
            message: "This installation is no longer available to claim.",
            category: "config",
            retryable: false,
            status: 409,
          });
        }

        for (const repo of repos) {
          await registerRepository(tx, {
            organizationId: ctx.id,
            installationId: installation.id,
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

    await recordAudit(ctx.id, actorFor(ctx), "installation.claimed", "github_installation", installation.id, {
      accountLogin: installation.accountLogin,
      repositories: repos.length,
    });
    log.info("Installation claimed", { installation: installation.installationId, org: ctx.id, repos: repos.length });

    return NextResponse.json({ claimed: true, repositories: repos.length });
  } catch (e) {
    return apiError(e);
  }
}
