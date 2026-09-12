import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { err } from "@/lib/errors";
import { apiError } from "@/lib/web/api";
import { actorFor, recordAudit, requireMutationRole, requireOrganization } from "@/lib/web/session";
import { listInstallationRepositories } from "@/lib/github/client";
import { logger } from "@/lib/logger";

const log = logger.child({ module: "api/installations" });

export const dynamic = "force-dynamic";

/**
 * POST /api/installations/:id/claim
 *
 * Claims an unclaimed GitHub App installation for the acting organization and
 * backfills its accessible repositories. Admin/owner only. This is what makes
 * webhook-driven installs multi-tenant: installations arrive unclaimed and are
 * bound to exactly one organization by an explicit dashboard action.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = await requireOrganization();
    requireMutationRole(ctx, req.method);
    if (ctx.role === "member") throw err.authz("Only admins can claim installations.");

    const installation = await prisma.githubInstallation.findUnique({ where: { id } });
    if (!installation) {
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "Installation not found.", category: "config" } }, { status: 404 });
    }
    if (installation.organizationId) {
      return NextResponse.json(
        { error: { code: "ALREADY_CLAIMED", message: "Installation already belongs to an organization.", category: "config" } },
        { status: 409 },
      );
    }

    const repos = await listInstallationRepositories(installation.installationId);

    for (const repo of repos) {
      await prisma.repository.upsert({
        where: { githubId: repo.id },
        update: { organizationId: ctx.id, installationId: installation.id, active: true },
        create: {
          organizationId: ctx.id,
          installationId: installation.id,
          githubId: repo.id,
          owner: repo.owner,
          name: repo.name,
          fullName: repo.fullName,
          private: repo.private,
          defaultBranch: repo.defaultBranch,
        },
      });
    }

    await prisma.githubInstallation.update({
      where: { id: installation.id },
      data: { organizationId: ctx.id },
    });

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
