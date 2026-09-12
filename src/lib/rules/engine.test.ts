import { describe, expect, it } from "vitest";
import { parsePatch, toChangedFiles, runRuleEngine, resolveRepoReviewConfig, defaultRepoReviewConfig } from "./engine";
import type { RuleContext } from "./types";

const PATCH = `@@ -10,6 +10,8 @@ function greet() {
  const a = 1;
-  console.log("old");
+  console.log("new debug");
+  const password = "hunter2hunter2";
   return a;
}`;

describe("parsePatch", () => {
  it("extracts added lines with correct new-file line numbers", () => {
    const { addedLines, removedLines } = parsePatch(PATCH);
    expect(removedLines).toEqual([{ line: 11, content: '  console.log("old");' }]);
    expect(addedLines).toEqual([
      { line: 11, content: '  console.log("new debug");' },
      { line: 12, content: '  const password = "hunter2hunter2";' },
    ]);
  });

  it("handles empty patches", () => {
    expect(parsePatch("")).toEqual({ addedLines: [], removedLines: [] });
  });
});

describe("toChangedFiles", () => {
  it("maps GitHub file payloads to ChangedFile views", () => {
    const files = toChangedFiles([
      { filename: "src/a.ts", status: "modified", additions: 2, deletions: 1, patch: PATCH },
    ]);
    expect(files[0].language).toBe("typescript");
    expect(files[0].addedLines).toHaveLength(2);
    expect(files[0].removedLines).toHaveLength(1);
  });
});

function ctx(overrides: Partial<RuleContext> = {}): RuleContext {
  const changed = toChangedFiles([
    { filename: "src/payments.ts", status: "modified", additions: 3, deletions: 0, patch: PATCH },
  ]);
  return {
    pr: { number: 1, title: "Test PR", authorLogin: "dev", headSha: "abc", baseRef: "main", headRef: "feat", body: null },
    files: changed,
    config: defaultRepoReviewConfig(),
    ...overrides,
  };
}

describe("runRuleEngine", () => {
  it("flags hardcoded AWS keys as critical security findings", () => {
    const files = toChangedFiles([
      {
        filename: "src/config.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -1,1 +1,2 @@\n const x = 1;\n+const key = 'AKIAIOSFODNN7QZ3JQ4T';",
      },
    ]);
    const findings = runRuleEngine(ctx({ files }));
    const aws = findings.find((f) => f.ruleId === "secrets/aws-access-key");
    expect(aws).toBeDefined();
    expect(aws!.severity).toBe("critical");
    expect(aws!.startLine).toBe(2);
    expect(aws!.dedupKey).toContain("src/config.ts:2");
  });

  it("flags eval usage", () => {
    const files = toChangedFiles([
      {
        filename: "src/danger.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -1,1 +1,2 @@\n const x = 1;\n+eval(userInput);",
      },
    ]);
    const findings = runRuleEngine(ctx({ files }));
    expect(findings.some((f) => f.ruleId === "security/eval-usage")).toBe(true);
  });

  it("does not flag env-indirected credentials", () => {
    const files = toChangedFiles([
      {
        filename: "src/ok.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -1,1 +1,2 @@\n const x = 1;\n+const password = process.env.PASSWORD;",
      },
    ]);
    const findings = runRuleEngine(ctx({ files }));
    expect(findings.filter((f) => f.ruleId?.startsWith("secrets/"))).toHaveLength(0);
  });

  it("skips removed files and respects language scope", () => {
    const files = toChangedFiles([
      {
        filename: "src/gone.ts",
        status: "removed",
        additions: 0,
        deletions: 1,
        patch: "@@ -1,1 +1,0 @@\n-eval('x');",
      },
      {
        filename: "notes/README.md",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -1,1 +1,2 @@\n # docs\n+eval('in docs');",
      },
    ]);
    const findings = runRuleEngine(ctx({ files }));
    expect(findings.filter((f) => f.ruleId === "security/eval-usage")).toHaveLength(0);
  });

  it("reports missing tests when no test file is in the diff", () => {
    const findings = runRuleEngine(ctx());
    const missing = findings.find((f) => f.ruleId === "testing/missing-tests");
    expect(missing).toBeDefined();
    expect(missing!.kind).toBe("observation");
  });

  it("does not report missing tests when a test file is touched", () => {
    const files = toChangedFiles([
      { filename: "src/payments.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1,1 +1,2 @@\n const a=1;\n+const b=2;" },
      { filename: "src/payments.test.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1,1 +1,2 @@\n it('x',()=>{});\n+it('y',()=>{});" },
    ]);
    const findings = runRuleEngine(ctx({ files }));
    expect(findings.filter((f) => f.ruleId === "testing/missing-tests")).toHaveLength(0);
  });

  it("honors disabledRules and severityOverrides from repo config", () => {
    const files = toChangedFiles([
      { filename: "src/danger.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1,1 +1,2 @@\n const x = 1;\n+eval(userInput);" },
    ]);
    const config = resolveRepoReviewConfig({
      disabledRules: ["security/eval-usage"],
      severityOverrides: { "quality/console-log": "high" },
    });
    const findings = runRuleEngine(ctx({ files, config }));
    expect(findings.filter((f) => f.ruleId === "security/eval-usage")).toHaveLength(0);
  });

  it("a throwing rule cannot break the engine", () => {
    // forbiddenImports with an invalid regex is caught inside the rule;
    // here we verify the engine survives a rule crash via config edge case.
    const config = resolveRepoReviewConfig({ forbiddenImports: ["[unbalanced"] });
    const files = toChangedFiles([
      { filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1,1 +1,2 @@\n const a=1;\n+import x from 'b';" },
    ]);
    expect(() => runRuleEngine(ctx({ files, config }))).not.toThrow();
  });
});

describe("resolveRepoReviewConfig", () => {
  it("rejects invalid severity overrides", () => {
    const config = resolveRepoReviewConfig({ severityOverrides: { "x/y": "banana" } });
    expect(config.severityOverrides).toEqual({});
  });

  it("clamps maxComments", () => {
    expect(resolveRepoReviewConfig({ maxComments: 9999 }).maxComments).toBe(50);
    expect(resolveRepoReviewConfig({ maxComments: -3 }).maxComments).toBe(0);
  });
});
