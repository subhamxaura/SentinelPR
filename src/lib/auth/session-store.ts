/**
 * Database-backed session store.
 *
 * Cookie holds an opaque random token (HttpOnly, SameSite=Lax, Secure in
 * production). DB stores only the SHA-256 digest. The session pins
 * `activeOrgId` so organization switching survives page navigations.
 */
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { generateSessionToken, sessionTokenHash } from "./crypto";

export const SESSION_COOKIE = "sentinel_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_REFRESH_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  githubLogin: string | null;
  avatarUrl: string | null;
}

export interface ValidatedSession {
  id: string;
  activeOrgId: string | null;
  user: SessionUser;
}

export async function createSession(opts: { userId: string; userAgent?: string | null; ipAddressHash?: string | null }): Promise<string> {
  const token = generateSessionToken();
  await prisma.session.create({
    data: {
      tokenHash: sessionTokenHash(token),
      userId: opts.userId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      userAgent: opts.userAgent?.slice(0, 256) ?? null,
      ipAddressHash: opts.ipAddressHash ?? null,
    },
  });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(Date.now() + SESSION_TTL_MS),
  });
  return token;
}

/** Validates the cookie against the DB; null when absent/expired/tampered. */
export async function readSession(): Promise<ValidatedSession | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const row = await prisma.session.findUnique({
    where: { tokenHash: sessionTokenHash(token) },
    select: {
      id: true,
      activeOrgId: true,
      expiresAt: true,
      lastSeenAt: true,
      user: { select: { id: true, email: true, name: true, githubLogin: true, avatarUrl: true } },
    },
  });
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) {
    await prisma.session.delete({ where: { id: row.id } }).catch(() => undefined);
    return null;
  }

  // Rolling refresh: touch lastSeenAt; extend expiry once it drifts far enough.
  const now = Date.now();
  if (row.expiresAt.getTime() - now < SESSION_TTL_MS - SESSION_REFRESH_THRESHOLD_MS) {
    await prisma.session
      .update({ where: { id: row.id }, data: { lastSeenAt: new Date(now), expiresAt: new Date(now + SESSION_TTL_MS) } })
      .catch(() => undefined);
  }
  return { id: row.id, activeOrgId: row.activeOrgId, user: row.user };
}

export async function setActiveOrganization(sessionId: string, organizationId: string): Promise<void> {
  await prisma.session.update({ where: { id: sessionId }, data: { activeOrgId: organizationId } });
}

export async function destroyCurrentSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await prisma.session.deleteMany({ where: { tokenHash: sessionTokenHash(token) } });
  }
  jar.delete(SESSION_COOKIE);
}

/** Opportunistic sweep — cheap on an indexed expiresAt column. */
export async function pruneExpiredSessions(): Promise<void> {
  await prisma.session.deleteMany({ where: { expiresAt: { lte: new Date() } } });
}
