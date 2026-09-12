export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { apiError } from "@/lib/web/api";
import { actorFor, recordAudit, requireMutationRole, requireOrganization } from "@/lib/web/session";
import { getStorage, artifactKey, sha256 } from "@/lib/storage";

/**
 * Approve a snapshot as the new explicit, versioned baseline.
 * Deliberate action only — baselines are never silently replaced by runs.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const org = await requireOrganization();
    requireMutationRole(org, req.method);

    const snapshot = await prisma.visualSnapshot.findFirst({
      where: { id, run: { suite: { organizationId: org.id } } },
      include: { currentArtifact: true, test: true },
    });
    if (!snapshot || !snapshot.currentArtifact) {
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "Snapshot not found or has no capture", category: "authz" } }, { status: 404 });
    }

    // Copy the artifact bytes under a new baseline key — the original capture stays intact.
    const storage = getStorage();
    const bytes = await storage.get(snapshot.currentArtifact.storageKey);
    const key = artifactKey(org.id, "baseline");
    await storage.put(key, bytes, snapshot.currentArtifact.contentType);
    const baselineArtifact = await prisma.artifact.create({
      data: {
        organizationId: org.id,
        kind: "baseline",
        storageKey: key,
        contentType: snapshot.currentArtifact.contentType,
        sizeBytes: bytes.length,
        sha256: sha256(bytes),
      },
    });

    const previous = await prisma.visualBaseline.findUnique({
      where: { testId_browser_viewportLabel: { testId: snapshot.testId, browser: snapshot.browser, viewportLabel: snapshot.viewportLabel } },
      include: { artifact: true },
    });

    const baseline = await prisma.visualBaseline.upsert({
      where: { testId_browser_viewportLabel: { testId: snapshot.testId, browser: snapshot.browser, viewportLabel: snapshot.viewportLabel } },
      update: {
        artifactId: baselineArtifact.id,
        active: true,
        version: (previous?.version ?? 0) + 1,
      },
      create: {
        testId: snapshot.testId,
        browser: snapshot.browser,
        viewportLabel: snapshot.viewportLabel,
        artifactId: baselineArtifact.id,
        version: 1,
        active: true,
      },
    });

    // Keep old baseline bytes for a while (they are referenced by history), but deactivate.
    if (previous && previous.artifactId !== baselineArtifact.id) {
      await prisma.visualBaseline.update({ where: { id: previous.id }, data: { active: false } }).catch(() => undefined);
    }

    await recordAudit(org.id, actorFor(org), "visual_baseline.approved", "visual_test", snapshot.testId, {
      baselineVersion: baseline.version,
      snapshotId: snapshot.id,
    });
    return NextResponse.json({ baseline });
  } catch (e) {
    return apiError(e);
  }
}
