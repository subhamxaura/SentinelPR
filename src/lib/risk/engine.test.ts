import { describe, expect, it } from "vitest";
import { computeRisk } from "./engine";
import type { Finding } from "@/lib/types";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    ruleId: "test/rule",
    source: "rule",
    category: "maintainability",
    severity: "low",
    confidence: 0.9,
    kind: "finding",
    file: "src/a.ts",
    startLine: 1,
    endLine: 1,
    title: "Test finding",
    description: "desc",
    evidence: null,
    suggestion: null,
    dedupKey: "test/rule:src/a.ts:1",
    ...overrides,
  };
}

describe("computeRisk", () => {
  it("returns none with no signals", () => {
    const risk = computeRisk({ findings: [] });
    expect(risk.level).toBe("none");
    expect(risk.signals).toHaveLength(4);
    expect(risk.signals.every((s) => s.level === "none" || s.reasons.length > 0)).toBe(true);
  });

  it("high security findings force high overall risk", () => {
    const risk = computeRisk({
      findings: [finding({ category: "security", severity: "high", confidence: 0.95 })],
    });
    expect(risk.level).toBe("high");
    expect(risk.recommendedAction).toMatch(/security/i);
  });

  it("critical findings escalate to critical", () => {
    const risk = computeRisk({
      findings: [finding({ category: "security", severity: "critical", confidence: 0.95 })],
    });
    expect(risk.level).toBe("critical");
  });

  it("low-severity findings stay low", () => {
    const risk = computeRisk({ findings: [finding({ severity: "low" })] });
    expect(risk.level).toBe("low");
  });

  it("visual failures raise experience risk with reasons", () => {
    const risk = computeRisk({
      findings: [],
      visual: { total: 4, failed: 1, newBaselines: 0 },
    });
    expect(risk.level).toBe("medium");
    const experience = risk.signals.find((s) => s.dimension === "experience");
    expect(experience?.reasons.join(" ")).toMatch(/1\/4 visual/);
  });

  it("three or more visual failures mean high experience risk", () => {
    const risk = computeRisk({
      findings: [],
      visual: { total: 4, failed: 3, newBaselines: 0 },
    });
    const experience = risk.signals.find((s) => s.dimension === "experience");
    expect(experience?.level).toBe("high");
    expect(risk.level).toBe("high");
  });

  it("consecutive synthetic failures raise production risk", () => {
    const risk = computeRisk({
      findings: [],
      synthetic: { availability: 0.97, consecutiveFailures: 4, p95Ms: null, latencyThresholdMs: null },
    });
    const production = risk.signals.find((s) => s.dimension === "production");
    expect(production?.level).toBe("high");
    expect(risk.level).toBe("high");
  });

  it("is explainable: every non-none level has reasons", () => {
    const risk = computeRisk({
      findings: [finding({ category: "security", severity: "high" })],
      visual: { total: 2, failed: 1, newBaselines: 1 },
      synthetic: { availability: 0.93, consecutiveFailures: 1, p95Ms: 5000, latencyThresholdMs: 1000 },
    });
    expect(risk.level).toBe("high");
    for (const signal of risk.signals) {
      expect(signal.reasons.length).toBeGreaterThan(0);
    }
    expect(risk.score).toBeGreaterThan(0);
    expect(risk.score).toBeLessThanOrEqual(100);
  });
});
