import { z } from "zod";
import { AppError } from "@/lib/errors";

/**
 * Synthetic test step vocabulary. Deliberately small: each step maps to one
 * Playwright action (or one fetch) so tests read like the user journey they
 * describe. Validated with zod on create/update and again at execution time.
 */

export const stepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), url: z.string().min(1).max(2048), name: z.string().max(120).optional() }),
  z.object({ type: z.literal("click"), selector: z.string().min(1).max(500), name: z.string().max(120).optional() }),
  z.object({
    type: z.literal("fill"),
    selector: z.string().min(1).max(500),
    value: z.string().min(1).max(2000),
    name: z.string().max(120).optional(),
  }),
  z.object({ type: z.literal("press"), selector: z.string().max(500).optional(), key: z.string().min(1).max(40), name: z.string().max(120).optional() }),
  z.object({ type: z.literal("select"), selector: z.string().min(1).max(500), value: z.string().min(1).max(500), name: z.string().max(120).optional() }),
  z.object({
    type: z.literal("wait"),
    ms: z.number().int().min(1).max(30_000).optional(),
    selector: z.string().max(500).optional(),
    name: z.string().max(120).optional(),
  }),
  z.object({
    type: z.literal("assert_text"),
    selector: z.string().min(1).max(500),
    text: z.string().min(1).max(2000),
    contains: z.boolean().optional(),
    name: z.string().max(120).optional(),
  }),
  z.object({ type: z.literal("assert_visible"), selector: z.string().min(1).max(500), name: z.string().max(120).optional() }),
  z.object({ type: z.literal("assert_url"), url: z.string().min(1).max(2048), name: z.string().max(120).optional() }),
  z.object({ type: z.literal("screenshot"), name: z.string().max(120).optional() }),
  z.object({
    type: z.literal("request"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]),
    url: z.string().min(1).max(2048),
    headers: z.record(z.string(), z.string().max(1000)).optional(),
    body: z.string().max(50_000).optional(),
    expectStatus: z.number().int().min(100).max(599).optional(),
    name: z.string().max(120).optional(),
  }),
]);

export type SyntheticStep = z.infer<typeof stepSchema>;

export const stepsSchema = z.array(stepSchema).min(1).max(50);

function invalid(message: string): AppError {
  return new AppError({ code: "VALIDATION_ERROR", message, category: "config", status: 400 });
}

export function parseSteps(raw: unknown): SyntheticStep[] {
  const parsed = stepsSchema.safeParse(raw);
  if (!parsed.success) {
    throw invalid(`Invalid steps: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

interface CronField {
  name: string;
  min: number;
  max: number;
}

const CRON_FIELDS: CronField[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
];

function validCronField(raw: string, field: CronField): boolean {
  if (raw === "*") return true;
  const step = /^\*\/(\d+)$/.exec(raw);
  if (step) {
    const value = Number(step[1]);
    return Number.isInteger(value) && value >= 1 && value <= field.max;
  }
  if (!/^\d+$/.test(raw)) return false;
  const value = Number(raw);
  return Number.isInteger(value) && value >= field.min && value <= field.max;
}

export function parseCron(raw: string): string {
  const trimmed = raw.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    throw invalid(`Invalid cron expression: ${raw}. Use a standard 5-field cron.`);
  }
  for (let i = 0; i < parts.length; i++) {
    if (!validCronField(parts[i], CRON_FIELDS[i])) {
      throw invalid(
        `Invalid cron ${CRON_FIELDS[i].name} field "${parts[i]}". Use *, a value from ${CRON_FIELDS[i].min}-${CRON_FIELDS[i].max}, or */step.`,
      );
    }
  }
  return trimmed;
}

export function parseTimezone(raw: string): string {
  const timezone = raw.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw invalid(`Invalid timezone: ${timezone}.`);
  }
  return timezone;
}
