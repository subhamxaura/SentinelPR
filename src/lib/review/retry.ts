export function shouldRetryReviewFailure(opts: {
  retryable: boolean;
  attempt: number;
  maxAttempts: number;
}): boolean {
  if (!opts.retryable) return false;
  const attempt = Math.max(1, Math.trunc(opts.attempt));
  const maxAttempts = Math.max(1, Math.trunc(opts.maxAttempts));
  return attempt < maxAttempts;
}
