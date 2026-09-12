import { z } from "zod";
import { CATEGORIES, SEVERITIES, FINDING_KINDS } from "@/lib/types";
import type { Finding, Severity, Category, FindingKind } from "@/lib/types";

const severitySchema = z.enum(SEVERITIES);
const categorySchema = z.enum(CATEGORIES);
const kindSchema = z.enum(FINDING_KINDS);

const rawFindingShape = z.object({
  ruleId: z.string().min(1).max(200).nullable(),
  source: z.enum(["rule", "ai"]),
  category: categorySchema,
  severity: severitySchema,
  confidence: z.number().min(0).max(1),
  kind: kindSchema,
  file: z.string().min(1).max(1024),
  startLine: z.number().int().min(0).max(1_000_000).nullable(),
  endLine: z.number().int().min(0).max(1_000_000).nullable(),
  title: z.string().min(1).max(300),
  description: z.string().min(1).max(4000),
  evidence: z.string().max(2000).nullable(),
  suggestion: z.string().max(2000).nullable(),
  dedupKey: z.string().min(1).max(600),
});

export const findingSchema = rawFindingShape;

export class FindingValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid finding(s): ${issues.join("; ")}`);
    this.name = "FindingValidationError";
  }
}

const MAX_EVIDENCE = 1500;
const MAX_DESCRIPTION = 2000;

/**
 * Validate, clamp and canonically normalize a finding. Throws
 * FindingValidationError if a finding cannot be salvaged — callers decide
 * whether to drop it (AI output) or treat it as a bug (internal rules).
 */
export function normalizeFinding(input: unknown): Finding {
  const parsed = rawFindingShape.safeParse(input);
  if (!parsed.success) {
    throw new FindingValidationError(
      parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`),
    );
  }
  const f = parsed.data;
  const severity = f.severity as Severity;
  const category = f.category as Category;
  const kind = f.kind as FindingKind;
  return {
    ruleId: f.ruleId,
    source: f.source,
    category,
    severity,
    confidence: Math.round(f.confidence * 100) / 100,
    kind,
    file: f.file.replace(/\\/g, "/").replace(/^\/+/, "").slice(0, 1024),
    startLine: f.startLine,
    endLine:
      f.endLine !== null && f.startLine !== null && f.endLine >= f.startLine ? f.endLine : f.startLine,
    title: f.title.trim().slice(0, 300),
    description: f.description.trim().slice(0, MAX_DESCRIPTION),
    evidence: f.evidence ? f.evidence.trim().slice(0, MAX_EVIDENCE) : null,
    suggestion: f.suggestion ? f.suggestion.trim().slice(0, MAX_EVIDENCE) : null,
    dedupKey: f.dedupKey.slice(0, 600),
  };
}

/** Findings are events, not noise: one identity per run, strongest wins. */
export function dedupeFindings(findings: Finding[]): Finding[] {
  const byKey = new Map<string, Finding>();
  for (const f of findings) {
    const existing = byKey.get(f.dedupKey);
    if (!existing) {
      byKey.set(f.dedupKey, f);
      continue;
    }
    byKey.set(f.dedupKey, strongerFinding(existing, f));
  }
  return [...byKey.values()];
}

/**
 * Batch-normalize a list of raw findings, dropping invalid entries instead of
 * throwing — a malformed finding must never break the review pipeline.
 */
export function normalizeFindings(inputs: unknown[]): Finding[] {
  const out: Finding[] = [];
  for (const input of inputs) {
    try {
      out.push(normalizeFinding(input));
    } catch {
      // Invalid finding dropped — logged by callers if it matters.
    }
  }
  return out;
}

const SEVERITY_ORDER: Severity[] = ["info", "low", "medium", "high", "critical"];

function strongerFinding(a: Finding, b: Finding): Finding {
  const sa = SEVERITY_ORDER.indexOf(a.severity);
  const sb = SEVERITY_ORDER.indexOf(b.severity);
  if (sb !== sa) return sb > sa ? b : a;
  return b.confidence > a.confidence ? b : a;
}
