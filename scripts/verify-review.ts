/**
 * Integration verification: runs the REAL review pipeline pieces against a
 * live public GitHub PR diff — patch parsing, rule engine, normalization,
 * risk engine. Uses the GitHub REST API anonymously (no credentials needed
 * for public repos). Prints an honest report.
 *
 * Usage: pnpm verify:review [owner/repo#number]
 */
import { runRuleEngine, toChangedFiles, defaultRepoReviewConfig } from "../src/lib/rules/engine";
import { computeRisk } from "../src/lib/risk/engine";
import { dedupeFindings } from "../src/lib/review/normalize";
import type { PullRequestContext } from "../src/lib/rules/types";

async function main() {
  const target = process.argv[2] ?? "vercel/next.js";
  // No PR number given: pick the most recently updated open PR of the repo.
  const match = /^([\w.-]+\/[\w.-]+)(?:#(\d+))?$/.exec(target);
  if (!match) throw new Error("Expected owner/repo[#number]");

  let number = match[2] ? Number(match[2]) : null;
  if (number === null) {
    const listRes = await fetch(`https://api.github.com/repos/${match[1]}/pulls?state=open&sort=updated&per_page=1`, {
      headers: { "user-agent": "sentinelpr-verify", accept: "application/vnd.github+json" },
    });
    if (!listRes.ok) throw new Error(`GitHub API error listing PRs: ${listRes.status}`);
    const list = (await listRes.json()) as Array<{ number: number }>;
    if (!list.length) throw new Error("No open PRs to verify against");
    number = list[0].number;
  }

  // 1. Fetch a real PR + files (anonymous, public repo)
  const [full, filesRes] = await Promise.all([
    fetch(`https://api.github.com/repos/${match[1]}/pulls/${number}`, {
      headers: { "user-agent": "sentinelpr-verify", accept: "application/vnd.github+json" },
    }),
    fetch(`https://api.github.com/repos/${match[1]}/pulls/${number}/files?per_page=100`, {
      headers: { "user-agent": "sentinelpr-verify", accept: "application/vnd.github+json" },
    }),
  ]);
  if (!full.ok || !filesRes.ok) throw new Error(`GitHub API error: ${full.status}/${filesRes.status}`);
  const pr = (await full.json()) as Record<string, never> & {
    number: number;
    title: string;
    head: { sha: string; ref: string };
    base: { ref: string };
    user: { login: string } | null;
  };
  const files = (await filesRes.json()) as Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
  }>;

  console.log(`PR ${match[1]}#${pr.number}: ${pr.title}`);
  console.log(`Files: ${files.length}, with patches: ${files.filter((f) => f.patch).length}\n`);

  // 2. Build the exact context the worker builds
  const changedFiles = toChangedFiles(files);
  const ctx = {
    pr: {
      number: pr.number,
      title: pr.title,
      authorLogin: pr.user?.login ?? null,
      headSha: pr.head.sha,
      baseRef: pr.base.ref,
      headRef: pr.head.ref,
      body: null,
    } satisfies PullRequestContext,
    files: changedFiles,
    config: defaultRepoReviewConfig(),
  };

  // 3. Run the deterministic engine + risk engine
  const t0 = Date.now();
  const findings = dedupeFindings(runRuleEngine(ctx));
  const risk = computeRisk({ findings });
  const ms = Date.now() - t0;

  console.log(`Rule engine: ${findings.length} finding(s) in ${ms}ms`);
  const bySeverity = new Map<string, number>();
  for (const f of findings) bySeverity.set(f.severity, (bySeverity.get(f.severity) ?? 0) + 1);
  console.log("By severity:", Object.fromEntries(bySeverity));
  const byCategory = new Map<string, number>();
  for (const f of findings) byCategory.set(f.category, (byCategory.get(f.category) ?? 0) + 1);
  console.log("By category:", Object.fromEntries(byCategory));

  console.log(`\nUnified risk: ${risk.level.toUpperCase()} (score ${risk.score})`);
  for (const s of risk.signals) {
    console.log(`  ${s.dimension.padEnd(12)} ${s.level.padEnd(8)} ${s.reasons[0]?.slice(0, 90) ?? ""}`);
  }
  console.log(`\nAction: ${risk.recommendedAction}`);

  console.log("\nSample findings:");
  for (const f of findings.slice(0, 5)) {
    console.log(`  [${f.severity}] ${f.ruleId} ${f.file}:${f.startLine ?? "?"} — ${f.title}`);
  }
  console.log("\nVERIFICATION PASSED — real diff, real rules, real risk computation.");
}

main().catch((e) => {
  console.error("VERIFICATION FAILED:", e);
  process.exit(1);
});
