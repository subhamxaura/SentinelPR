import type { FileRule, PullRequestRule, RawFinding, RuleContext } from "./types";

const TEST_FILE = /(^|\/)(__tests__|tests?|spec)\/|\.test\.|\.spec\.|_test\.|_spec\.|\/testdata\//i;
const VENDOR_PATH = /(^|\/)(vendor|node_modules|dist|build|coverage)\//i;
const CODE_EXT = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs|py|go|rb|java|kt|swift|rs|c|h|cpp|hpp|cs|php)$/i;

export const securityRules: FileRule[] = [
  {
    id: "security/eval-usage",
    name: "Dynamic code execution (eval / new Function)",
    description:
      "`eval` and `new Function` execute arbitrary strings as code. With any user- or repository-controlled input this becomes remote code execution, and it defeats bundler security guarantees.",
    category: "security",
    severity: "high",
    confidence: 0.9,
    kind: "finding",
    scope: "file",
    languages: ["typescript", "javascript"],
    enabled: true,
    check(file) {
      return collect(file.addedLines, /\beval\s*\(|new\s+Function\s*\(/, (line, content) => ({
        file: file.filename,
        startLine: line,
        endLine: line,
        title: "Dynamic code execution",
        description:
          "Dynamic evaluation of strings as code. If any part of the input is influenced by users, PR content, or external data, this is a code-injection vector.",
        evidence: truncate(content.trim(), 200),
        suggestion:
          "Replace with explicit branching, a lookup map, or a vetted parser. If genuinely unavoidable, sandbox it and document the input contract.",
      }));
    },
  },
  {
    id: "security/shell-execution",
    name: "Shell command execution with interpolation",
    description:
      "Building shell commands with template literals or concatenation allows command injection when any interpolated value is attacker-controlled.",
    category: "security",
    severity: "high",
    confidence: 0.75,
    kind: "finding",
    scope: "file",
    languages: ["typescript", "javascript"],
    enabled: true,
    check(file) {
      return collect(
        file.addedLines,
        /\b(exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(/,
        (line, content) => {
          const args = content.slice(content.indexOf("("));
          const interpolated = /\$\{|`|\+\s*[a-zA-Z_$]/.test(args);
          const shellFlag = /shell\s*:\s*true/.test(content);
          if (!interpolated && !shellFlag) return null;
          return {
            file: file.filename,
            startLine: line,
            endLine: line,
            title: shellFlag ? "Spawn with shell: true" : "Shell command built with interpolation",
            description:
              "The command is assembled from dynamic parts. A crafted value can escape the intended command and run arbitrary shell statements.",
            evidence: truncate(content.trim(), 200),
            suggestion:
              "Use execFile/spawn with an argument array (no shell), validate inputs against an allowlist, or use a dedicated library for the task.",
          };
        },
      );
    },
  },
  {
    id: "security/dangerous-html",
    name: "Raw HTML injection (dangerouslySetInnerHTML)",
    description:
      "Rendering raw HTML from strings bypasses React's escaping. Content from users, APIs, or PR descriptions becomes an XSS vector.",
    category: "security",
    severity: "medium",
    confidence: 0.85,
    kind: "warning",
    scope: "file",
    languages: ["typescript", "javascript"],
    enabled: true,
    check(file) {
      return collect(file.addedLines, /dangerouslySetInnerHTML/, (line, content) => ({
        file: file.filename,
        startLine: line,
        endLine: line,
        title: "Raw HTML injection",
        description:
          "dangerouslySetInnerHTML renders a string as HTML without escaping. Any untrusted source in that string enables cross-site scripting.",
        evidence: truncate(content.trim(), 200),
        suggestion: "Render text instead, or sanitize with DOMPurify (server-side if possible) before rendering.",
      }));
    },
  },
  {
    id: "security/env-file-committed",
    name: "Environment file committed",
    description:
      "Env files usually contain real credentials. Committed once, they remain retrievable from git history even after removal.",
    category: "security",
    severity: "high",
    confidence: 0.9,
    kind: "finding",
    scope: "file",
    enabled: true,
    check(file) {
      const isEnvFile = /(^|\/)\.env(\..+)?$/.test(file.filename);
      const isTemplate = /\.(example|sample|template|dist)$/.test(file.filename);
      if (!isEnvFile || isTemplate || file.status !== "added") return [];
      return [
        {
          file: file.filename,
          startLine: 1,
          title: ".env file added to the repository",
          description:
            "A new environment file is being committed. These files typically carry secrets and are easy to overlook in review.",
          evidence: file.filename,
          suggestion:
            "Add the file to .gitignore, commit a .env.example with placeholder keys instead, and rotate any values already pushed.",
        },
      ];
    },
  },
  {
    id: "security/package-install-script",
    name: "Package install script added",
    description:
      "pre/postinstall scripts run arbitrary code on every machine that installs the package, including CI and other developers' laptops.",
    category: "security",
    severity: "medium",
    confidence: 0.8,
    kind: "warning",
    scope: "file",
    pathPattern: /(^|\/)package\.json$/,
    enabled: true,
    check(file) {
      const findings: RawFinding[] = [];
      for (const { line, content } of file.addedLines) {
        if (!/"(preinstall|install|postinstall|prepublish|prepare)"\s*:/.test(content)) continue;
        findings.push({
          file: file.filename,
          startLine: line,
          endLine: line,
          title: "Package lifecycle script added",
          description:
            "Lifecycle scripts execute automatically on `install`. Review exactly what runs — this is the primary supply-chain execution path.",
          evidence: truncate(content.trim(), 200),
          suggestion:
            "Prefer explicit scripts (`build`, `setup`) that developers run knowingly. If required, document why it must run on install.",
        });
      }
      return findings;
    },
  },
  {
    id: "correctness/empty-catch",
    name: "Empty catch block",
    description:
      "Swallowing exceptions silently hides failures: data is corrupted, requests hang, and debugging becomes guesswork.",
    category: "correctness",
    severity: "medium",
    confidence: 0.8,
    kind: "finding",
    scope: "file",
    languages: ["typescript", "javascript"],
    enabled: true,
    check(file) {
      return collect(file.addedLines, /catch\s*(\([^)]*\))?\s*\{\s*\}/, (line, content) => ({
        file: file.filename,
        startLine: line,
        endLine: line,
        title: "Empty catch block",
        description: "The error is discarded without logging, wrapping, or recovery logic.",
        evidence: truncate(content.trim(), 200),
        suggestion:
          "Log with context and either handle the failure or rethrow a domain error. If intentionally ignored, add a comment stating why.",
      }));
    },
  },
];

export const qualityRules: FileRule[] = [
  {
    id: "quality/console-log",
    name: "console.log / console.debug left in code",
    description:
      "Ad-hoc console logging in application code leaks data to stdout and bypasses structured logging. Most debug statements should not ship.",
    category: "maintainability",
    severity: "low",
    confidence: 0.9,
    kind: "observation",
    scope: "file",
    languages: ["typescript", "javascript"],
    enabled: true,
    check(file) {
      if (TEST_FILE.test(file.filename) || VENDOR_PATH.test(file.filename)) return [];
      return collect(file.addedLines, /\bconsole\.(log|debug)\s*\(/, (line, content) => ({
        file: file.filename,
        startLine: line,
        endLine: line,
        title: "Console statement added",
        description:
          "Application code should use the project's structured logger so output is levels-aware, redacted, and queryable.",
        evidence: truncate(content.trim(), 200),
        suggestion: "Replace with the structured logger (src/lib/logger.ts) or remove before merge.",
      }));
    },
  },
  {
    id: "quality/debugger-statement",
    name: "debugger statement",
    description:
      "A `debugger` statement will pause execution for anyone running the code with devtools open.",
    category: "style",
    severity: "medium",
    confidence: 0.95,
    kind: "finding",
    scope: "file",
    languages: ["typescript", "javascript"],
    enabled: true,
    check(file) {
      return collect(file.addedLines, /(^|[^.\w])debugger\s*;?/, (line, content) => ({
        file: file.filename,
        startLine: line,
        endLine: line,
        title: "debugger statement left in code",
        description: "Debugging aids should not be merged; they break automated runs and production execution.",
        evidence: truncate(content.trim(), 120),
        suggestion: "Remove the statement.",
      }));
    },
  },
  {
    id: "maintainability/todo-without-issue",
    name: "TODO/FIXME without a tracked reference",
    description:
      "Untracked TODOs rot silently. Linking to an issue makes the follow-up work visible and schedulable.",
    category: "maintainability",
    severity: "info",
    confidence: 0.85,
    kind: "recommendation",
    scope: "file",
    enabled: true,
    check(file) {
      return collect(file.addedLines, /\b(TODO|FIXME|HACK)\b/i, (line, content) => {
        if (/#\d+|https?:\/\/|@ts-|eslint-disable|@?issue|jira/i.test(content)) return null;
        return {
          file: file.filename,
          startLine: line,
          endLine: line,
          title: "Untracked TODO",
          description:
            "This TODO has no issue reference, so the follow-up work has no owner and no tracker entry.",
          evidence: truncate(content.trim(), 160),
          suggestion: "Create an issue and reference it (e.g. `// TODO(#123): …`).",
        };
      });
    },
  },
  {
    id: "architecture/forbidden-import",
    name: "Forbidden import",
    description:
      "This repository declares certain imports as forbidden (layering, licensing, or security boundaries).",
    category: "architecture",
    severity: "medium",
    confidence: 0.9,
    kind: "finding",
    scope: "file",
    languages: ["typescript", "javascript"],
    enabled: true,
    check(file, ctx) {
      const patterns = ctx.config.forbiddenImports;
      if (!patterns?.length) return [];
      const findings: RawFinding[] = [];
      for (const { line, content } of file.addedLines) {
        const importMatch =
          /^\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|^\s*(?:import\s+|require\s*\(\s*)["']([^"']+)["']/.exec(
            content,
          );
        const source = importMatch?.[1] ?? importMatch?.[2];
        if (!source) continue;
        for (const pattern of patterns) {
          try {
            if (new RegExp(pattern).test(source)) {
              findings.push({
                file: file.filename,
                startLine: line,
                endLine: line,
                title: `Forbidden import: ${source}`,
                description: `Import of "${source}" matches a forbidden pattern configured for this repository ("${pattern}").`,
                evidence: truncate(content.trim(), 200),
                suggestion:
                  "Remove the import or update the repository's forbidden-import configuration if the boundary legitimately changed.",
              });
              break;
            }
          } catch {
            // invalid regex in repo config — skip this pattern, never crash the engine
          }
        }
      }
      return findings;
    },
  },
];

/**
 * PR-level structural rule: source files changed but no test files anywhere in
 * the diff. Stored as an observation — a signal for reviewers, not an accusation.
 */
export const missingTestsRule: PullRequestRule = {
  id: "testing/missing-tests",
  name: "No tests updated for changed source files",
  description:
    "Source code changed without any test file in the diff. Coverage gaps are how regressions survive review.",
  category: "testing",
  severity: "info",
  confidence: 0.75,
  kind: "observation",
  scope: "pull_request",
  enabled: true,
  check(ctx) {
    const sourceFiles = ctx.files.filter(
      (f) => CODE_EXT.test(f.filename) && !TEST_FILE.test(f.filename) && f.status !== "removed",
    );
    const testFiles = ctx.files.filter((f) => TEST_FILE.test(f.filename));
    if (!sourceFiles.length || testFiles.length > 0) return [];
    const biggest = sourceFiles.slice().sort((a, b) => b.additions - a.additions)[0];
    return [
      {
        file: biggest.filename,
        startLine: null,
        title: "No tests accompany these changes",
        description: `${sourceFiles.length} source file(s) changed and no test file was touched in this PR.`,
        evidence: `Changed source files: ${sourceFiles
          .map((f) => f.filename)
          .slice(0, 10)
          .join(", ")}`,
        suggestion:
          "Add or extend tests covering the new behavior, or note in the PR description why tests are not needed (pure refactor, docs, config).",
      },
    ];
  },
};

function collect(
  lines: { line: number; content: string }[],
  pattern: RegExp,
  build: (line: number, content: string) => RawFinding | null,
): RawFinding[] {
  const out: RawFinding[] = [];
  for (const { line, content } of lines) {
    if (!pattern.test(content)) continue;
    const built = build(line, content);
    if (built) out.push(built);
  }
  return out;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
