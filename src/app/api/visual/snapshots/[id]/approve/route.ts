export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { apiError } from "@/lib/web/api";
import { actorFor, requireMutationRole, requireOrganization } from "@/lib/web/session";
import { getStorage, artifactKey, sha256 } from "@/lib/storage";

/**
 * Approve a snapshot as a new immutable baseline version.
 * A database row lock serializes approvals for the same visual test, and the
 * partial unique index in the migration is the final one-active-row guard.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const org = await requireOrganization(req);
    requireMutationRole(org, req.method);

    const snapshot = await prisma.visualSnapshot.findFirst({
      where: { id, run: { suite: { organizationId: org.id } } },
      include: { currentArtifact: true, test: true, run: { select: { commitSha: true } } },
    });
    if (!snapshot || !snapshot.currentArtifact) {
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "Snapshot not found or has no capture", category: "authz" } }, { status: 404 });
    }

    const storage = getStorage();
    const bytes = await storage.get(snapshot.currentArtifact.storageKey);
    const key = artifactKey(org.id, "baseline");
    await storage.put(key, bytes, snapshot.currentArtifact.contentType);

    let baselineArtifact;
    try {
      baselineArtifact = await prisma.artifact.create({
        data: {
          organizationId: org.id,
          kind: "baseline",
          storageKey: key,
          contentType: snapshot.currentArtifact.contentType,
          sizeBytes: bytes.length,
          sha256: sha256(bytes),
        },
      });
    } catch (error) {
      await storage.delete(key).catch(() => undefined);
      throw error;
    }

    try {
      const baseline = await approveWithRetry({
        organizationId: org.id,
        testId: snapshot.testId,
        browser: snapshot.browser,
        viewportLabel: snapshot.viewportLabel,
        artifactId: baselineArtifact.id,
        commitSha: snapshot.run.commitSha,
        actor: actorFor(org),
        snapshotId: snapshot.id,
      });
      return NextResponse.json({ baseline });
    } catch (error) {
      await Promise.all([
        prisma.artifact.delete({ where: { id: baselineArtifact.id } }).catch(() => undefined),
        storage.delete(key).catch(() => undefined),
      ]);
      throw error;
    }
  } catch (error) {
    return apiError(error);
  }
}

async function approveWithRetry(input: {
  organizationId: string;
  testId: string;
  browser: string;
  viewportLabel: string;
  artifactId: string;
  commitSha: string | null;
  actor: string;
  snapshotId: string;
}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        // All approvals for this test serialize on a stable parent row.
        await tx.$queryRaw`SELECT "id" FROM "VisualTest" WHERE "id" = ${input.testId} FOR UPDATE`;
        const previous = await tx.visualBaseline.findFirst({
          where: {
            testId: input.testId,
            browser: input.browser,
            viewportLabel: input.viewportLabel,
          },
          orderBy: { version: "desc" },
          select: { version: true },
        });
        await tx.visualBaseline.updateMany({
          where: {
            testId: input.testId,
            browser: input.browser,
            viewportLabel: input.viewportLabel,
            active: true,
          },
          data: { active: false },
        });
        const baseline = await tx.visualBaseline.create({
          data: {
            testId: input.testId,
            browser: input.browser,
            viewportLabel: input.viewportLabel,
            artifactId: input.artifactId,
            commitSha: input.commitSha,
            version: (previous?.version ?? 0) + 1,
            active: true,
          },
        });
        await tx.auditLog.create({
          data: {
            organizationId: input.organizationId,
            actor: input.actor,
            action: "visual_baseline.approved",
            targetType: "visual_test",
            targetId: input.testId,
            metadata: { baselineVersion: baseline.version, snapshotId: input.snapshotId },
          },
        });
        return baseline;
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: string }).code
        : undefined;
      if ((code !== "P2002" && code !== "P2034") || attempt === 2) throw error;
    }
  }
  throw new Error("Baseline approval retries exhausted");
}
