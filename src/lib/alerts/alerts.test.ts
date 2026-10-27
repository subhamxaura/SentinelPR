import { describe, it, expect } from "vitest";
import { redactSecretContent } from "@/lib/rules/secrets";

describe("Secret Redaction Across Credential Formats & Alert Payloads", () => {
  it("redacts AWS access keys", () => {
    const rawKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const raw = `Found AWS key ${rawKey} in commit`;
    const redacted = redactSecretContent(raw);
    expect(redacted).not.toContain(rawKey);
    expect(redacted).toContain("AKIA••••••••••••••••");
  });

  it("redacts GitHub personal access tokens", () => {
    const rawToken = ["ghp", "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"].join("_");
    const raw = `Found token ${rawToken} in config`;
    const redacted = redactSecretContent(raw);
    expect(redacted).not.toContain(rawToken);
    expect(redacted).toContain("ghp_••••••••••••••••");
  });

  it("redacts Slack tokens", () => {
    const rawToken = ["xoxb", "123456789012", "3456789012345", "abcdefghijklmnopqrstuv"].join("-");
    const raw = `Slack bot token ${rawToken}`;
    const redacted = redactSecretContent(raw);
    expect(redacted).not.toContain(rawToken);
    expect(redacted).toContain("xoxb-••••••••••••••••");
  });

  it("redacts Google API keys", () => {
    const rawKey = ["AIzaSyD", "1234567890abcdef1234567890abcde"].join("-");
    const raw = `Google key ${rawKey}`;
    const redacted = redactSecretContent(raw);
    expect(redacted).not.toContain(rawKey);
    expect(redacted).toContain("AIza••••••••••••••••");
  });

  it("redacts PEM private key blocks", () => {
    const raw = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Y1W9X...
secret private key material
-----END RSA PRIVATE KEY-----`;
    const redacted = redactSecretContent(raw);
    expect(redacted).not.toContain("secret private key material");
    expect(redacted).toContain("[REDACTED PRIVATE KEY MATERIAL]");
  });

  it("redacts JSON Web Tokens (JWT)", () => {
    const raw = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const redacted = redactSecretContent(raw);
    expect(redacted).not.toContain("SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c");
    expect(redacted).toContain("••••••••");
  });

  it("redacts generic credential assignments in alert titles and descriptions", () => {
    const rawTitle = 'Security finding: password = "SuperSecretPassword123!" in auth.ts';
    const redacted = redactSecretContent(rawTitle);
    expect(redacted).not.toContain("SuperSecretPassword123!");
    expect(redacted).toContain('password = "••••••••"');
  });

  it("handles mixed case, punctuation, and multiline content safely", () => {
    const raw = `api_key: "mySecretKey12345"\nClient_Secret = 'AnotherSecret999'`;
    const redacted = redactSecretContent(raw);
    expect(redacted).not.toContain("mySecretKey12345");
    expect(redacted).not.toContain("AnotherSecret999");
  });
});
