import { prisma } from "@/lib/db";
import { verifyArtifactToken } from "@/lib/env";
import { getStorage } from "@/lib/storage";
import { toAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { enforceRateLimit, rateLimitPolicies } from "@/lib/web/rate-limit";

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
    await enforceRateLimit(req, rateLimitPolicies.artifactDownload, `artifact:${verified.organizationId}:${id}`);

    const artifact = await prisma.artifact.findFirst({
      where: { id, organizationId: verified.organizationId },
    });
    if (!artifact) return new Response("Not found", { status: 404 });

    const storage = getStorage();
    const bytes = await storage.get(artifact.storageKey);

    const SAFE_INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
    const isSafeInline = SAFE_INLINE_TYPES.has(artifact.contentType.toLowerCase());

    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": artifact.contentType,
        "content-length": String(bytes.length),
        "cache-control": "private, max-age=3600, no-transform",
        "content-disposition": isSafeInline ? "inline" : "attachment",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  } catch (e) {
    const appErr = toAppError(e);
    log.warn("Artifact fetch failed", { error: appErr.toJSON() });
    const headers = new Headers();
    if (appErr.code === "API_RATE_LIMIT_EXCEEDED" && appErr.details && typeof appErr.details === "object") {
      const retryAfter = Number((appErr.details as { retryAfterSeconds?: unknown }).retryAfterSeconds);
      if (Number.isSafeInteger(retryAfter) && retryAfter > 0) headers.set("Retry-After", String(retryAfter));
    }
    return new Response(appErr.message, { status: appErr.status, headers });
  }
}
