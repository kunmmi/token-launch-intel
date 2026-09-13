import { EventBus, VENUES, type Venue, type RawVenueEvent } from "@tli/core";
import { createAdapter, type AdapterMode } from "@tli/adapters";
import { CohortPercentileEngine } from "@tli/analytics";
import { writeNormalizedLaunch } from "./write-launch.js";
import { writeNormalizedTrade } from "./write-trade.js";
import { getUniqueBuyerCount, getTokenLaunchInfo } from "./buyer-stats.js";

/**
 * Consumes raw events from all three venue streams (one consumer-group
 * reader per venue, run concurrently in this single process for M0 —
 * splitting into per-venue processes is a trivial follow-up if one venue's
 * volume starts starving the others).
 *
 * NOTE on the percentile engine: it lives in-process here and is NOT yet
 * persisted to ClickHouse (packages/analytics' serialize/loadFrom exist for
 * exactly this, but the ClickHouse client isn't wired up in this pass — see
 * README "What's not built yet"). That means restarting this process resets
 * all percentile history. Acceptable for local pipeline verification, not
 * for anything resembling production.
 */
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

async function main() {
  await bus.connect();
  console.log(`[normalizer] starting consumers for venues: ${VENUES.join(", ")} (mode=${mode})`);
  await Promise.all(VENUES.map((venue) => consumeVenue(venue)));
}

main().catch((err) => {
  console.error("[normalizer] fatal error", err);
  process.exit(1);
});
