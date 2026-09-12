import { z } from "zod";

export type ErrorCategory =
  | "config"
  | "auth"
  | "authz"
  | "github"
  | "rate_limit"
  | "ai"
  | "infrastructure"
  | "playwright"
  | "test_failure"
  | "timeout"
  | "internal";

export class AppError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly details?: unknown;
  readonly status: number;

  constructor(opts: {
    code: string;
    message: string;
    category: ErrorCategory;
    retryable?: boolean;
    details?: unknown;
    status?: number;
  }) {
    super(opts.message);
    this.name = "AppError";
    this.code = opts.code;
    this.category = opts.category;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details;
    this.status = opts.status ?? 500;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      category: this.category,
      retryable: this.retryable,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

export const err = {
  config: (message: string, code = "CONFIG_MISSING") =>
    new AppError({ code, message, category: "config", status: 503 }),
  unauthorized: (message = "Sign in to continue") =>
    new AppError({ code: "UNAUTHENTICATED", message, category: "auth", status: 401 }),
  authz: (message = "You do not have access to this resource") =>
    new AppError({ code: "FORBIDDEN", message, category: "authz", status: 403 }),
  github: (message: string, status?: number, retryable = false) =>
    new AppError({
      code: "GITHUB_ERROR",
      message,
      category: "github",
      retryable,
      status: status && status >= 400 && status < 500 ? status : 502,
    }),
  rateLimit: (resetAt?: string) =>
    new AppError({
      code: "GITHUB_RATE_LIMIT",
      message: `GitHub API rate limit exceeded${resetAt ? ` — resets at ${resetAt}` : ""}`,
      category: "rate_limit",
      retryable: true,
      status: 429,
    }),
  infra: (message: string, code = "INFRASTRUCTURE_ERROR") =>
    new AppError({ code, message, category: "infrastructure", retryable: true, status: 503 }),
  timeout: (message: string) =>
    new AppError({ code: "TIMEOUT", message, category: "timeout", retryable: true, status: 504 }),
  internal: (message: string) =>
    new AppError({ code: "INTERNAL_ERROR", message, category: "internal", status: 500 }),
};

const octokitErrorShape = z.object({
  status: z.number().optional(),
  message: z.string().optional(),
  response: z
    .object({
      status: z.number().optional(),
      headers: z.record(z.string(), z.unknown()).optional(),
      data: z.unknown().optional(),
    })
    .optional(),
});

/** Normalize anything thrown into an AppError without leaking stack traces to users. */
export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  const parsed = octokitErrorShape.safeParse(e);
  if (parsed.success) {
    const status = parsed.data.response?.status ?? parsed.data.status;
    const message = parsed.data.message ?? "GitHub request failed";
    const headers = parsed.data.response?.headers ?? {};
    const remaining = headers["x-ratelimit-remaining"];
    if (status === 403 || status === 429) {
      if (remaining === "0" || status === 429) {
        return err.rateLimit(
          typeof headers["x-ratelimit-reset"] === "string"
            ? new Date(Number(headers["x-ratelimit-reset"]) * 1000).toISOString()
            : undefined,
        );
      }
      return err.github(message, status, false);
    }
    if (status === 401) return err.github("GitHub authentication failed — check credentials", status);
    if (status === 404) return err.github("Resource not found on GitHub (or access denied)", status);
    if (status && status >= 500) return err.github(`GitHub server error: ${message}`, status, true);
    if (status) return err.github(message, status);
  }
  if (e instanceof Error) {
    if (/timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up/i.test(e.message)) {
      return err.infra(`Network/infrastructure failure: ${e.message}`, "NETWORK_ERROR");
    }
    return err.internal(e.message);
  }
  return err.internal("Unknown error");
}
