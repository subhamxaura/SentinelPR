import { App } from "octokit";
import { env } from "@/lib/env";
import { err, toAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * GitHub authentication resolution:
 * 1. GitHub App installation token (webhook-driven flow, preferred).
 * 2. PAT fallback (GITHUB_TOKEN) — enables manual review runs before the App
 *    is installed. Documented, never pretended to be the App.
 *
 * Private keys and tokens live only in this module; they must never cross
 * into the client bundle (this file is server-only by usage).
 */

let cachedApp: { app: App; id: string } | null = null;

export function getGitHubApp(): App | null {
  const { appId, privateKey } = env.github;
  if (!appId || !privateKey) return null;
  if (cachedApp && cachedApp.id === appId) return cachedApp.app;
  const app = new App({ appId, privateKey });
  cachedApp = { app, id: appId };
  return app;
}

export interface RepoAuthContext {
  installationId: number | null;
  /** Repos added manually (PAT mode) have no installation. */
  fullName: string;
}

export async function getOctokitForRepository(repo: RepoAuthContext) {
  const app = getGitHubApp();
  if (app && repo.installationId) {
    try {
      const octokit = await app.getInstallationOctokit(repo.installationId);
      return { octokit, mode: "app" as const };
    } catch (e) {
      // Installation may have been uninstalled; fall through to PAT if present.
      logger.warn("Installation token fetch failed", {
        installationId: repo.installationId,
        error: toAppError(e).message,
      });
    }
  }
  if (env.github.pat) {
    const { Octokit } = await import("octokit");
    return { octokit: new Octokit({ auth: env.github.pat }), mode: "pat" as const };
  }
  throw err.config(
    repo.installationId
      ? "GitHub App credentials are not fully configured (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY)."
      : "This repository is not connected through the GitHub App and no GITHUB_TOKEN fallback is configured.",
    "GITHUB_NOT_CONFIGURED",
  );
}

export function appInstallationUrl(): string | null {
  const slug = env.github.appSlug;
  return slug ? `https://github.com/apps/${slug}/installations/new` : null;
}

export interface InstallationRepo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string | null;
}

/** Repositories accessible to an installation (App JWT auth). Used by the claim-and-backfill flow. */
export async function listInstallationRepositories(installationId: number): Promise<InstallationRepo[]> {
  const app = getGitHubApp();
  if (!app) {
    throw err.config("GitHub App is not configured (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY).", "GITHUB_NOT_CONFIGURED");
  }
  try {
    const octokit = await app.getInstallationOctokit(installationId);
    const repos: InstallationRepo[] = [];
    for (let page = 1; page <= 20; page++) {
      const { data } = await octokit.rest.apps.listReposAccessibleToInstallation({ per_page: 100, page });
      repos.push(
        ...data.repositories.map((r) => ({
          id: r.id,
          owner: r.owner.login,
          name: r.name,
          fullName: r.full_name,
          private: r.private,
          defaultBranch: r.default_branch ?? null,
        })),
      );
      if (data.repositories.length < 100) break;
    }
    return repos;
  } catch (e) {
    throw toAppError(e);
  }
}

const PAGINATION_LIMIT = 100;

export interface GitHubFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface GitHubPullRequest {
  number: number;
  id: number;
  title: string;
  state: string;
  draft: boolean;
  headSha: string;
  headRef: string | null;
  baseRef: string | null;
  authorLogin: string | null;
  authorAvatar: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  url: string | null;
}

/** Fetch PR metadata + changed files (with patches). Rate-limit aware. */
export async function fetchPullRequestData(
  repo: RepoAuthContext,
  pullNumber: number,
): Promise<{ pr: GitHubPullRequest; files: GitHubFile[] }> {
  const { octokit } = await getOctokitForRepository(repo);
  const [owner, name] = repo.fullName.split("/");
  if (!owner || !name) throw err.config(`Invalid repository full name: ${repo.fullName}`);

  try {
    const { data: prData } = await octokit.rest.pulls.get({ owner, repo: name, pull_number: pullNumber });
    const files: GitHubFile[] = [];
    for (let page = 1; page <= 20; page++) {
      const { data } = await octokit.rest.pulls.listFiles({
        owner,
        repo: name,
        pull_number: pullNumber,
        per_page: PAGINATION_LIMIT,
        page,
      });
      files.push(...(data as GitHubFile[]));
      if (data.length < PAGINATION_LIMIT) break;
    }
    return {
      pr: {
        number: prData.number,
        id: prData.id,
        title: prData.title ?? "",
        state: prData.state,
        draft: Boolean(prData.draft),
        headSha: prData.head.sha,
        headRef: prData.head.ref,
        baseRef: prData.base?.ref ?? null,
        authorLogin: prData.user?.login ?? null,
        authorAvatar: prData.user?.avatar_url ?? null,
        additions: prData.additions ?? 0,
        deletions: prData.deletions ?? 0,
        changedFiles: prData.changed_files ?? files.length,
        url: prData.html_url ?? null,
      },
      files,
    };
  } catch (e) {
    throw toAppError(e);
  }
}

export interface CheckRunPayload {
  headSha: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?: "success" | "failure" | "neutral" | "skipped" | "action_required";
  title: string;
  summary: string;
  detailsUrl?: string;
}

/** Create a check run on a specific commit. Returns the check run id, or null when publishing failed. */
export async function createCheckRun(
  repo: RepoAuthContext,
  input: CheckRunPayload,
): Promise<string | null> {
  const [owner, name] = repo.fullName.split("/");
  if (!owner || !name) return null;
  try {
    const { octokit } = await getOctokitForRepository(repo);
    const { data } = await octokit.rest.checks.create({
      owner,
      repo: name,
      name: "SentinelPR",
      head_sha: input.headSha,
      status: input.status,
      ...(input.status === "completed" && input.conclusion ? { conclusion: input.conclusion } : {}),
      ...(input.detailsUrl ? { details_url: input.detailsUrl } : {}),
      output: {
        title: input.title,
        summary: input.summary,
      },
    });
    return String(data.id);
  } catch (e) {
    // Check-run publishing must never fail the review pipeline; it's reported instead.
    logger.warn("Check run creation failed", { repo: repo.fullName, error: toAppError(e).message });
    return null;
  }
}

export interface ReviewCommentInput {
  path: string;
  startLine: number | null;
  line: number;
  body: string;
}

export async function publishReview(
  repo: RepoAuthContext,
  pullNumber: number,
  commitSha: string,
  summary: string,
  comments: ReviewCommentInput[],
): Promise<{ published: number } | null> {
  if (!comments.length && !summary) return null;
  const [owner, name] = repo.fullName.split("/");
  if (!owner || !name) return null;
  try {
    const { octokit } = await getOctokitForRepository(repo);
    const { data } = await octokit.rest.pulls.createReview({
      owner,
      repo: name,
      pull_number: pullNumber,
      commit_id: commitSha,
      event: "COMMENT",
      ...(summary ? { body: summary } : {}),
      comments: comments.map((c) => ({
        path: c.path,
        // Multi-line comments require the line to exist in the diff; fall back to single line.
        ...(c.startLine && c.startLine < c.line
          ? { start_line: c.startLine, line: c.line }
          : { line: c.line }),
        body: c.body,
      })),
    });
    return { published: comments.length };
  } catch (e) {
    logger.warn("Inline review publishing failed", { repo: repo.fullName, error: toAppError(e).message });
    return null;
  }
}
