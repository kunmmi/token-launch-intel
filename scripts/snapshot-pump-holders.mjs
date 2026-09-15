#!/usr/bin/env node
/**
 * Snapshots real holder concentration for recently-launched Pump tokens via
 * PumpAdapter.getHolderSnapshot (getTokenLargestAccounts + curve-reserve
 * exclusion — see packages/adapters/src/pump/real-adapter.ts for the full
 * method and the live verification behind it).
 *
 * Solana-only, deliberately: no free RPC path was found in this project for
 * the EVM venues' equivalent (Pons/Flap would need full Transfer-log
 * reconstruction or a paid indexer — out of scope here, documented in
 * README rather than silently skipped).
 *
 * Bounded to the newest N Pump tokens per run (not the whole historical
 * backlog) because getTokenLargestAccounts is a metered, comparatively
 * expensive RPC call even on a provider that allows it — this runs on a
 * schedule (see .github/workflows/refresh-live-data.yml) and must stay well
 * inside Alchemy's free-tier monthly compute-unit budget indefinitely, not
 * just in one test run.
 *
 * Run: DATABASE_URL=... SOLANA_RPC_URL=... node scripts/snapshot-pump-holders.mjs [tokenLimit]
 */
import { eq, and, desc } from "drizzle-orm";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

async function importDist(relativePath) {
  return import(pathToFileURL(path.join(REPO_ROOT, relativePath)).href);
}

const tokenLimit = Number(process.argv[2] ?? 10);

const { db, tokens, launches, holderSnapshots, percentileEngineState, PERCENTILE_ENGINE_SINGLETON_ID } =
  await importDist("packages/db/dist/index.js");
const { PumpAdapter } = await importDist("packages/adapters/dist/pump/real-adapter.js");
const { CohortPercentileEngine } = await importDist("packages/analytics/dist/index.js");

process.on("unhandledRejection", (err) => console.error("[holders] unhandled rejection (continuing):", err));
process.on("uncaughtException", (err) => console.error("[holders] uncaught exception (continuing):", err));

const adapter = new PumpAdapter(process.env.SOLANA_RPC_URL);
const percentileEngine = new CohortPercentileEngine();

// Loaded BEFORE recording this run's new observations — this script and
// seed-live-venue.mjs both read-modify-write the same singleton row, so
// loading first (then persisting the merged state after) is what makes that
// safe, rather than one script's run silently clobbering the other's.
async function loadExistingEngineState() {
  const [row] = await db
    .select({ state: percentileEngineState.state })
    .from(percentileEngineState)
    .where(eq(percentileEngineState.id, PERCENTILE_ENGINE_SINGLETON_ID))
    .limit(1);
  if (row) percentileEngine.loadFrom(row.state);
}

async function persistEngineState() {
  const serialized = percentileEngine.serializeAll();
  if (serialized.length === 0) return;
  await db
    .insert(percentileEngineState)
    .values({ id: PERCENTILE_ENGINE_SINGLETON_ID, state: serialized })
    .onConflictDoUpdate({ target: percentileEngineState.id, set: { state: serialized, updatedAt: new Date() } });
}

const recentPumpTokens = await db
  .select({ tokenId: tokens.id, address: tokens.address, ticker: tokens.ticker, launchTimestamp: launches.launchTimestamp })
  .from(launches)
  .innerJoin(tokens, eq(launches.tokenId, tokens.id))
  .where(and(eq(tokens.venueId, "pump")))
  .orderBy(desc(launches.launchTimestamp))
  .limit(tokenLimit);

await loadExistingEngineState();

let snapshotCount = 0;
for (const token of recentPumpTokens) {
  try {
    const snap = await adapter.getHolderSnapshot(token.address);
    await db.insert(holderSnapshots).values({
      tokenId: token.tokenId,
      totalSupplyRaw: snap.totalSupplyRaw,
      circulatingSupplyRaw: snap.circulatingSupplyRaw,
      topAccounts: snap.topAccounts,
      visibleHolderCount: snap.visibleHolderCount,
      top10ConcentrationPct: snap.top10ConcentrationPct,
    });
    if (snap.top10ConcentrationPct !== null) {
      const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - Math.floor(token.launchTimestamp.getTime() / 1000));
      percentileEngine.record("pump", ageSeconds, "top10_concentration_pct", snap.top10ConcentrationPct);
    }
    snapshotCount++;
    console.log(
      `[holders] ${token.ticker}: ${snap.visibleHolderCount} visible holders, ` +
        `top10=${snap.top10ConcentrationPct === null ? "—" : snap.top10ConcentrationPct.toFixed(1) + "%"}`,
    );
  } catch (err) {
    console.error(`[holders] failed snapshotting ${token.ticker} (${token.address}):`, err.message ?? err);
  }
}

await persistEngineState();
console.log(`\n✅ [holders] ${snapshotCount}/${recentPumpTokens.length} tokens snapshotted.`);
process.exit(0);
