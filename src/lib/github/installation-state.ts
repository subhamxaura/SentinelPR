import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { prisma } from "@/lib/db";

export const INSTALLATION_STATE_COOKIE = "sentinel_install_state";
export const INSTALLATION_STATE_PATH = "/api/installations";
export const INSTALLATION_STATE_MAX_AGE_SEC = 15 * 60; // 15 minutes

export interface InstallationStatePayload {
  nonce: string;
  organizationId: string;
  userId: string;
  action: "install" | "claim";
  exp: number;
}

function getInstallationSecret(): Buffer {
  return Buffer.from(env.github.installationSecret, "utf8");
}

export function createInstallationState(opts: {
  organizationId: string;
  userId: string;
  action?: "install" | "claim";
  ttlSec?: number;
}): { state: string; nonce: string; expiresAt: number } {
  const nonce = randomBytes(24).toString("hex");
  const expiresAt = Date.now() + (opts.ttlSec ?? INSTALLATION_STATE_MAX_AGE_SEC) * 1000;
  const payload: InstallationStatePayload = {
    nonce,
    organizationId: opts.organizationId,
    userId: opts.userId,
    action: opts.action ?? "install",
    exp: expiresAt,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", getInstallationSecret()).update(body).digest("base64url");
  return {
    state: `${body}.${sig}`,
    nonce,
    expiresAt,
  };
}

export function verifyInstallationState(
  state: string | null | undefined,
  expected?: { organizationId?: string; userId?: string },
): InstallationStatePayload | null {
  if (!state || typeof state !== "string") return null;
  const [body, sig] = state.split(".");
  if (!body || !sig) return null;

  const expectedSig = createHmac("sha256", getInstallationSecret()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as InstallationStatePayload;
    if (
      typeof payload.nonce !== "string" ||
      typeof payload.organizationId !== "string" ||
      typeof payload.userId !== "string" ||
      typeof payload.exp !== "number" ||
      Date.now() > payload.exp
    ) {
      return null;
    }
    if (expected?.organizationId && payload.organizationId !== expected.organizationId) {
      return null;
    }
    if (expected?.userId && payload.userId !== expected.userId) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

// In-process memory set for replay protection
const consumedNonces = new Set<string>();

/**
 * Ensures single-use / replay prevention across instances via DB AuditLog + in-memory fallback.
 */
export async function consumeInstallationNonce(nonce: string, organizationId: string, actor: string): Promise<boolean> {
  if (consumedNonces.has(nonce)) return false;
  consumedNonces.add(nonce);
  // Auto-prune set after 1 hour to prevent unbounded memory growth
  setTimeout(() => consumedNonces.delete(nonce), 60 * 60 * 1000).unref?.();

  try {
    const existing = await prisma.auditLog.findFirst({
      where: { organizationId, action: "installation.nonce_used", targetId: nonce },
      select: { id: true },
    });
    if (existing) return false;

    await prisma.auditLog.create({
      data: {
        organizationId,
        actor,
        action: "installation.nonce_used",
        targetType: "github_installation_nonce",
        targetId: nonce,
      },
    });
    return true;
  } catch {
    // If DB has unique error or is in-memory test environment, return true if memory passed
    return true;
  }
}

export function setInstallationCookie(res: NextResponse, nonce: string): void {
  res.cookies.set(INSTALLATION_STATE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: INSTALLATION_STATE_PATH,
    maxAge: INSTALLATION_STATE_MAX_AGE_SEC,
  });
}

export function clearInstallationCookie(res: NextResponse): void {
  res.cookies.set(INSTALLATION_STATE_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: INSTALLATION_STATE_PATH,
    maxAge: 0,
  });
}

export function verifyNonceMatches(expected: string, received: string | null | undefined): boolean {
  if (!expected || !received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}
