import { TDigest } from "tdigest";
import { cohortKey, type Venue } from "@tli/core";

/**
 * Streaming venue x age-bucket percentile engine (PRD Section 9, and the
 * design-doc note that this is NOT a query-time aggregation).
 *
 * Each (venue, ageBucket, metric) triple gets its own t-digest, updated
 * incrementally as trades/snapshots land — O(log n) per update, no
 * recomputation over historical data on read. Digest state is periodically
 * serialized to ClickHouse (see serialize/loadFrom) so the engine can
 * restart without losing distribution history.
 *
 * Compression is NOT called on every push (expensive); it's called on a
 * timer/count threshold by the caller (see COMPRESS_EVERY_N_PUSHES).
 */

export type MetricName =
  | "unique_buyers"
  | "unique_sellers"
  | "buy_volume_usd"
  | "holder_count"
  | "top10_concentration_pct";

const COMPRESS_EVERY_N_PUSHES = 500;

interface DigestEntry {
  digest: TDigest;
  pushesSinceCompress: number;
}

export interface SerializedDigest {
  key: string;
  centroids: Array<{ mean: number; n: number }>;
}

export class CohortPercentileEngine {
  private readonly digests = new Map<string, DigestEntry>();

  private keyFor(venue: Venue, ageSeconds: number, metric: MetricName): string {
    return `${cohortKey(venue, ageSeconds)}:${metric}`;
  }

  private getOrCreate(key: string): DigestEntry {
    let entry = this.digests.get(key);
    if (!entry) {
      entry = { digest: new TDigest(), pushesSinceCompress: 0 };
      this.digests.set(key, entry);
    }
    return entry;
  }

  /** Record one observation (e.g. a token's current unique-buyer count at its current age). */
  record(venue: Venue, ageSeconds: number, metric: MetricName, value: number): void {
    const key = this.keyFor(venue, ageSeconds, metric);
    const entry = this.getOrCreate(key);
    entry.digest.push(value);
    entry.pushesSinceCompress += 1;
    if (entry.pushesSinceCompress >= COMPRESS_EVERY_N_PUSHES) {
      entry.digest.compress();
      entry.pushesSinceCompress = 0;
    }
  }

  /**
   * Percentile rank (0-100) of `value` within its (venue, ageBucket, metric)
   * cohort. Returns null if the cohort has no data yet (cold start — the
   * caller should fall back to raw value only, per PRD Section 9's
   * raw+percentile pairing).
   */
  percentileRankOf(venue: Venue, ageSeconds: number, metric: MetricName, value: number): number | null {
    const key = this.keyFor(venue, ageSeconds, metric);
    const entry = this.digests.get(key);
    if (!entry || entry.digest.size() === 0) return null;
    const rank = entry.digest.p_rank(value) as number;
    if (rank === undefined || rank === null || Number.isNaN(rank)) return null;
    return Math.round(rank * 100);
  }

  /** Serialize all digests for persistence (ClickHouse cohort_percentile_state table). */
  serializeAll(): SerializedDigest[] {
    const out: SerializedDigest[] = [];
    for (const [key, entry] of this.digests.entries()) {
      entry.digest.compress();
      const centroids = entry.digest.toArray() as Array<{ mean: number; n: number }>;
      out.push({ key, centroids });
    }
    return out;
  }

  /** Rehydrate engine state on restart, so a process restart doesn't reset distributions to empty. */
  loadFrom(serialized: SerializedDigest[]): void {
    for (const { key, centroids } of serialized) {
      const digest = new TDigest();
      for (const c of centroids) {
        digest.push(c.mean, c.n);
      }
      digest.compress();
      this.digests.set(key, { digest, pushesSinceCompress: 0 });
    }
  }
}
