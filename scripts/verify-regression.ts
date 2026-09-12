/**
 * REAL regression demo against the running dashboard itself:
 * 1. Create a suite pointing at localhost:3000 (requires SENTINEL_ALLOW_PRIVATE_TARGETS=1)
 * 2. First run → approve baselines
 * 3. Mutate data (open synthetic monitor alert changes page content)
 * 4. Re-run → visual engine must detect the change
 * Usage: pnpm verify:regression
 */
import { config } from "dotenv";
config();

async function main() {
  const { prisma } = await import("../src/lib/db");
  const { processVisualRun } = await import("../src/lib/visual/runner");

  // Deterministic target: the rules page (static content, fast).
  const baseUrl = "http://localhost:3000";
  let suite = await prisma.visualSuite.findFirst({ where: { name: "Self-check (dashboard)" } });
  if (!suite) {
    suite = await prisma.visualSuite.create({
      data: { organizationId: (await prisma.organization.findFirstOrThrow()).id, name: "Self-check (dashboard)", baseUrl, readinessPath: "/rules" },
    });
  }
  let test = await prisma.visualTest.findFirst({ where: { suiteId: suite.id, name: "Rules page" } });
  if (!test) {
    test = await prisma.visualTest.create({
      data: { suiteId: suite.id, name: "Rules page", path: "/rules", threshold: 0.02 },
    });
  }

  const executeRun = async () => {
    const run = await prisma.visualRun.create({
      data: { suiteId: suite!.id, testId: test!.id, trigger: "manual", status: "queued" },
    });
    await processVisualRun(run.id);
    return prisma.visualRun.findUniqueOrThrow({ where: { id: run.id }, include: { snapshots: true } });
  };

  // Run 1: capture + approve baselines
  const run1 = await executeRun();
  for (const s of run1.snapshots) {
    const res = await fetch(`http://localhost:3000/api/visual/snapshots/${s.id}/approve`, { method: "POST" });
    console.log(`baseline approve (${s.viewportLabel}): ${res.status}`);
  }

  // Run 2: unchanged page → must pass
  const run2 = await executeRun();
  console.log(`run 2 (unchanged): ${run2.status}`, run2.snapshots.map((s) => `${s.viewportLabel}=${s.status} Δ${((s.diffRatio ?? 0) * 100).toFixed(3)}%`).join(", "));

  // Mutation: inject a real alert row → the /rules page badge/none changes? /rules has no alerts.
  // Instead target the PR list: create a PR row so /pull-requests content changes.
  let prSuite = await prisma.visualSuite.findFirst({ where: { name: "Self-check (dashboard PRs)" } });
  if (!prSuite) {
    prSuite = await prisma.visualSuite.create({
      data: { organizationId: (await prisma.organization.findFirstOrThrow()).id, name: "Self-check (dashboard PRs)", baseUrl, readinessPath: "/pull-requests" },
    });
  }
  let prTest = await prisma.visualTest.findFirst({ where: { suiteId: prSuite.id, name: "PR list" } });
  if (!prTest) {
    prTest = await prisma.visualTest.create({
      data: { suiteId: prSuite.id, name: "PR list", path: "/pull-requests", threshold: 0.005 },
    });
  }

  const executePrRun = async () => {
    const run = await prisma.visualRun.create({
      data: { suiteId: prSuite!.id, testId: prTest!.id, trigger: "manual", status: "queued" },
    });
    await processVisualRun(run.id);
    return prisma.visualRun.findUniqueOrThrow({ where: { id: run.id }, include: { snapshots: true } });
  };

  const prRun1 = await executePrRun();
  for (const s of prRun1.snapshots) {
    await fetch(`http://localhost:3000/api/visual/snapshots/${s.id}/approve`, { method: "POST" });
  }
  const prRun2 = await executePrRun();
  console.log(`pr run 2 (unchanged): ${prRun2.status}`, prRun2.snapshots.map((s) => `${s.viewportLabel}=${s.status}`).join(", "));

  // MUTATION: add a real PR row (dashboard content genuinely changes)
  const repo = await prisma.repository.create({
    data: {
      organizationId: (await prisma.organization.findFirstOrThrow()).id,
      githubId: 999999001,
      owner: "sentinelpr-demo",
      name: "regression-demo",
      fullName: "sentinelpr-demo/regression-demo",
    },
  });
  await prisma.pullRequest.create({
    data: {
      repositoryId: repo.id,
      number: 1,
      title: "DEMO: this row exists only to trigger a real visual regression",
      state: "open",
      headSha: "deadbeefcafe0000000000000000000000000001",
    },
  });

  const prRun3 = await executePrRun();
  console.log(`pr run 3 (after mutation): ${prRun3.status}`, prRun3.snapshots.map((s) => `${s.viewportLabel}=${s.status} Δ${((s.diffRatio ?? 0) * 100).toFixed(3)}% regions=${Array.isArray(s.changedRegions) ? s.changedRegions.length : 0}`).join(", "));

  if (prRun3.status === "failed") {
    console.log("\n✅ REAL VISUAL REGRESSION DETECTED — the engine caught a genuine UI change.");
  } else {
    console.log("\n❌ regression NOT detected — check threshold/rendering.");
  }

  // Cleanup demo rows so the dashboard stays honest
  await prisma.pullRequest.deleteMany({ where: { repositoryId: repo.id } });
  await prisma.repository.delete({ where: { id: repo.id } });
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("REGRESSION VERIFICATION FAILED:", e);
  process.exit(1);
});
