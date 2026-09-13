import { db, percentileEngineState, PERCENTILE_ENGINE_SINGLETON_ID } from "@tli/db";
import { eq } from "drizzle-orm";
import { CohortPercentileEngine, type MetricName, type SerializedDigest } from "@tli/analytics";
import type { Venue } from "@tli/core";

/**
 * Loads the normalizer's periodically-persisted percentile engine state
 * (packages/db/src/schema/percentile.ts) and reconstructs a usable
 * CohortPercentileEngine. Reloaded per request rather than cached
 * in-process — fine at M0 read volume; revisit if this becomes a hot path.
 */
export async function loadPercentileEngine(): Promise<CohortPercentileEngine | null> {
  const [row] = await db
    .select({ state: percentileEngineState.state })
    .from(percentileEngineState)
    .where(eq(percentileEngineState.id, PERCENTILE_ENGINE_SINGLETON_ID))
    .limit(1);
  if (!row) return null;

  const engine = new CohortPercentileEngine();
  engine.loadFrom(row.state as SerializedDigest[]);
  return engine;
}

/** Percentile rank (0-100) for a token's value on `metric` at its current age, or null if unavailable. */
function metricPercentile(
  engine: CohortPercentileEngine | null,
  venue: Venue,
  launchTimestamp: Date,
  metric: MetricName,
  value: number | null,
): number | null {
  if (!engine || value === null) return null;
  const ageSeconds = Math.max(0, Math.floor((Date.now() - launchTimestamp.getTime()) / 1000));
  return engine.percentileRankOf(venue, ageSeconds, metric, value);
}

export function buyerPercentile(
  engine: CohortPercentileEngine | null,
  venue: Venue,
  launchTimestamp: Date,
  buyerCount: number | null,
): number | null {
  return metricPercentile(engine, venue, launchTimestamp, "unique_buyers", buyerCount);
}

/** Percentile rank (0-100) for a token's unique-seller count at its current age, or null if unavailable. */
export function sellerPercentile(
  engine: CohortPercentileEngine | null,
  venue: Venue,
  launchTimestamp: Date,
  sellerCount: number | null,
): number | null {
  return metricPercentile(engine, venue, launchTimestamp, "unique_sellers", sellerCount);
}
