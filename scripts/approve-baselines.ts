import { config } from "dotenv";
config();

async function main() {
  const runId = process.argv[2];
  const { prisma } = await import("../src/lib/db");
  const snaps = await prisma.visualSnapshot.findMany({ where: { runId } });
  for (const s of snaps) {
    const res = await fetch(`http://localhost:3000/api/visual/snapshots/${s.id}/approve`, { method: "POST" });
    console.log(`${s.browser}/${s.viewportLabel} approve -> ${res.status}`);
  }
  await prisma.$disconnect();
}
main();
