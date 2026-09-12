import { prisma } from "@/lib/db";
import { requirePageOrganization } from "@/lib/web/session";
import { timeAgo, shortSha } from "@/lib/web/format";
import { PageHeader, Card, RunStatusBadge, RiskBadge, Mono, StatusBadge } from "@/components/primitives";
import { EmptyState } from "@/components/states";
import { appInstallationUrl } from "@/lib/github/client";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function PullRequestsPage() {
  const org = await requirePageOrganization();

  const [prs, repoCount] = await Promise.all([
    prisma.pullRequest.findMany({
      where: { repository: { organizationId: org.id } },
      orderBy: { updatedAt: "desc" },
      take: 50,
      include: {
        repository: { select: { fullName: true } },
        reviewRuns: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, status: true, riskLevel: true, headSha: true } },
      },
    }),
    prisma.repository.count({ where: { organizationId: org.id } }),
  ]);

  const canTrigger = Boolean(env.github.pat || env.github.appId);

  return (
    <div>
      <PageHeader
        title="Pull Requests"
        description="Every pull request SentinelPR has seen, with its latest review outcome."
      />

      {repoCount === 0 ? (
        <EmptyState
          title="No repositories connected"
          action={{ label: "Connect a repository", href: "/repositories" }}
        >
          SentinelPR reviews PRs in repositories it is connected to. Connect the GitHub App for automatic
          webhook-driven reviews, or add a repository with a token for manual runs.
        </EmptyState>
      ) : prs.length === 0 ? (
        <EmptyState title="No pull requests yet">
          Once a PR is opened (or triggered manually), its review, findings and risk score appear here.
          {!canTrigger ? (
            <span className="mt-2 block text-faint">
              Note: no GitHub credentials configured yet — see <a className="text-accent-strong hover:underline" href="/settings">Settings</a>.
            </span>
          ) : null}
        </EmptyState>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
                  <th className="px-4 py-2.5 font-medium">Pull request</th>
                  <th className="px-4 py-2.5 font-medium">Head</th>
                  <th className="px-4 py-2.5 font-medium">State</th>
                  <th className="px-4 py-2.5 font-medium">Latest review</th>
                  <th className="px-4 py-2.5 font-medium">Risk</th>
                  <th className="px-4 py-2.5 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {prs.map((pr) => {
                  const latest = pr.reviewRuns[0];
                  return (
                    <tr key={pr.id} className="hover:bg-surface-2">
                      <td className="max-w-[420px] px-4 py-2.5">
                        <a href={`/pull-requests/${pr.id}`} className="block truncate hover:text-accent-strong">
                          <Mono className="text-faint">{pr.repository.fullName}</Mono>{" "}
                          <span className="text-accent-strong">#{pr.number}</span> {pr.title}
                        </a>
                      </td>
                      <td className="px-4 py-2.5"><Mono className="text-muted">{shortSha(latest?.headSha ?? pr.headSha)}</Mono></td>
                      <td className="px-4 py-2.5">
                        <StatusBadge tone={pr.state === "open" ? "accent" : pr.state === "merged" ? "success" : "neutral"}>{pr.state}</StatusBadge>
                      </td>
                      <td className="px-4 py-2.5">{latest ? <RunStatusBadge status={latest.status} /> : <span className="text-faint">—</span>}</td>
                      <td className="px-4 py-2.5">{latest ? <RiskBadge level={latest.riskLevel} /> : <span className="text-faint">—</span>}</td>
                      <td className="px-4 py-2.5 text-faint">{timeAgo(pr.updatedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {env.github.appSlug ? (
        <p className="mt-4 text-xs text-faint">
          Install the app on more repositories:{" "}
          <a className="text-accent-strong hover:underline" href={appInstallationUrl() ?? "#"}>
            github.com/apps/{env.github.appSlug}/installations
          </a>
        </p>
      ) : null}
    </div>
  );
}
