/**
 * Age buckets used for BOTH the percentile cohort key (venue x age_bucket)
 * and the historical outcome-snapshot horizons (PRD Section 25). Keeping
 * them identical is deliberate: it means "what percentile was this launch
 * at when we later snapshot it at 5m" is always a well-defined question.
 *
 * Boundaries are expressed in seconds since launch (age zero = the venue's
 * token-creation transaction timestamp, never first-trade or first-seen-by-us
 * — see normalization spec).
 */
export const AGE_BUCKET_BOUNDARIES_SECONDS = [
  30, // 0-30s
  60, // 30s-1m
  120, // 1-2m
  300, // 2-5m
  900, // 5-15m
  3600, // 15-60m
  21600, // 1-6h
  86400, // 6-24h
  259200, // 1-3d
  2592000, // 3-30d
] as const;

export const AGE_BUCKET_LABELS = [
  "0-30s",
  "30s-1m",
  "1-2m",
  "2-5m",
  "5-15m",
  "15m-1h",
  "1-6h",
  "6-24h",
  "1-3d",
  "3-30d",
  "30d+",
] as const;
export type AgeBucketLabel = (typeof AGE_BUCKET_LABELS)[number];

/** Same horizons, expressed for the outcome-snapshot job (PRD Section 25). */
export const SNAPSHOT_HORIZONS_SECONDS = [
  30, 60, 300, 900, 3600, 21600, 86400, 259200, 604800, 2592000,
] as const;

/**
 * Maps an age-in-seconds to its cohort bucket label. Used identically by
 * the percentile engine (packages/analytics) and by anything that needs to
 * know "which cohort does this launch belong to right now".
 */
export function ageToBucketLabel(ageSeconds: number): AgeBucketLabel {
  for (let i = 0; i < AGE_BUCKET_BOUNDARIES_SECONDS.length; i++) {
    const boundary = AGE_BUCKET_BOUNDARIES_SECONDS[i];
    if (boundary !== undefined && ageSeconds < boundary) {
      const label = AGE_BUCKET_LABELS[i];
      if (label === undefined) {
        throw new Error(`age bucket label/boundary array mismatch at index ${i}`);
      }
      return label;
    }
  }
  return "30d+";
}

/** Cohort key as specified in PRD Section 9: simplified to venue x age for M0. */
export function cohortKey(venue: string, ageSeconds: number): string {
  return `${venue}:${ageToBucketLabel(ageSeconds)}`;
}
