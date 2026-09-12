import { prisma } from "@/lib/db";
import { requireOrganization } from "@/lib/web/session";
import { timeAgo } from "@/lib/web/format";
import { PageHeader, Card, CardHeader, StatusBadge, Mono, Button } from "@/components/primitives";
import { EmptyState } from "@/components/states";
import { AddRepositoryForm, TriggerReviewForm } from "@/components/forms";
import { appInstallationUrl } from "@/lib/github/client";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function RepositoriesPage() {
  const org = await requireOrganization();

  const repos = await prisma.repository.findMany({
    where: { organizationId: org.id },
    orderBy: { createdAt: "desc" },
    include: {
      installation: { select: { installationId: true, removedAt: true } },
      pullRequests: { select: { id: true, state: true } },
    },
  });

  const appUrl = appInstallationUrl();

  return (
    <div>
      <PageHeader
        title="Repositories"
        description="Repositories SentinelPR watches. GitHub-App installs arrive automatically via webhook."
      />

      <AddRepositoryForm />

      <Card className="mb-6 border-accent/25 bg-accent-dim/30 px-4 py-3">
        <h3 className="text-[13px] font-semibold text-accent-strong">Connect the GitHub App (recommended)</h3>
        <p className="mt-1 text-[13px] text-muted">
          The App enables automatic webhook-driven reviews, check runs and inline comments.{" "}
          {appUrl ? (
            <a className="text-accent-strong hover:underline" href={appUrl}>
              Install {env.github.appSlug ?? "SentinelPR"} →
            </a>
          ) : (
            <>
              Not configured yet — set <Mono>GITHUB_APP_ID</Mono>, <Mono>GITHUB_APP_PRIVATE_KEY</Mono> and{" "}
              <Mono>GITHUB_WEBHOOK_SECRET</Mono>. See <a className="text-accent-strong hover:underline" href="/settings">Settings</a>.
            </>
          )}
        </p>
      </Card>

      {repos.length === 0 ? (
        <EmptyState title="No repositories">
          Add a repository by owner/name (requires a configured GitHub token) or install the GitHub App and
          select repositories — they appear here automatically.
        </EmptyState>
      ) : (
        <div className="space-y-4">
          {repos.map((repo) => {
            const openPrs = repo.pullRequests.filter((p) => p.state === "open").length;
            return (
              <Card key={repo.id}>
                <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3.5">
                  <div>
                    <a
                      href={`https://github.com/${repo.fullName}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[14px] font-semibold hover:text-accent-strong"
                    >
                      {repo.fullName} ↗
                    </a>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-faint">
                      <StatusBadge tone={repo.installationId ? (repo.installation?.removedAt ? "warning" : "success") : "neutral"}>
                        {repo.installationId ? (repo.installation?.removedAt ? "app revoked" : "GitHub App") : "token"}
                      </StatusBadge>
                      <span>{repo.private ? "private" : "public"}</span>
                      <span>
                        {openPrs} open PR{openPrs === 1 ? "" : "s"} · added {timeAgo(repo.createdAt)}
                      </span>
                    </div>
                  </div>
                  <a href={`/pull-requests?repository=${repo.id}`}>
                    <Button variant="secondary">View PRs</Button>
                  </a>
                </div>
                <div className="border-t border-line">
                  <TriggerReviewForm repositoryId={repo.id} />
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Card className="mt-6">
        <CardHeader title="Per-repository review config" sub="Stored on each repository row (config JSON) and merged over safe defaults by the rule engine" />
        <pre className="overflow-x-auto px-4 py-3 font-mono text-xs text-muted">{`{
  "disabledRules": ["quality/console-log"],
  "severityOverrides": { "maintainability/todo-without-issue": "low" },
  "maxComments": 10,
  "confidenceThreshold": 0.6,
  "publishSeverities": ["critical", "high", "medium"],
  "forbiddenImports": ["lodash"]
}`}</pre>
      </Card>
    </div>
  );
}
