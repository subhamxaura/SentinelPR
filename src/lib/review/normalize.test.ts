import { describe, expect, it } from "vitest";
import { dedupeFindings, normalizeFinding, findingSchema } from "./normalize";
import { signArtifactToken, verifyArtifactToken } from "@/lib/env";
import { comparePngs } from "@/lib/visual/diff";
import { PNG } from "pngjs";

describe("normalizeFinding", () => {
  const valid = {
    ruleId: "secrets/aws-access-key",
    source: "rule",
    category: "security",
    severity: "critical",
    confidence: 0.95,
    kind: "finding",
    file: "src/config.ts",
    startLine: 3,
    endLine: 5,
    title: "Hardcoded AWS access key",
    description: "Key committed",
    evidence: "AKIA…",
    suggestion: "Rotate",
    dedupKey: "secrets/aws-access-key:src/config.ts:3",
  };

  it("accepts valid findings and normalizes line ranges", () => {
    const f = normalizeFinding(valid);
    expect(f.endLine).toBe(5);
    expect(f.file).toBe("src/config.ts");
  });

  it("drops endLine when it precedes startLine", () => {
    const f = normalizeFinding({ ...valid, endLine: 1 });
    expect(f.endLine).toBe(3);
  });

  it("rejects garbage", () => {
    expect(() => normalizeFinding({ severity: "banana" })).toThrow();
    expect(() => normalizeFinding(null)).toThrow();
  });

  it("schema rejects out-of-range confidence", () => {
    expect(findingSchema.safeParse({ ...valid, confidence: 1.5 }).success).toBe(false);
  });
});

describe("dedupeFindings", () => {
  const base = {
    ruleId: "a/b",
    source: "rule" as const,
    category: "security" as const,
    severity: "medium" as const,
    confidence: 0.7,
    kind: "finding" as const,
    file: "x.ts",
    startLine: 1,
    endLine: 1,
    title: "t",
    description: "d",
    evidence: null,
    suggestion: null,
    dedupKey: "a/b:x.ts:1",
  };

  it("keeps the strongest finding per dedupKey", () => {
    const kept = dedupeFindings([
      { ...base },
      { ...base, severity: "critical" as const, confidence: 0.5 },
      { ...base, dedupKey: "a/b:y.ts:2", severity: "low" as const },
    ]);
    expect(kept).toHaveLength(2);
    expect(kept.find((f) => f.dedupKey === "a/b:x.ts:1")?.severity).toBe("critical");
  });
});

describe("artifact tokens", () => {
  it("round-trips and expires", () => {
    const token = signArtifactToken({ artifactId: "a1", exp: Date.now() + 60_000 });
    expect(verifyArtifactToken(token)?.artifactId).toBe("a1");
    const expired = signArtifactToken({ artifactId: "a1", exp: Date.now() - 1000 });
    expect(verifyArtifactToken(expired)).toBeNull();
    expect(verifyArtifactToken("garbage")).toBeNull();
    expect(verifyArtifactToken(`${token}x`)).toBeNull();
  });
});

describe("comparePngs", () => {
  it("reports identical images as zero diff", () => {
    const png = PNG.sync.write(makePng(64, 64, [10, 20, 30]));
    const result = comparePngs(png, png);
    expect(result.diffRatio).toBe(0);
    expect(result.diffPng).toBeNull();
    expect(result.changedRegions).toHaveLength(0);
  });

  it("localizes a changed region when pixels differ", () => {
    const a = PNG.sync.write(makePng(64, 64, [10, 20, 30]));
    const b = PNG.sync.write(makePng(64, 64, [200, 200, 200]));
    const result = comparePngs(a, b);
    expect(result.diffRatio).toBeGreaterThan(0.5);
    expect(result.changedRegions.length).toBeGreaterThan(0);
    expect(result.diffPng).not.toBeNull();
  });

  it("treats size changes as a full mismatch", () => {
    const a = PNG.sync.write(makePng(64, 64, [1, 2, 3]));
    const b = PNG.sync.write(makePng(32, 64, [1, 2, 3]));
    const result = comparePngs(a, b);
    expect(result.diffRatio).toBe(1);
  });
});

function makePng(w: number, h: number, rgb: [number, number, number]): PNG {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    png.data[i * 4] = rgb[0];
    png.data[i * 4 + 1] = rgb[1];
    png.data[i * 4 + 2] = rgb[2];
    png.data[i * 4 + 3] = 255;
  }
  return png;
}
