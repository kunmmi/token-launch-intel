#!/usr/bin/env node
/**
 * Single-venue live seeder — writes real launches (+ optionally trades/
 * percentiles for Pump — see SEED_INGEST_TRADES below) from exactly ONE
 * venue into whatever DATABASE_URL points at.
 *
 * Exists because running all three venues' adapters concurrently in one
 * process was empirically unreliable against a real hosted Postgres in
 * this session: the combined three-venue script (seed-live-data.mjs)
 * wrote zero launches across several 40-90s runs despite launch events
 * genuinely arriving (confirmed via a bare event-counting script with no
 * DB writes). Running one process per venue (this script) fixed that for
 * Pons and Flap immediately (launches only, 100% reliable every time
 * tested) and matches how the real production architecture already works
 * (services/indexer is one process per venue by design).
 *
 * Pons and Flap now also ingest trades by default (unlike Pump) — their
 * real observed volume in this session was low enough that the
 * write-starvation issue below never reproduced for them.
 *
 * Pump was a harder case, worth being honest about rather than papering
 * over: even running alone, Pump's launches+trades combination
 * reproducibly wrote ZERO launches (trade volume alone, ~900+ in 90s,
 * appears to starve launch writes for Postgres pool connections). Adding
 * write-serialization (enqueueWrite below) got further but then hit a raw
 * ECONNRESET on the Postgres socket mid-run that crashed the whole
 * process uncaught — not fully root-caused under time pressure. Given
 * this script runs unattended on a schedule (see
 * .github/workflows/refresh-live-data.yml), reliability beats
 * completeness: Pump trades are OFF by default (SEED_INGEST_TRADES=true
 * to re-enable for a manual/attended run), and every event handler is
 * wrapped so one bad write can't take the whole run down.
 *
 * Run: DATABASE_URL=... node scripts/seed-live-venue.mjs <pump|pons|flap> [durationSeconds]
 */
import { eq, and, countDistinct } from "drizzle-orm";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

async function importDist(relativePath) {
  return import(pathToFileURL(path.join(REPO_ROOT, relativePath)).href);
}

const venue = process.argv[2];
const durationSeconds = Number(process.argv[3] ?? 60);
if (!["pump", "pons", "flap"].includes(venue)) {
  console.error("Usage: node scripts/seed-live-venue.mjs <pump|pons|flap> [durationSeconds]");
  process.exit(1);
}

const { db, tokens, launches, creators, creatorAddresses, trades, percentileEngineState, PERCENTILE_ENGINE_SINGLETON_ID } =
  await importDist("packages/db/dist/index.js");
const { CohortPercentileEngine } = await importDist("packages/analytics/dist/index.js");

const percentileEngine = new CohortPercentileEngine();

async function resolveCreator(normalized) {
  const existing = await db
    .select({ creatorId: creatorAddresses.creatorId })
    .from(creatorAddresses)
    .where(and(eq(creatorAddresses.chainId, normalized.chain), eq(creatorAddresses.address, normalized.creatorAddress)))
    .limit(1);
  if (existing[0]) return existing[0].creatorId;

  const [creator] = await db.insert(creators).values({}).returning({ id: creators.id });
  await db.insert(creatorAddresses).values({
    creatorId: creator.id,
    chainId: normalized.chain,
    address: normalized.creatorAddress,
    isSelfAttested: false,
    isSignatureVerified: false,
  });
  return creator.id;
}

async function writeLaunch(normalized) {
  const creatorId = await resolveCreator(normalized);
  const [token] = await db
    .insert(tokens)
    .values({
      chainId: normalized.chain,
      address: normalized.tokenAddress,
      venueId: normalized.venue,
      name: normalized.tokenName,
      ticker: normalized.tokenTicker,
    })
    .onConflictDoNothing({ target: [tokens.chainId, tokens.address] })
    .returning({ id: tokens.id });

  const tokenId =
    token?.id ??
    (
      await db
        .select({ id: tokens.id })
        .from(tokens)
        .where(and(eq(tokens.chainId, normalized.chain), eq(tokens.address, normalized.tokenAddress)))
        .limit(1)
    )[0]?.id;

  await db
    .insert(launches)
    .values({
      tokenId,
      creatorId,
      creatorAddress: normalized.creatorAddress,
      launchTimestamp: new Date(normalized.launchTimestamp * 1000),
      launchTxHash: normalized.launchTxHash,
      launchBlockOrSlot: normalized.launchBlockOrSlot,
      venueSchemaVersion: normalized.venueSchemaVersion,
      graduationState: normalized.graduationState,
      rawGraduationProgress: normalized.rawGraduationProgress,
      normalizedGraduationProgressPct: normalized.normalizedGraduationProgressPct,
      rawPayload: normalized.rawPayload,
    })
    .onConflictDoNothing({ target: launches.tokenId });
}

async function resolveTokenId(chainId, address, venueId) {
  const existing = await db
    .select({ id: tokens.id })
    .from(tokens)
    .where(and(eq(tokens.chainId, chainId), eq(tokens.address, address)))
    .limit(1);
  if (existing[0]) return existing[0].id;

  const [token] = await db
    .insert(tokens)
    .values({ chainId, address, venueId, name: "(unknown — trade seen before launch)", ticker: "?" })
    .onConflictDoNothing({ target: [tokens.chainId, tokens.address] })
    .returning({ id: tokens.id });
  return (
    token?.id ??
    (await db.select({ id: tokens.id }).from(tokens).where(and(eq(tokens.chainId, chainId), eq(tokens.address, address))).limit(1))[0].id
  );
}

async function writeTrade(normalized) {
  const tokenId = await resolveTokenId(normalized.chain, normalized.tokenAddress, normalized.venue);
  await db
    .insert(trades)
    .values({
      tokenId,
      walletAddress: normalized.walletAddress,
      side: normalized.side,
      amountRaw: normalized.amountRaw,
      priceUsd: normalized.priceUsd,
      txHash: normalized.txHash,
      logIndex: String(normalized.logIndex),
      blockOrSlot: normalized.blockOrSlot,
      tradeTimestamp: new Date(normalized.timestamp * 1000),
      isSystemWallet: normalized.isSystemWallet,
    })
    .onConflictDoNothing({ target: [trades.txHash, trades.logIndex] });
  return tokenId;
}

async function getUniqueWalletCount(tokenId, side) {
  const [row] = await db
    .select({ count: countDistinct(trades.walletAddress) })
    .from(trades)
    .where(and(eq(trades.tokenId, tokenId), eq(trades.side, side), eq(trades.isSystemWallet, false)));
  return row?.count ?? 0;
}

async function getTokenLaunchInfo(tokenId) {
  const [row] = await db
    .select({ venueId: tokens.venueId, launchTimestamp: launches.launchTimestamp })
    .from(launches)
    .innerJoin(tokens, eq(launches.tokenId, tokens.id))
    .where(eq(tokens.id, tokenId))
    .limit(1);
  return row ?? null;
}

async function recordTradeSidePercentile(tokenId, side) {
  const launchInfo = await getTokenLaunchInfo(tokenId);
  if (!launchInfo) return;
  const walletCount = await getUniqueWalletCount(tokenId, side);
  const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - Math.floor(launchInfo.launchTimestamp.getTime() / 1000));
  percentileEngine.record(launchInfo.venueId, ageSeconds, side === "buy" ? "unique_buyers" : "unique_sellers", walletCount);
}

async function persistPercentileEngineState() {
  const serialized = percentileEngine.serializeAll();
  if (serialized.length === 0) return;
  await db
    .insert(percentileEngineState)
    .values({ id: PERCENTILE_ENGINE_SINGLETON_ID, state: serialized })
    .onConflictDoUpdate({ target: percentileEngineState.id, set: { state: serialized, updatedAt: new Date() } });
}

let launchCount = 0;
let tradeCount = 0;

// See this file's header for why Pump trades default off. SEED_INGEST_TRADES=true re-enables them for a manual/attended run.
const ingestTrades = process.env.SEED_INGEST_TRADES === "true";

// FIFO queue — even with trades off this costs nothing, and if trades are
// re-enabled it at least prevents concurrent writes from each racing the
// connection pool (helped, but did not alone fully fix, in testing).
let writeQueue = Promise.resolve();
function enqueueWrite(fn) {
  const result = writeQueue.then(fn, fn);
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// A transient connection error mid-run must not kill an unattended
// scheduled job outright — log and let the current poll cycle's already-
// scheduled work continue; the next scheduled workflow run picks up from
// wherever this one left off (idempotent writes, keyed on tx hash/token
// address, make partial runs safe to interrupt).
process.on("unhandledRejection", (err) => {
  console.error(`[${venue}] unhandled rejection (continuing):`, err);
});
process.on("uncaughtException", (err) => {
  console.error(`[${venue}] uncaught exception (continuing):`, err);
});

if (venue === "pump") {
  const { PumpAdapter } = await importDist("packages/adapters/dist/pump/real-adapter.js");
  const adapter = new PumpAdapter("https://api.mainnet-beta.solana.com");
  if (!ingestTrades) {
    console.log("[PUMP] trades disabled for this run (SEED_INGEST_TRADES!=true) — see header comment for why.\n");
  }
  adapter
    .discover(async (event) => {
      try {
        if (event.kind === "launch") {
          const normalized = await adapter.normalizeLaunch(event);
          await enqueueWrite(() => writeLaunch(normalized));
          launchCount++;
          console.log(`[PUMP] launch #${launchCount}: ${normalized.tokenTicker} — ${normalized.tokenName}`);
        } else if (event.kind === "trade" && ingestTrades) {
          const normalized = await adapter.normalizeTrade(event);
          const tokenId = await enqueueWrite(() => writeTrade(normalized));
          tradeCount++;
          await enqueueWrite(() => recordTradeSidePercentile(tokenId, normalized.side));
        }
      } catch (err) {
        console.error(`[PUMP] failed processing ${event.kind} event ${event.txHash}:`, err.message ?? err);
      }
    })
    .catch((err) => console.error("[PUMP] discover() error:", err));
} else if (venue === "pons") {
  // Trade ingestion is ON by default here, unlike Pump — Pons's per-launch
  // curve trade volume observed live in this session (a handful of
  // CurveBuy/CurveSell events per active launch, nowhere near Pump's
  // firehose) never reproduced the write-starvation issue documented in
  // this file's header, which was specifically volume-driven.
  const { PonsAdapter } = await importDist("packages/adapters/dist/pons/real-adapter.js");
  const adapter = new PonsAdapter();
  adapter
    .discover(async (event) => {
      try {
        if (event.kind === "launch") {
          const normalized = await adapter.normalizeLaunch(event);
          await enqueueWrite(() => writeLaunch(normalized));
          launchCount++;
          console.log(`[PONS] launch #${launchCount}: ${normalized.tokenTicker} — ${normalized.tokenName}`);
        } else if (event.kind === "trade") {
          const normalized = await adapter.normalizeTrade(event);
          const tokenId = await enqueueWrite(() => writeTrade(normalized));
          tradeCount++;
          await enqueueWrite(() => recordTradeSidePercentile(tokenId, normalized.side));
        }
      } catch (err) {
        console.error(`[PONS] failed processing ${event.kind} event ${event.txHash}:`, err.message ?? err);
      }
    })
    .catch((err) => console.error("[PONS] discover() error:", err));
} else {
  // Same reasoning as Pons: Flap's trade volume (observed live earlier in
  // this session via a bare event-counting script) is well below Pump's,
  // so trades are ingested by default rather than gated behind an env var.
  const { FlapAdapter } = await importDist("packages/adapters/dist/flap/real-adapter.js");
  const adapter = new FlapAdapter();
  adapter
    .discover(async (event) => {
      try {
        if (event.kind === "launch") {
          const normalized = await adapter.normalizeLaunch(event);
          await enqueueWrite(() => writeLaunch(normalized));
          launchCount++;
          console.log(`[FLAP] launch #${launchCount}: ${normalized.tokenTicker} — ${normalized.tokenName}`);
        } else if (event.kind === "trade") {
          const normalized = await adapter.normalizeTrade(event);
          const tokenId = await enqueueWrite(() => writeTrade(normalized));
          tradeCount++;
          await enqueueWrite(() => recordTradeSidePercentile(tokenId, normalized.side));
        }
      } catch (err) {
        console.error(`[FLAP] failed processing ${event.kind} event ${event.txHash}:`, err.message ?? err);
      }
    })
    .catch((err) => console.error("[FLAP] discover() error:", err));
}

console.log(`[${venue}] subscribing for ${durationSeconds}s...\n`);
await new Promise((resolve) => setTimeout(resolve, durationSeconds * 1000));
await persistPercentileEngineState();
console.log(`\n✅ [${venue}] ${launchCount} launches, ${tradeCount} trades written.`);
process.exit(0);
