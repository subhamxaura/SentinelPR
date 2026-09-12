/**
 * One-shot visual verification: picks the first enabled visual test,
 * creates a queued run, and executes the real worker path.
 * Usage: pnpm verify:visual:full
 */
import { config } from "dotenv";
config();

async function main() {
  const { prisma } = await import("../src/lib/db");
  const test = await prisma.visualTest.findFirst({
    where: { enabled: true, suite: { enabled: true } },
    include: { suite: true },
    orderBy: { createdAt: "asc" },
  });
  if (!test) throw new Error("No enabled visual test found — create one in the dashboard or seed.");

  const run = await prisma.visualRun.create({
    data: { suiteId: test.suiteId, testId: test.id, trigger: "manual", status: "queued" },
  });
  console.log(`Executing visual run ${run.id} for test "${test.name}" (${test.suite.baseUrl}${test.path})`);

  const { processVisualRun } = await import("../src/lib/visual/runner");
  await processVisualRun(run.id);

  const done = await prisma.visualRun.findUniqueOrThrow({
    where: { id: run.id },
    include: { snapshots: true },
  });
  console.log(`Run status: ${done.status}`);
  for (const s of done.snapshots) {
    console.log(
      `  [${s.status}] ${s.browser}/${s.viewportLabel}` +
        (s.diffRatio !== null ? ` diffRatio=${(s.diffRatio * 100).toFixed(3)}%` : "") +
        ` regions=${Array.isArray(s.changedRegions) ? s.changedRegions.length : 0}` +
        (s.currentArtifactId ? " screenshot✓" : ""),
    );
  }
  console.log(`\nRun ID for approval: ${run.id}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("VISUAL VERIFICATION FAILED:", e);
  process.exit(1);
});
