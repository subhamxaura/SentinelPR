import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // Fallback to '' so commands that don't touch the DB (generate) don't explode in CI.
    url: process.env.DATABASE_URL ?? "",
  },
});
