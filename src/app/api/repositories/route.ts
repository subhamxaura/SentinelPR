export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { apiError, parseBody, withOrg } from "@/lib/web/api";
import { actorFor, recordAudit, requireMutationRole, requireOrganization } from "@/lib/web/session";
import { toAppError } from "@/lib/errors";
import { getOctokitForRepository } from "@/lib/github/client";
import { registerRepository } from "@/lib/repositories/registration";
import { logger } from "@/lib/logger";

const log = logger.child({ module: "api/repositories" });

const addRepoSchema = z.object({
  fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "Must be owner/name"),
});

export async function GET(req: Request) {
  try {
    return await withOrg(req, async (orgId) => {
      const repositories = await prisma.repository.findMany({
        where: { organizationId: orgId },
        orderBy: { createdAt: "desc" },
        include: { installation: { select: { installationId: true, removedAt: true } } },
      });
      return NextResponse.json({
        repositories: repositories.map((r) => ({
          id: r.id,
          fullName: r.fullName,
          owner: r.owner,
          name: r.name,
          private: r.private,
          active: r.active,
          connection: r.installationId ? (r.installation?.removedAt ? "app_revoked" : "app") : "token",
          createdAt: r.createdAt,
        })),
      });
    });
  } catch (e) {
    return apiError(e);
  }
}

/**
 * Register a repository by owner/name. Works with the PAT fallback today;
 * GitHub-App-driven installs arrive via the installation_repositories webhook
 * instead. Verifies access through the GitHub API before persisting.
 */
export async function POST(req: Request) {
  try {
    const body = parseBody(addRepoSchema, await req.json());
    const org = await requireOrganization();
    requireMutationRole(org, req.method);

    if (!env.github.pat) {
      return NextResponse.json(
        { error: { code: "GITHUB_NOT_CONFIGURED", message: "Manual repository registration requires GITHUB_TOKEN. Install the GitHub App to connect repositories without a token.", category: "config", retryable: false } },
        { status: 503 },
      );
    }

    const { octokit } = await getOctokitForRepository({ installationId: null, fullName: body.fullName });
    const [owner, name] = body.fullName.split("/");
    const { data: repo } = await octokit.rest.repos.get({ owner, repo: name }).catch((e) => {
      throw toAppError(e);
    });

    const created = await registerRepository(prisma, {
      organizationId: org.id,
      githubId: repo.id,
      owner: repo.owner.login,
      name: repo.name,
      fullName: repo.full_name,
      private: repo.private,
      defaultBranch: repo.default_branch,
    });
    await recordAudit(org.id, actorFor(org), "repository.added", "repository", created.id, { fullName: created.fullName });
    log.info("Repository added", { repo: created.fullName, mode: env.github.pat ? "pat" : "app" });
    return NextResponse.json({ repository: { id: created.id, fullName: created.fullName } }, { status: 201 });
  } catch (e) {
    return apiError(e);
  }
}
