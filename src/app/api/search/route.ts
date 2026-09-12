export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { apiError } from "@/lib/web/api";
import { requireOrganization } from "@/lib/web/session";

/** Global search for the command palette: repos, PRs, synthetic tests, visual suites. */
export async function GET(req: Request) {
  try {
    const org = await requireOrganization();
    const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
    if (q.length < 2) {
      return NextResponse.json({ results: [] });
    }

    const [repositories, pullRequests, syntheticTests, visualSuites] = await Promise.all([
      prisma.repository.findMany({
        where: { organizationId: org.id, OR: [{ fullName: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }] },
        take: 5,
        select: { id: true, fullName: true },
      }),
      prisma.pullRequest.findMany({
        where: {
          repository: { organizationId: org.id },
          OR: [{ title: { contains: q, mode: "insensitive" } }, { number: isNaN(Number(q)) ? undefined : Number(q) }],
        },
        take: 6,
        select: { id: true, number: true, title: true, repository: { select: { fullName: true } } },
      }),
      prisma.syntheticTest.findMany({
        where: { organizationId: org.id, name: { contains: q, mode: "insensitive" } },
        take: 4,
        select: { id: true, name: true },
      }),
      prisma.visualSuite.findMany({
        where: { organizationId: org.id, name: { contains: q, mode: "insensitive" } },
        take: 4,
        select: { id: true, name: true },
      }),
    ]);

    return NextResponse.json({
      results: [
        ...pullRequests.map((p) => ({ type: "pull_request" as const, id: p.id, label: `#${p.number} ${p.title}`, sub: p.repository.fullName, href: `/pull-requests/${p.id}` })),
        ...repositories.map((r) => ({ type: "repository" as const, id: r.id, label: r.fullName, sub: "Repository", href: `/pull-requests?repository=${r.id}` })),
        ...syntheticTests.map((t) => ({ type: "synthetic" as const, id: t.id, label: t.name, sub: "Synthetic monitor", href: `/synthetic/${t.id}` })),
        ...visualSuites.map((s) => ({ type: "visual" as const, id: s.id, label: s.name, sub: "Visual suite", href: `/visual/${s.id}` })),
      ].slice(0, 15),
    });
  } catch (e) {
    return apiError(e);
  }
}
