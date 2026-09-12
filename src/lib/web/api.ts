import { NextResponse } from "next/server";
import { z } from "zod";
import { AppError, toAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { requireOrganization } from "@/lib/web/session";

const log = logger.child({ module: "api" });

/** Standard error envelope: structured, no stack traces, honest categories. */
export function apiError(e: unknown): NextResponse {
  const appErr = toAppError(e);
  if (appErr.status >= 500) {
    log.error("API error", { error: appErr.toJSON() });
  }
  return NextResponse.json({ error: appErr.toJSON() }, { status: appErr.status });
}

export async function withOrg<T>(fn: (orgId: string) => Promise<T>): Promise<T> {
  const org = await requireOrganization();
  return fn(org.id);
}

export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new AppError({
      code: "VALIDATION_ERROR",
      message: parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
      category: "config",
      status: 400,
      details: parsed.error.issues.slice(0, 10),
    });
  }
  return parsed.data;
}

export const paginationSchema = z.object({
  cursor: z.string().cuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
