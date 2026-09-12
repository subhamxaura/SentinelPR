/**
 * Starts a local embedded PostgreSQL (no Docker required) for development.
 * Data lives in .data/pg. Usage: pnpm dev:postgres
 */
import EmbeddedPostgres from "embedded-postgres";
import path from "node:path";

const dataDir = path.resolve(process.cwd(), ".data/pg");

async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "sentinel",
    password: "sentinel",
    port: 5432,
    persistent: true,
    // Windows default locale yields WIN1252 encoding, which cannot store the
    // Unicode our DOM diffs contain. Force UTF8 at cluster creation.
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
  });

  try {
    await pg.initialise();
  } catch {
    // already initialised on previous runs
  }
  await pg.start();
  try {
    await pg.createDatabase("sentinelpr");
  } catch {
    // exists
  }
  console.log("Embedded PostgreSQL ready on postgres://sentinel:sentinel@localhost:5432/sentinelpr");
  console.log("Press Ctrl+C to stop.");
  const shutdown = async () => {
    await pg.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
