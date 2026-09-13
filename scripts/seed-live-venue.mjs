#!/usr/bin/env node
/**
 * Single-venue live seeder — writes real launches (+ trades/percentiles
 * for Pump) from exactly ONE venue into whatever DATABASE_URL points at.
 *
 * Exists because running all three venues' adapters concurrently in one
 * process was empirically unreliable against a real hosted Postgres in
 * this session: isolated single-venue runs (this script) wrote launches
 * reliably every time (5/5, repeatedly), but the combined three-venue
 * script (seed-live-data.mjs) wrote zero launches across several 40-90s
 * runs despite launch events genuinely arriving (confirmed via a bare
 * event-counting script with no DB writes). The exact mechanism wasn't
 * root-caused under time pressure — recorded as a real, unresolved
 * finding, not swept under the rug — but running one process per venue
 * sidesteps it AND matches how the real production architecture already
 * works (services/indexer is one process per venue by design). Run three
 * of these concurrently (see the deploy notes) instead of relying on
 * seed-live-data.mjs's combined mode for anything beyond local demos
 * against PGlite, where this issue was never observed.
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

async function getUniqueBuyerCount(tokenId) {
  const [row] = await db
    .select({ count: countDistinct(trades.walletAddress) })
    .from(trades)
    .where(and(eq(trades.tokenId, tokenId), eq(trades.side, "buy"), eq(trades.isSystemWallet, false)));
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

async function recordBuyerPercentile(tokenId) {
  const launchInfo = await getTokenLaunchInfo(tokenId);
  if (!launchInfo) return;
  const buyerCount = await getUniqueBuyerCount(tokenId);
  const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - Math.floor(launchInfo.launchTimestamp.getTime() / 1000));
  percentileEngine.record(launchInfo.venueId, ageSeconds, "unique_buyers", buyerCount);
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

if (venue === "pump") {
  const { PumpAdapter } = await importDist("packages/adapters/dist/pump/real-adapter.js");
  const adapter = new PumpAdapter("https://api.mainnet-beta.solana.com");
  adapter
    .discover(async (event) => {
      if (event.kind === "launch") {
        const normalized = await adapter.normalizeLaunch(event);
        await writeLaunch(normalized);
        launchCount++;
        console.log(`[PUMP] launch #${launchCount}: ${normalized.tokenTicker} — ${normalized.tokenName}`);
      } else if (event.kind === "trade") {
        const normalized = await adapter.normalizeTrade(event);
        const tokenId = await writeTrade(normalized);
        tradeCount++;
        if (normalized.side === "buy") await recordBuyerPercentile(tokenId);
      }
    })
    .catch((err) => console.error("[PUMP] discover() error:", err));
} else if (venue === "pons") {
  const { PonsAdapter } = await importDist("packages/adapters/dist/pons/real-adapter.js");
  const adapter = new PonsAdapter();
  adapter
    .discover(async (event) => {
      if (event.kind !== "launch") return;
      const normalized = await adapter.normalizeLaunch(event);
      await writeLaunch(normalized);
      launchCount++;
      console.log(`[PONS] launch #${launchCount}: ${normalized.tokenTicker} — ${normalized.tokenName}`);
    })
    .catch((err) => console.error("[PONS] discover() error:", err));
} else {
  const { FlapAdapter } = await importDist("packages/adapters/dist/flap/real-adapter.js");
  const adapter = new FlapAdapter();
  adapter
    .discover(async (event) => {
      if (event.kind !== "launch") return;
      const normalized = await adapter.normalizeLaunch(event);
      await writeLaunch(normalized);
      launchCount++;
      console.log(`[FLAP] launch #${launchCount}: ${normalized.tokenTicker} — ${normalized.tokenName}`);
    })
    .catch((err) => console.error("[FLAP] discover() error:", err));
}

console.log(`[${venue}] subscribing for ${durationSeconds}s...\n`);
await new Promise((resolve) => setTimeout(resolve, durationSeconds * 1000));
await persistPercentileEngineState();
console.log(`\n✅ [${venue}] ${launchCount} launches, ${tradeCount} trades written.`);
process.exit(0);
