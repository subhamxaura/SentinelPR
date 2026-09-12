import {
  RISK_LEVELS,
  SEVERITY_WEIGHT,
  SEVERITY_RANK,
  maxRisk,
  type Finding,
  type RiskAssessment,
  type RiskLevel,
  type RiskSignal,
  type Severity,
} from "@/lib/types";

/**
 * Unified Risk Engine — pure, deterministic, explainable.
 *
 * Code risk (review findings) + experience risk (visual/E2E) + production risk
 * (synthetic health) combine into one signal. Every level must trace back to
 * visible reasons; a mysterious score is a bug, not a feature.
 */

export interface RiskInput {
  findings: Finding[];
  visual?: { total: number; failed: number; newBaselines: number } | null;
  e2e?: { total: number; failed: number } | null;
  synthetic?: {
    availability: number | null; // 0..1 over the lookback window
    consecutiveFailures: number;
    p95Ms: number | null;
    latencyThresholdMs: number | null;
  } | null;
}

const SECURITY_BOOST = 1.25;

function levelFromScore(score: number): RiskLevel {
  if (score >= 70) return "critical";
  if (score >= 45) return "high";
  if (score >= 22) return "medium";
  if (score >= 3) return "low";
  return "none";
}

/** Security is judged more strictly than generic code quality. */
function securityLevelFromScore(score: number): RiskLevel {
  if (score >= 40) return "critical";
  if (score >= 18) return "high";
  if (score >= 8) return "medium";
  if (score >= 2) return "low";
  return "none";
}

export function computeRisk(input: RiskInput): RiskAssessment {
  const signals: RiskSignal[] = [];

  // ── Code risk: findings → weighted, saturating score ──────────────────
  const byCategory = new Map<string, Finding[]>();
  for (const f of input.findings) {
    const list = byCategory.get(f.category) ?? [];
    list.push(f);
    byCategory.set(f.category, list);
  }

  let codeScore = 0;
  const codeReasons: string[] = [];
  const securityReasons: string[] = [];
  for (const [category, findings] of byCategory) {
    // Saturating contribution per category: 1st finding counts most.
    const weights = findings
      .map((f) => SEVERITY_WEIGHT[f.severity] * (0.5 + f.confidence / 2))
      .sort((a, b) => b - a);
    let categoryScore = 0;
    weights.forEach((w, i) => {
      categoryScore += w * Math.pow(0.6, i);
    });
    const counts = summarizeSeverities(findings);
    const reason = `${category}: ${counts}`;
    if (category === "security") {
      categoryScore *= SECURITY_BOOST;
      securityReasons.push(reason);
    } else {
      codeReasons.push(reason);
    }
    codeScore += categoryScore;
  }
  const codeLevel = levelFromScore(Math.round(codeScore));

  // Security gets its own signal (it caps the overall level).
  const securityFindings = (byCategory.get("security") ?? []).filter(
    (f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK.high,
  );
  let securityScore = 0;
  {
    const weights = securityFindings
      .map((f) => SEVERITY_WEIGHT[f.severity] * (0.5 + f.confidence / 2))
      .sort((a, b) => b - a);
    weights.forEach((w, i) => {
      securityScore += w * Math.pow(0.6, i);
    });
    securityScore *= SECURITY_BOOST;
  }
  const secLevel = securityLevelFromScore(Math.round(securityScore));

  signals.push({
    dimension: "code",
    level: codeLevel,
    reasons: codeReasons.length ? codeReasons : ["No code findings in this run"],
  });
  signals.push({
    dimension: "security",
    level: secLevel,
    reasons: securityReasons.length
      ? securityReasons
      : ["No security findings in this run"],
  });

  // ── Experience risk: visual + E2E ─────────────────────────────────────
  let experienceLevel: RiskLevel = "none";
  const experienceReasons: string[] = [];
  const visual = input.visual;
  if (visual && visual.total > 0) {
    const failRatio = visual.failed / visual.total;
    if (visual.failed > 0) {
      experienceReasons.push(
        `${visual.failed}/${visual.total} visual comparison(s) failed the configured threshold`,
      );
    }
    if (visual.newBaselines > 0) {
      experienceReasons.push(
        `${visual.newBaselines} snapshot(s) have no approved baseline yet (new pages or browsers)`,
      );
    }
    if (visual.failed === 0 && visual.newBaselines === 0) {
      experienceReasons.push(`All ${visual.total} visual comparison(s) passed`);
    }
    experienceLevel =
      failRatio >= 0.5 || visual.failed >= 3
        ? "high"
        : visual.failed > 0
          ? "medium"
          : visual.newBaselines > 0
            ? "low"
            : "none";
  }
  if (input.e2e && input.e2e.total > 0) {
    if (input.e2e.failed > 0) {
      experienceReasons.push(
        `${input.e2e.failed}/${input.e2e.total} E2E journey(s) failed`,
      );
      experienceLevel = maxRisk(experienceLevel, "high");
    } else {
      experienceReasons.push(`All ${input.e2e.total} E2E journey(s) passed`);
    }
  }
  if (!input.visual && !input.e2e) {
    experienceReasons.push("No visual/E2E runs are attached to this change");
  }
  signals.push({ dimension: "experience", level: experienceLevel, reasons: experienceReasons });

  // ── Production risk: synthetic monitoring health ──────────────────────
  let productionLevel: RiskLevel = "none";
  const productionReasons: string[] = [];
  const synth = input.synthetic;
  if (synth) {
    if (synth.consecutiveFailures > 0) {
      productionReasons.push(`${synth.consecutiveFailures} consecutive synthetic failure(s)`);
    }
    if (synth.availability !== null) {
      const pct = (synth.availability * 100).toFixed(2);
      productionReasons.push(`Synthetic availability ${pct}% over the lookback window`);
      if (synth.availability < 0.95) productionLevel = maxRisk(productionLevel, "high");
      else if (synth.availability < 0.99) productionLevel = maxRisk(productionLevel, "medium");
    }
    if (synth.consecutiveFailures >= 3) productionLevel = maxRisk(productionLevel, "high");
    else if (synth.consecutiveFailures > 0) productionLevel = maxRisk(productionLevel, "medium");
    if (
      synth.p95Ms !== null &&
      synth.latencyThresholdMs !== null &&
      synth.p95Ms > synth.latencyThresholdMs
    ) {
      productionReasons.push(
        `P95 latency ${Math.round(synth.p95Ms)}ms exceeds the ${synth.latencyThresholdMs}ms threshold`,
      );
      productionLevel = maxRisk(productionLevel, "medium");
    }
    if (productionReasons.length === 0) {
      productionReasons.push("Synthetic monitors are healthy");
    }
  } else {
    productionReasons.push("No synthetic monitors configured — production health unknown");
  }
  signals.push({ dimension: "production", level: productionLevel, reasons: productionReasons });

  // ── Overall ───────────────────────────────────────────────────────────
  // Security high/critical and code critical cap the overall level.
  let overall: RiskLevel = "none";
  for (const s of signals) overall = maxRisk(overall, s.level);
  if (secLevel === "critical" || codeLevel === "critical") {
    overall = maxRisk(overall, "critical");
  }
  if (secLevel === "high") overall = maxRisk(overall, "high");

  const score = Math.min(
    100,
    Math.round(
      Math.max(codeScore, securityScore) +
        (experienceLevel === "high" ? 45 : experienceLevel === "medium" ? 25 : experienceLevel === "low" ? 8 : 0) *
          0.5 +
        (productionLevel === "high" ? 45 : productionLevel === "medium" ? 25 : productionLevel === "low" ? 8 : 0) *
          0.4,
    ),
  );

  return {
    level: overall,
    score,
    signals,
    recommendedAction: recommend(overall, input, securityFindings.length),
  };
}

function summarizeSeverities(findings: Finding[]): string {
  const counts = new Map<Severity, number>();
  for (const f of findings) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
  const order: Severity[] = ["critical", "high", "medium", "low", "info"];
  return order
    .filter((s) => counts.has(s))
    .map((s) => `${counts.get(s)} ${s}`)
    .join(", ");
}

function recommend(overall: RiskLevel, input: RiskInput, securityCount: number): string {
  if (securityCount > 0) {
    return `Resolve ${securityCount} security finding(s) before merge — committed credentials cannot be un-leaked.`;
  }
  if (input.visual && input.visual.failed > 0) {
    return "Review the visual diffs; either fix the regression or approve a new baseline deliberately.";
  }
  if (input.e2e && input.e2e.failed > 0) {
    return "Fix the failing E2E journey before merging — a critical user path is broken.";
  }
  switch (overall) {
    case "critical":
      return "Do not merge. Address the critical findings first.";
    case "high":
      return "Merge only after addressing high-severity findings.";
    case "medium":
      return "Reviewable — address medium findings or record a follow-up.";
    case "low":
      return "Low risk — optional cleanups noted inline.";
    default:
      return "No significant risk detected by the current signal set.";
  }
}
