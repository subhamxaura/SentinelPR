import { securityRules, qualityRules, missingTestsRule } from "./code-rules";
import { secretRules } from "./secrets";
import { languageOf, parsePatch } from "./types";
import type { ChangedFile, FileRule, PullRequestRule, RepoReviewConfig, Rule, RuleContext } from "./types";
import { normalizeFindings } from "@/lib/review/normalize";
import type { Finding, Severity } from "@/lib/types";

export * from "./types";

export const ALL_RULES: Rule[] = [...secretRules, ...securityRules, ...qualityRules, missingTestsRule];

export function ruleById(id: string): Rule | undefined {
  return ALL_RULES.find((r) => r.id === id);
}

export function defaultRepoReviewConfig(): RepoReviewConfig {
  return {
    disabledRules: [],
    severityOverrides: {},
    maxComments: 10,
    confidenceThreshold: 0.6,
    publishSeverities: ["critical", "high", "medium"],
    forbiddenImports: [],
  };
}

const CONFIG_SHAPE: RepoReviewConfig = defaultRepoReviewConfig();

/** Merge a repository's stored JSON config over safe defaults (never trusts unknown keys). */
export function resolveRepoReviewConfig(raw: unknown): RepoReviewConfig {
  if (!raw || typeof raw !== "object") return CONFIG_SHAPE;
  const input = raw as Record<string, unknown>;
  return {
    disabledRules: Array.isArray(input.disabledRules)
      ? input.disabledRules.filter((x): x is string => typeof x === "string")
      : CONFIG_SHAPE.disabledRules,
    severityOverrides:
      input.severityOverrides && typeof input.severityOverrides === "object"
        ? Object.fromEntries(
            Object.entries(input.severityOverrides as Record<string, unknown>).filter(
              (entry): entry is [string, Severity] =>
                typeof entry[1] === "string" &&
                ["critical", "high", "medium", "low", "info"].includes(entry[1]),
            ),
          )
        : CONFIG_SHAPE.severityOverrides,
    maxComments: clampInt(input.maxComments, 0, 50, CONFIG_SHAPE.maxComments),
    confidenceThreshold: clampFloat(input.confidenceThreshold, 0, 1, CONFIG_SHAPE.confidenceThreshold),
    publishSeverities: Array.isArray(input.publishSeverities)
      ? input.publishSeverities.filter(
          (x): x is Severity => typeof x === "string" && ["critical", "high", "medium", "low", "info"].includes(x),
        )
      : CONFIG_SHAPE.publishSeverities,
    forbiddenImports: Array.isArray(input.forbiddenImports)
      ? input.forbiddenImports.filter((x): x is string => typeof x === "string")
      : CONFIG_SHAPE.forbiddenImports,
  };
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}

function clampFloat(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Build ChangedFile views from GitHub "files" API payloads. */
export function toChangedFiles(
  files: Array<{
    filename: string;
    previous_filename?: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
  }>,
): ChangedFile[] {
  return files.map((f) => {
    const parsed = f.patch ? parsePatch(f.patch) : { addedLines: [], removedLines: [] };
    return {
      filename: f.filename,
      previousFilename: f.previous_filename,
      status: (["added", "removed", "modified", "renamed", "changed", "unchanged"].includes(f.status)
        ? f.status
        : "changed") as ChangedFile["status"],
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch,
      addedLines: parsed.addedLines,
      removedLines: parsed.removedLines,
      language: languageOf(f.filename),
    };
  });
}

/**
 * Run every applicable rule over the PR. Deterministic — no AI, no network.
 * Returns normalized findings ready for persistence.
 */
export function runRuleEngine(ctx: RuleContext): Finding[] {
  const findings: Finding[] = [];
  const disabled = new Set(ctx.config.disabledRules);

  for (const rule of ALL_RULES) {
    if (!rule.enabled || disabled.has(rule.id)) continue;
    const override = ctx.config.severityOverrides[rule.id] as Severity | undefined;

    const raws =
      rule.scope === "file"
        ? ctx.files.flatMap((file) => {
            if (file.status === "removed") return [];
            if (rule.languages && !rule.languages.includes(file.language)) return [];
            if (rule.pathPattern && !rule.pathPattern.test(file.filename)) return [];
            let raws: ReturnType<FileRule["check"]> = [];
            try {
              raws = rule.check(file, ctx);
            } catch {
              // A broken rule must never break the review pipeline.
              return [];
            }
            return raws.map((raw) => ({ raw, ruleId: rule.id }));
          })
        : (() => {
            let raws: ReturnType<PullRequestRule["check"]> = [];
            try {
              raws = rule.check(ctx);
            } catch {
              return [];
            }
            return raws.map((raw) => ({ raw, ruleId: rule.id }));
          })();

    for (const { raw, ruleId } of raws) {
      findings.push({
        ruleId,
        source: "rule",
        category: raw.category ?? rule.category,
        severity: override ?? raw.severity ?? rule.severity,
        confidence: raw.confidence ?? rule.confidence,
        kind: raw.kind ?? rule.kind,
        file: raw.file,
        startLine: raw.startLine,
        endLine: raw.endLine ?? null,
        title: raw.title,
        description: raw.description,
        evidence: raw.evidence ?? null,
        suggestion: raw.suggestion ?? null,
        dedupKey: `${ruleId}:${raw.file}:${raw.startLine ?? 0}`,
      });
    }
  }
  return normalizeFindings(findings);
}
