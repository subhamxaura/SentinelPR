import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { parseWebhookEvent, shouldReviewPullRequest, verifyWebhookSignature } from "./webhook";

const SECRET = "webhook-secret-test";

function sign(body: string | Buffer): string {
  const input = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  return `sha256=${createHmac("sha256", SECRET).update(input).digest("hex")}`;
}

describe("verifyWebhookSignature", () => {
  const body = JSON.stringify({ action: "opened", zen: "hakuna matata" });

  it("accepts a valid signature", () => {
    expect(verifyWebhookSignature(body, sign(body), SECRET)).toBe(true);
  });

  it("accepts a valid signature over raw bytes", () => {
    const raw = Buffer.from(body, "utf8");
    expect(verifyWebhookSignature(raw, sign(raw), SECRET)).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", () => {
    expect(verifyWebhookSignature(body, sign(body), "other-secret")).toBe(false);
  });

  it("rejects a signature over tampered bodies", () => {
    expect(verifyWebhookSignature(body + " ", sign(body), SECRET)).toBe(false);
  });

  it("rejects malformed headers", () => {
    expect(verifyWebhookSignature(body, null, SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "sha1=abcdef", SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "sha256=not-hex!", SECRET)).toBe(false);
  });
});

describe("parseWebhookEvent", () => {
  it("extracts PR and repository shapes", () => {
    const payload = {
      action: "opened",
      installation: { id: 42 },
      repository: { id: 7, full_name: "acme/app", private: false, default_branch: "main" },
      pull_request: {
        number: 5,
        id: 900,
        title: "Add payments",
        state: "open",
        draft: false,
        head: { sha: "cafe123", ref: "feat/pay" },
        base: { ref: "main" },
        user: { login: "dev", avatar_url: "http://a/b.png" },
        html_url: "https://github.com/acme/app/pull/5",
      },
    };
    const event = parseWebhookEvent(
      { "x-github-event": "pull_request", "x-github-delivery": "d-1" },
      payload,
    );
    expect(event.event).toBe("pull_request");
    expect(event.action).toBe("opened");
    expect(event.installationId).toBe(42);
    expect(event.repository?.fullName).toBe("acme/app");
    expect(event.pullRequest?.headSha).toBe("cafe123");
  });

  it("requires a delivery id", () => {
    expect(() => parseWebhookEvent({ "x-github-event": "ping" }, {})).toThrow();
  });
});

describe("shouldReviewPullRequest", () => {
  const pr = { draft: false };

  it("reviews opened, synchronize, reopened, ready_for_review", () => {
    for (const action of ["opened", "synchronize", "reopened", "ready_for_review"]) {
      expect(shouldReviewPullRequest("pull_request", action, pr)).toBe(true);
    }
  });

  it("ignores closed, draft, labels and other events", () => {
    expect(shouldReviewPullRequest("pull_request", "closed", pr)).toBe(false);
    expect(shouldReviewPullRequest("pull_request", "opened", { draft: true })).toBe(false);
    expect(shouldReviewPullRequest("pull_request", "labeled", pr)).toBe(false);
    expect(shouldReviewPullRequest("push", "opened", pr)).toBe(false);
    expect(shouldReviewPullRequest("pull_request", null, pr)).toBe(false);
  });
});
