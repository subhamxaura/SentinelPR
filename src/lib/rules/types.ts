import type { Category, FindingKind, Severity } from "@/lib/types";

/** A file changed in a PR, with added/removed lines recovered from the unified patch. */
export interface ChangedFile {
  filename: string;
  previousFilename?: string;
  status: "added" | "removed" | "modified" | "renamed" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  patch?: string;
  /** Added lines with their line numbers in the NEW file. */
  addedLines: { line: number; content: string }[];
  removedLines: { line: number; content: string }[];
  language: string;
}

export interface PullRequestContext {
  number: number;
  title: string;
  authorLogin: string | null;
  headSha: string;
  baseRef: string | null;
  headRef: string | null;
  body: string | null;
}

export interface RepoReviewConfig {
  disabledRules: string[];
  severityOverrides: Record<string, Severity>;
  /** Max inline GitHub comments per review run. */
  maxComments: number;
  /** Min confidence for a finding to be published inline. */
  confidenceThreshold: number;
  /** Severities that get published inline (lower severities are stored only). */
  publishSeverities: Severity[];
  /** Regex sources treated as forbidden imports (architecture rule). */
  forbiddenImports: string[];
}

export interface RuleContext {
  pr: PullRequestContext;
  files: ChangedFile[];
  config: RepoReviewConfig;
}

/** A rule emits raw findings; the engine fills identity/defaults and normalizes. */
export interface RawFinding {
  file: string;
  startLine: number | null;
  endLine?: number | null;
  title: string;
  description: string;
  evidence?: string | null;
  suggestion?: string | null;
  severity?: Severity;
  confidence?: number;
  category?: Category;
  kind?: FindingKind;
}

export interface FileRule {
  id: string;
  name: string;
  description: string;
  category: Category;
  severity: Severity;
  confidence: number;
  kind: FindingKind;
  scope: "file";
  languages?: string[];
  pathPattern?: RegExp;
  enabled: boolean;
  check(file: ChangedFile, ctx: RuleContext): RawFinding[];
}

export interface PullRequestRule {
  id: string;
  name: string;
  description: string;
  category: Category;
  severity: Severity;
  confidence: number;
  kind: FindingKind;
  scope: "pull_request";
  enabled: boolean;
  check(ctx: RuleContext): RawFinding[];
}

export type Rule = FileRule | PullRequestRule;

const EXT_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  go: "go",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  rs: "rust",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  sql: "sql",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  md: "markdown",
  html: "html",
  css: "css",
  scss: "scss",
};

export function languageOf(filename: string): string {
  const base = filename.split("/").pop() ?? filename;
  if (base.toLowerCase() === "dockerfile") return "dockerfile";
  if (base.toLowerCase().startsWith("makefile")) return "makefile";
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  return EXT_LANGUAGE[ext] ?? "text";
}

/**
 * Extract added/removed lines with new/old file line numbers from a unified diff
 * patch (as returned by the GitHub "files" API). Pure and unit-tested.
 */
export function parsePatch(patch: string): {
  addedLines: { line: number; content: string }[];
  removedLines: { line: number; content: string }[];
} {
  const addedLines: { line: number; content: string }[] = [];
  const removedLines: { line: number; content: string }[] = [];
  let newLine = 0;
  let oldLine = 0;

  for (const rawLine of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(rawLine);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      continue;
    }
    if (rawLine.startsWith("+")) {
      addedLines.push({ line: newLine, content: rawLine.slice(1) });
      newLine += 1;
    } else if (rawLine.startsWith("-")) {
      removedLines.push({ line: oldLine, content: rawLine.slice(1) });
      oldLine += 1;
    } else if (rawLine.startsWith(" ") || rawLine === "") {
      // Context line (and the trailing empty string from split).
      if (rawLine.startsWith(" ")) {
        oldLine += 1;
        newLine += 1;
      }
    }
    // "\" markers ("\ No newline at end of file") — ignore.
  }
  return { addedLines, removedLines };
}
