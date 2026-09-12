/**
 * Optional seed: registers example configuration the operator can edit.
 * Creates NO fake runs, metrics or history — every number in the dashboard
 * comes from real executions.
 *
 * Usage: pnpm db:seed
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { config } from "dotenv";

config();

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required to seed");

  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });

  const org = await prisma.organization.upsert({
    where: { slug: process.env.SENTINEL_ORG_SLUG ?? "default" },
    update: {},
    create: {
      name: process.env.SENTINEL_ORG_NAME ?? "Default Organization",
      slug: process.env.SENTINEL_ORG_SLUG ?? "default",
    },
  });

  const existingSuites = await prisma.visualSuite.count({ where: { organizationId: org.id } });
  if (existingSuites === 0) {
    await prisma.visualSuite.create({
      data: {
        organizationId: org.id,
        name: "Example: example.com",
        baseUrl: "https://example.com",
        readinessPath: "/",
        tests: {
          create: [
            {
              name: "Landing page",
              path: "/",
              browsers: ["chromium"],
              viewports: [
                { label: "desktop", width: 1280, height: 720 },
                { label: "mobile", width: 390, height: 844 },
              ],
              threshold: 0.1,
            },
          ],
        },
      },
    });
    console.log("Created example visual suite (example.com) — run it to capture baseline candidates.");
  }

  const existingTests = await prisma.syntheticTest.count({ where: { organizationId: org.id } });
  if (existingTests === 0) {
    await prisma.syntheticTest.create({
      data: {
        organizationId: org.id,
        name: "Example: example.com availability",
        baseUrl: "https://example.com",
        steps: [
          { type: "navigate", url: "/" },
          { type: "assert_text", selector: "h1", text: "Example Domain" },
          { type: "screenshot", name: "landing" },
        ],
        maxConsecutiveFailures: 3,
        schedule: { create: { cron: "*/15 * * * *", timezone: "UTC" } },
      },
    });
    console.log("Created example synthetic monitor — run it manually or start the synthetic worker for the schedule.");
  }

  console.log("Seed complete. No fake history was created — run real executions to populate metrics.");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
