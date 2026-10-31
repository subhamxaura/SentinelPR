export interface LatencyCandidate {
  testId: string;
  testName: string;
  p95Ms: number;
  thresholdMs: number;
  sampleCount: number;
}

export interface LatencyBreach extends LatencyCandidate {}

export const MIN_LATENCY_SAMPLES = 5;

/** Accept only measured, sufficiently sampled breaches from the database aggregation. */
export function qualifyLatencyBreaches(
  candidates: LatencyCandidate[],
  minSamples = MIN_LATENCY_SAMPLES,
): LatencyBreach[] {
  return candidates.filter((candidate) =>
    Number.isFinite(candidate.p95Ms) &&
    Number.isFinite(candidate.thresholdMs) &&
    candidate.thresholdMs > 0 &&
    Number.isInteger(candidate.sampleCount) &&
    candidate.sampleCount >= minSamples &&
    candidate.p95Ms > candidate.thresholdMs,
  );
}
