import { prisma } from "@/lib/db";
import { verifyArtifactToken } from "@/lib/env";
import { getStorage } from "@/lib/storage";
import { toAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

const log = logger.child({ module: "api/artifacts" });

export const runtime = "nodejs";

/**
 * Artifact streaming. Access requires a signed, expiring token minted by the
 * server when rendering pages — artifact bytes are never public.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const token = url.searchParams.get("t");
    const verified = token ? verifyArtifactToken(token) : null;
    if (!verified || verified.artifactId !== id) {
      return new Response("Forbidden", { status: 403 });
    }

    const artifact = await prisma.artifact.findUnique({ where: { id } });
    if (!artifact) return new Response("Not found", { status: 404 });

    const storage = getStorage();
    const bytes = await storage.get(artifact.storageKey);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": artifact.contentType,
        "content-length": String(bytes.length),
        "cache-control": "private, max-age=3600",
        "content-disposition": "inline",
      },
    });
  } catch (e) {
    const appErr = toAppError(e);
    log.warn("Artifact fetch failed", { error: appErr.toJSON() });
    return new Response(appErr.message, { status: appErr.status });
  }
}
