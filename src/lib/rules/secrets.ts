import type { FileRule, RawFinding, RuleContext } from "./types";

/**
 * Placeholder-looking values are not secrets. tuned to avoid the classic
 * `password: "..."` false positives in test fixtures and docs.
 */
const PLACEHOLDER = /(\$\{|\{\{|<[a-z_]+>|xxxx|changeme|your[_-]|example|dummy|placeholder|secret here|<[^>]+>|\.\.\.)/i;

interface SecretMatcher {
  idSuffix: string;
  pattern: RegExp;
  title: string;
  description: string;
  severity: "critical" | "high" | "medium";
  confidence: number;
  suggestion: string;
}

const MATCHERS: SecretMatcher[] = [
  {
    idSuffix: "aws-access-key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    title: "Hardcoded AWS access key",
    description:
      "A literal AWS access key ID (AKIA…) is committed. Anyone with repository access — or any leak of this source — gets AWS API access under your account.",
    severity: "critical",
    confidence: 0.95,
    suggestion: "Revoke the key in IAM immediately, rotate credentials, and load it from a secret manager or environment variable.",
  },
  {
    idSuffix: "github-token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
    title: "Hardcoded GitHub token",
    description: "A GitHub personal access / OAuth token appears to be committed in source.",
    severity: "critical",
    confidence: 0.95,
    suggestion: "Revoke the token at github.com/settings/tokens and inject it via environment variables or a secret manager.",
  },
  {
    idSuffix: "slack-token",
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
    title: "Hardcoded Slack token",
    description: "A Slack token (xox…) appears to be committed in source.",
    severity: "high",
    confidence: 0.9,
    suggestion: "Revoke the token in Slack app settings and provide it through the environment.",
  },
  {
    idSuffix: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
    title: "Hardcoded Google API key",
    description: "A Google API key is committed in source and can be extracted from the repository history.",
    severity: "high",
    confidence: 0.9,
    suggestion: "Restrict or rotate the key in Google Cloud console and load it from the environment.",
  },
  {
    idSuffix: "private-key-block",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY( BLOCK)?-----/,
    title: "Private key material committed",
    description: "A PEM private key block is present in the diff. This is the credential itself, not a reference to it.",
    severity: "critical",
    confidence: 0.98,
    suggestion: "Remove the key, rotate it, and mount it at runtime (secret manager / deploy key). Consider history scrubbing (git filter-repo).",
  },
  {
    idSuffix: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
    title: "Hardcoded JWT",
    description: "A JSON Web Token is committed. Even if short-lived, it leaks claims and can be replayed before expiry.",
    severity: "medium",
    confidence: 0.7,
    suggestion: "Fetch tokens at runtime from your auth provider; never commit issued tokens.",
  },
];

const GENERIC_ASSIGNMENT =
  /\b(api[_-]?key|apikey|secret|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|pwd|token)\b\s*[:=]{1,2}\s*(["'`])([^"'`\n]{8,})\2/i;

export function redactSecretContent(input: string): string {
  if (!input) return input;
  let s = input;
  // 1. AWS access key (e.g. AKIA...)
  s = s.replace(/\b(AKIA)[0-9A-Z]{16}\b/g, "$1••••••••••••••••");
  // 2. GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  s = s.replace(/\b(gh[pousr]_)[A-Za-z0-9]{30,}\b/g, "$1••••••••••••••••");
  // 3. Slack tokens (xoxb-, xoxa-, xoxp-, etc.)
  s = s.replace(/\b(xox[abprs]-)[A-Za-z0-9-]{10,}\b/g, "$1••••••••••••••••");
  // 4. Google API keys (AIza...)
  s = s.replace(/\b(AIza)[0-9A-Za-z_-]{35}\b/g, "$1••••••••••••••••");
  // 5. PEM private key blocks
  s = s.replace(
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY( BLOCK)?-----[\s\S]*?(?:-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY( BLOCK)?-----|$)/g,
    "-----BEGIN PRIVATE KEY-----\n[REDACTED PRIVATE KEY MATERIAL]\n-----END PRIVATE KEY-----",
  );
  // 6. JSON Web Tokens
  s = s.replace(
    /\b(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    "$1.••••••••.••••••••",
  );
  // 7. Generic assignments (password, secret, token, api_key = "...")
  s = s.replace(
    /\b((?:api[_-]?key|apikey|secret|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|pwd|token)\b\s*[:=]{1,2}\s*(["'`]))[^"'`\n]{8,}(\2)/gi,
    "$1••••••••$3",
  );
  return s;
}

export const secretRules: FileRule[] = [
  ...MATCHERS.map((m) => ({
    id: `secrets/${m.idSuffix}`,
    name: m.title,
    description: m.description,
    category: "security" as const,
    severity: m.severity,
    confidence: m.confidence,
    kind: "finding" as const,
    scope: "file" as const,
    enabled: true,
    check(file: import("./types").ChangedFile, _ctx: RuleContext) {
      const findings: RawFinding[] = [];
      for (const { line, content } of file.addedLines) {
        if (PLACEHOLDER.test(content)) continue;
        if (m.pattern.test(content)) {
          findings.push({
            file: file.filename,
            startLine: line,
            endLine: line,
            title: m.title,
            description: m.description,
            evidence: truncate(redactSecretContent(content.trim()), 160),
            suggestion: m.suggestion,
          });
          break; // one finding per file per matcher keeps noise down
        }
      }
      return findings;
    },
  })),
  {
    id: "secrets/generic-assignment",
    name: "Possible hardcoded credential",
    description:
      "A credential-looking identifier (password, secret, api key, token) is assigned a literal string value. If this is real, it is a leak; if not, rename it to make intent obvious.",
    category: "security",
    severity: "high",
    confidence: 0.6,
    kind: "warning",
    scope: "file",
    enabled: true,
    check(file, ctx) {
      const findings = [];
      for (const { line, content } of file.addedLines) {
        if (PLACEHOLDER.test(content)) continue;
        // Skip obvious environment indirection like `password: process.env.PASSWORD`
        if (/process\.env|import\.meta\.env|os\.environ|getenv|ENV\[|config\./i.test(content)) continue;
        const match = GENERIC_ASSIGNMENT.exec(content);
        if (match) {
          findings.push({
            file: file.filename,
            startLine: line,
            endLine: line,
            title: "Possible hardcoded credential",
            description:
              "This line assigns a literal value to a credential-named variable. Committed credentials outlive the PR — they remain in git history forever.",
            evidence: truncate(redactSecretContent(match[0].trim()), 160),
            suggestion:
              "Load the value from an environment variable or secret manager. If this is a non-secret, rename the variable (e.g. `passwordPlaceholder`).",
          });
        }
      }
      return findings;
    },
  },
];

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
