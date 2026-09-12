import { config } from "dotenv";
config();

async function main() {
  const { prisma } = await import("../src/lib/db");
  const baselines = await prisma.visualBaseline.findMany({
    include: { test: { select: { name: true } } },
  });
  console.log("baselines:", baselines.map((b) => `${b.test.name} ${b.browser}/${b.viewportLabel} v${b.version} active=${b.active}`));
  const orgs = await prisma.organization.findMany({ select: { id: true, slug: true, createdAt: true } });
  console.log("orgs:", orgs);
  const suites = await prisma.visualSuite.findMany({ select: { id: true, name: true, organizationId: true } });
  console.log("suites:", suites);
  await prisma.$disconnect();
}
main();
