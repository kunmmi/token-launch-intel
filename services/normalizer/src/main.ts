import { EventBus, VENUES, type Venue, type RawVenueEvent } from "@tli/core";
import { createAdapter, type AdapterMode } from "@tli/adapters";
import { CohortPercentileEngine } from "@tli/analytics";
import { db, percentileEngineState, PERCENTILE_ENGINE_SINGLETON_ID } from "@tli/db";
import { writeNormalizedLaunch } from "./write-launch.js";
import { writeNormalizedTrade } from "./write-trade.js";
import { getUniqueBuyerCount, getTokenLaunchInfo } from "./buyer-stats.js";

/**
 * Consumes raw events from all three venue streams (one consumer-group
 * reader per venue, run concurrently in this single process for M0 —
 * splitting into per-venue processes is a trivial follow-up if one venue's
 * volume starts starving the others).
 *
 * The percentile engine lives in-process here and is periodically persisted
 * to Postgres (percentile_engine_state, a single-row JSON blob — see
 * packages/db/src/schema/percentile.ts) on a timer, not on every event, to
 * decouple write cadence from trade volume. apps/web loads that row to
 * compute percentiles at render time (see apps/web/lib/percentile.ts).
 * ClickHouse remains the eventual right home for this per the design doc;
 * this is the same documented M0 compromise as the trades table.
 */
const PERSIST_INTERVAL_MS = 5000;
const mode: AdapterMode = process.env.ADAPTER_MODE === "live" ? "live" : "synthetic";
const consumerName = `normalizer-${process.pid}`;
const groupName = "normalizer";

const percentileEngine = new CohortPercentileEngine();
const bus = new EventBus();

async function consumeVenue(venue: Venue): Promise<void> {
  const adapter = createAdapter(venue, mode);
  await bus.ensureConsumerGroup(venue, groupName);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const messages = await bus.readGroup(venue, groupName, consumerName);
    for (const { id, event } of messages) {
      try {
        await processEvent(adapter.venue, event);
      } catch (err) {
        console.error(`[normalizer:${venue}] failed to process event ${event.txHash}`, err);
        // Deliberately still ack: a decode failure on a malformed/unexpected
        // event should not block the stream forever. Production version
        // needs a dead-letter queue here per the M0 design doc, not a bare
        // catch-and-continue.
      }
      await bus.ack(venue, groupName, id);
    }
  }
}

async function processEvent(venue: Venue, event: RawVenueEvent): Promise<void> {
  const adapter = createAdapter(venue, mode);

  if (event.kind === "launch") {
    const normalized = await adapter.normalizeLaunch(event);
    const { isNewLaunch } = await writeNormalizedLaunch(normalized);
    if (isNewLaunch) {
      console.log(`[normalizer:${venue}] wrote launch ${normalized.tokenTicker} (${normalized.tokenAddress})`);
    }
    return;
  }

  if (event.kind === "trade") {
    let normalized;
    try {
      normalized = await adapter.normalizeTrade(event);
    } catch {
      return; // e.g. synthetic mode's normalizeTrade intentionally throws "not implemented"
    }
    const { tokenId } = await writeNormalizedTrade(normalized);

    // Real unique-buyer count, recomputed from the trades table — see
    // buyer-stats.ts for why this is a live query rather than a
    // materialized counter at M0 scale. Feeds the percentile engine with
    // genuine on-chain activity instead of the synthetic placeholder this
    // used to record.
    if (normalized.side === "buy") {
      const launchInfo = await getTokenLaunchInfo(tokenId);
      if (launchInfo) {
        const buyerCount = await getUniqueBuyerCount(tokenId);
        const ageSeconds = Math.max(
          0,
          Math.floor(Date.now() / 1000) - Math.floor(launchInfo.launchTimestamp.getTime() / 1000),
        );
        percentileEngine.record(launchInfo.venue, ageSeconds, "unique_buyers", buyerCount);
        const percentile = percentileEngine.percentileRankOf(launchInfo.venue, ageSeconds, "unique_buyers", buyerCount);
        console.log(
          `[normalizer:${venue}] trade on ${normalized.tokenAddress.slice(0, 8)}... ` +
            `(unique buyers=${buyerCount}, venue-percentile=${percentile ?? "n/a"})`,
        );
      }
    }
    return;
  }
}

async function persistPercentileEngineState(): Promise<void> {
  const serialized = percentileEngine.serializeAll();
  if (serialized.length === 0) return; // nothing recorded yet
  await db
    .insert(percentileEngineState)
    .values({ id: PERCENTILE_ENGINE_SINGLETON_ID, state: serialized })
    .onConflictDoUpdate({
      target: percentileEngineState.id,
      set: { state: serialized, updatedAt: new Date() },
    });
  console.log(`[normalizer] persisted percentile engine state (${serialized.length} cohorts)`);
}

async function main() {
  await bus.connect();
  console.log(`[normalizer] starting consumers for venues: ${VENUES.join(", ")} (mode=${mode})`);
  setInterval(() => {
    persistPercentileEngineState().catch((err) => console.error("[normalizer] failed to persist percentile state", err));
  }, PERSIST_INTERVAL_MS);
  await Promise.all(VENUES.map((venue) => consumeVenue(venue)));
}

main().catch((err) => {
  console.error("[normalizer] fatal error", err);
  process.exit(1);
});
