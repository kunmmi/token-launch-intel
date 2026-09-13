import { db } from "./client.js";
import { chains, venues } from "./schema/index.js";

/**
 * Static reference data (Section 24: Chain/Venue entities). Run once against
 * a fresh database before starting the indexer/normalizer. Not meant to be
 * re-run as part of normal ingestion — chains/venues change rarely and
 * deliberately, not as a side effect of processing chain events.
 */
async function main() {
  await db
    .insert(chains)
    .values([
      { id: "solana", displayName: "Solana" },
      { id: "robinhood", displayName: "Robinhood Chain" },
      { id: "bnb", displayName: "BNB Chain" },
    ])
    .onConflictDoNothing();

  await db
    .insert(venues)
    .values([
      { id: "pump", displayName: "Pump.fun", chainId: "solana", registryStatus: "active", hasHostedApi: true },
      { id: "pons", displayName: "Pons", chainId: "robinhood", registryStatus: "active", hasHostedApi: false },
      { id: "flap", displayName: "Flap", chainId: "bnb", registryStatus: "active", hasHostedApi: false },
    ])
    .onConflictDoNothing();

  console.log("Seeded chains + venues.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
