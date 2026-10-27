import type { NextResponse } from "next/server";

export const OAUTH_STATE_COOKIE = "sentinel_oauth_state";

const OAUTH_STATE_PATH = "/api/auth/github";
const OAUTH_STATE_MAX_AGE = 10 * 60;

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: OAUTH_STATE_PATH,
  };
}

export function setOAuthStateCookie(response: NextResponse, nonce: string): void {
  response.cookies.set(OAUTH_STATE_COOKIE, nonce, { ...cookieOptions(), maxAge: OAUTH_STATE_MAX_AGE });
}

export function clearOAuthStateCookie(response: NextResponse): void {
  response.cookies.set(OAUTH_STATE_COOKIE, "", { ...cookieOptions(), maxAge: 0 });
}
