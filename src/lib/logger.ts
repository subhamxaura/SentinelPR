// Structured JSON logging with secret redaction. One line per event so it ships
// cleanly to any log aggregator. NEVER log secrets — redact by key name and
// by token-shaped values as a second line of defense.

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL: Level =
  (process.env.LOG_LEVEL as Level | undefined) ??
  (process.env.NODE_ENV === "production" ? "info" : "debug");

const SECRET_KEY_PATTERN =
  /secret|token|password|passwd|authorization|api[-_]?key|private[-_]?key|cookie|credential/i;
const TOKEN_VALUE_PATTERN =
  /(gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/g;

export type LogFields = Record<string, unknown>;

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.replace(TOKEN_VALUE_PATTERN, "[redacted]");
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) {
    return { name: value.name, message: redactValue(value.message, depth + 1) };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactValue(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? "[redacted]" : redactValue(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

function emit(level: Level, msg: string, fields?: LogFields) {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[MIN_LEVEL]) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...(fields ? (redactValue(fields) as LogFields) : {}),
  });
  if (level === "error") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export function createLogger(bindings: LogFields = {}): Logger {
  return {
    debug: (msg, fields) => emit("debug", msg, { ...bindings, ...fields }),
    info: (msg, fields) => emit("info", msg, { ...bindings, ...fields }),
    warn: (msg, fields) => emit("warn", msg, { ...bindings, ...fields }),
    error: (msg, fields) => emit("error", msg, { ...bindings, ...fields }),
    child: (extra) => createLogger({ ...bindings, ...extra }),
  };
}

export const logger = createLogger({ service: process.env.SERVICE_NAME ?? "sentinelpr" });
