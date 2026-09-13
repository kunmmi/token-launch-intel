import { EventBus, VENUES, type Venue } from "@tli/core";
import { createAdapter, type AdapterMode } from "@tli/adapters";

/**
 * Persistent worker process (per PRD Section 41: "blockchain event ingestion
 * services should not depend on serverless execution... they need
 * persistent workers"). One process per venue — run three of these, one per
 * VENUE env var, rather than one process handling all three, so a crash or
 * slowdown on one venue's chain never blocks the others (this is also why
 * the event bus is one Redis Stream per venue, not one shared stream).
 */
const venue = process.env.VENUE as Venue | undefined;
if (!venue || !VENUES.includes(venue)) {
  console.error(`[indexer] VENUE env var must be one of: ${VENUES.join(", ")}. Got: ${venue}`);
  process.exit(1);
}

const mode: AdapterMode = process.env.ADAPTER_MODE === "live" ? "live" : "synthetic";
if (mode === "synthetic") {
  console.warn(
    `[indexer:${venue}] running in SYNTHETIC mode — emitting fake data for pipeline verification only. ` +
      `Set ADAPTER_MODE=live once the ${venue} real adapter is implemented (see packages/adapters/src/${venue}/real-adapter.ts).`,
  );
}

const adapter = createAdapter(venue, mode);
const bus = new EventBus();

async function main() {
  await bus.connect();
  console.log(`[indexer:${venue}] starting discover() loop`);
  await adapter.discover(async (event) => {
    await bus.publish(event);
    console.log(`[indexer:${venue}] published ${event.kind} event ${event.txHash}`);
  });
}

main().catch((err) => {
  console.error(`[indexer:${venue}] fatal error`, err);
  process.exit(1);
});
