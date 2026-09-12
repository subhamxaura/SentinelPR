import { z } from "zod";

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

export function parseSteps(raw: unknown): SyntheticStep[] {
  const parsed = stepsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid steps: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

export const CRON_RE =
  /^(\*|\d+|\*\/\d+)(\s+(\*|\d+|\*\/\d+)){4}$/; // 5-field cron (minute dom month dow)

export function parseCron(raw: string): string {
  if (!CRON_RE.test(raw.trim())) {
    throw new Error(`Invalid cron expression: ${raw}. Use a standard 5-field cron.`);
  }
  return raw.trim();
}
