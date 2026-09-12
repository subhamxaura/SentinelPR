// Shared domain vocabulary. Pure types only — safe to import anywhere.

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

export const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 40,
  high: 24,
  medium: 12,
  low: 5,
  info: 1,
};

export const CATEGORIES = [
  "correctness",
  "security",
  "performance",
  "maintainability",
  "architecture",
  "testing",
  "style",
  "documentation",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const FINDING_KINDS = [
  "finding",
  "warning",
  "observation",
  "recommendation",
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export type FindingSource = "rule" | "ai";

export interface Finding {
  ruleId: string | null;
  source: FindingSource;
  category: Category;
  severity: Severity;
  /** 0..1 — how sure the engine is. Findings below publication thresholds are stored but not commented. */
  confidence: number;
  kind: FindingKind;
  file: string;
  startLine: number | null;
  endLine: number | null;
  title: string;
  description: string;
  evidence: string | null;
  suggestion: string | null;
  /** Stable identity used to deduplicate within a run and across runs of the same PR. */
  dedupKey: string;
}

export const RISK_LEVELS = ["none", "low", "medium", "high", "critical"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const RISK_RANK: Record<RiskLevel, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export interface RiskSignal {
  dimension: "code" | "security" | "experience" | "production";
  level: RiskLevel;
  reasons: string[];
}

export interface RiskAssessment {
  level: RiskLevel;
  /** 0..100, explainable via signals — never shown without them. */
  score: number;
  signals: RiskSignal[];
  recommendedAction: string;
}

export type ReviewStatus = "queued" | "running" | "success" | "failure" | "error";

export const QUEUE_NAMES = {
  review: "sentinel.review",
  visual: "sentinel.visual",
  synthetic: "sentinel.synthetic",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}
