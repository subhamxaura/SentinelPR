import { describe, expect, it } from "vitest";
import { shouldRetryReviewFailure } from "./retry";

describe("shouldRetryReviewFailure", () => {
  it("retries retryable errors while attempts remain", () => {
    expect(shouldRetryReviewFailure({ retryable: true, attempt: 1, maxAttempts: 3 })).toBe(true);
    expect(shouldRetryReviewFailure({ retryable: true, attempt: 2, maxAttempts: 3 })).toBe(true);
  });

  it("stops after the final attempt", () => {
    expect(shouldRetryReviewFailure({ retryable: true, attempt: 3, maxAttempts: 3 })).toBe(false);
    expect(shouldRetryReviewFailure({ retryable: true, attempt: 4, maxAttempts: 3 })).toBe(false);
  });

  it("never retries non-retryable failures", () => {
    expect(shouldRetryReviewFailure({ retryable: false, attempt: 1, maxAttempts: 3 })).toBe(false);
  });

  it("normalizes invalid attempt values", () => {
    expect(shouldRetryReviewFailure({ retryable: true, attempt: 0, maxAttempts: 1 })).toBe(false);
    expect(shouldRetryReviewFailure({ retryable: true, attempt: 1, maxAttempts: 0 })).toBe(false);
  });
});
