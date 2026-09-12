import { NextResponse } from "next/server";
import { destroyCurrentSession } from "@/lib/auth/session-store";
import { authMode } from "@/lib/auth/mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/auth/signout — destroys the server session and cookie. */
export async function POST(req: Request) {
  if (authMode() === "oauth") {
    await destroyCurrentSession();
  }
  return NextResponse.redirect(`${new URL(req.url).origin}/`, { status: 303 });
}
