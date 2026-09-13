#!/usr/bin/env node
/**
 * Populates whatever database DATABASE_URL points at (real Postgres,
 * including a hosted one like Neon, OR pglite://<dir> for the zero-setup
 * local demo — see @tli/db's client.ts for how that switch works) with
 * real, live launches from all three venues (Pump, Pons, Flap), plus
 * trades + percentiles for Pump.
 *
 * Requires migrations + reference-data seed to already be applied against
 * that same DATABASE_URL (`npm run db:migrate && npm run db:seed` from the
 * repo root) — this script only writes launch/trade data, it doesn't
 * bootstrap schema, so the same DATABASE_URL setup steps apply whether
 * you're pointed at PGlite or a real hosted Postgres.
 *
 * Runs every real adapter concurrently against the same database, rather
 * than duplicating this file per venue.
 *
 * DB WRITES ARE SERIALIZED (see `enqueueWrite` below) — found empirically
 * in this session, not a hypothetical: against a real hosted Postgres
 * (Neon), running three adapters' writes fully concurrently caused launch
 * writes to be silently starved out by Pump's much higher-frequency trade
 * writes (0 launches written across two full runs, ~90s each, despite the
 * launch events genuinely arriving — confirmed with a bare event-logging
 * script with no DB writes at all). Isolated single-adapter writes worked
 * perfectly every time. This points at connection-pool contention under
 * concurrent load, not a code bug in the write functions themselves — the
 * real normalizer service (services/normalizer) doesn't hit this because
 * Redis Streams consumer groups naturally serialize per-consumer
 * throughput; this demo script has no such backpressure, so it adds a
 * simple in-process queue instead.
 *
 * Run: DATABASE_URL=... node scripts/seed-live-data.mjs [durationSeconds]
 */
import { eq, and, countDistinct } from "drizzle-orm";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

async function importDist(relativePath) {
  return import(pathToFileURL(path.join(REPO_ROOT, relativePath)).href);
}

// Simple FIFO promise chain — every DB write from any venue goes through
// this, so writes never race each other for pool connections.
let writeQueue = Promise.resolve();
function enqueueWrite(fn) {
  const result = writeQueue.then(fn, fn);
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

const { db, tokens, launches, creators, creatorAddresses, trades, percentileEngineState, PERCENTILE_ENGINE_SINGLETON_ID } =
  await importDist("packages/db/dist/index.js");
const { PumpAdapter } = await importDist("packages/adapters/dist/pump/real-adapter.js");
const { PonsAdapter } = await importDist("packages/adapters/dist/pons/real-adapter.js");
const { FlapAdapter } = await importDist("packages/adapters/dist/flap/real-adapter.js");
const { CohortPercentileEngine } = await importDist("packages/analytics/dist/index.js");

const durationSeconds = Number(process.argv[2] ?? 60);
const targetDescription = (process.env.DATABASE_URL ?? "").startsWith("pglite://")
  ? process.env.DATABASE_URL
  : "the configured Postgres DATABASE_URL";

console.log(`\n=== Writing real live launches into ${targetDescription} ===\n`);

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

// Mirrors services/normalizer/src/main.ts's percentile-recording logic —
// duplicated here rather than imported because this script bypasses the
// normalizer/Redis pipeline entirely (no Redis available in this sandbox).
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

const counts = { pump: { launches: 0, trades: 0 }, pons: { launches: 0, trades: 0 }, flap: { launches: 0, trades: 0 } };

const pumpAdapter = new PumpAdapter("https://api.mainnet-beta.solana.com");
const pumpDiscover = pumpAdapter.discover(async (event) => {
  if (event.kind === "launch") {
    const normalized = await pumpAdapter.normalizeLaunch(event);
    try { await enqueueWrite(() => writeLaunch(normalized)); } catch (e) { console.error("LAUNCH WRITE FAILED:", e); throw e; }
    counts.pump.launches++;
    console.log(`[PUMP] launch #${counts.pump.launches}: ${normalized.tokenTicker} — ${normalized.tokenName} (${normalized.tokenAddress})`);
  } else if (event.kind === "trade") {
    const normalized = await pumpAdapter.normalizeTrade(event);
    const tokenId = await enqueueWrite(() => writeTrade(normalized));
    counts.pump.trades++;
    if (normalized.side === "buy") await enqueueWrite(() => recordBuyerPercentile(tokenId));
  }
});
pumpDiscover.catch((err) => console.error("[PUMP] discover() error:", err));

const ponsAdapter = new PonsAdapter();
const ponsDiscover = ponsAdapter.discover(async (event) => {
  if (event.kind !== "launch") return; // PonsAdapter.normalizeTrade is intentionally unimplemented — see its header
  const normalized = await ponsAdapter.normalizeLaunch(event);
  try { await enqueueWrite(() => writeLaunch(normalized)); } catch (e) { console.error("LAUNCH WRITE FAILED:", e); throw e; }
  counts.pons.launches++;
  console.log(`[PONS] launch #${counts.pons.launches}: ${normalized.tokenTicker} — ${normalized.tokenName} (${normalized.venueSchemaVersion})`);
});
ponsDiscover.catch((err) => console.error("[PONS] discover() error:", err));

const flapAdapter = new FlapAdapter();
const flapDiscover = flapAdapter.discover(async (event) => {
  // Flap is extremely high-volume (observed ~8 events/sec on the Portal
  // contract alone) — launches only here, same reasoning as Pons, to keep
  // this demo script fast rather than write thousands of trade rows.
  if (event.kind !== "launch") return;
  const normalized = await flapAdapter.normalizeLaunch(event);
  try { await enqueueWrite(() => writeLaunch(normalized)); } catch (e) { console.error("LAUNCH WRITE FAILED:", e); throw e; }
  counts.flap.launches++;
  console.log(`[FLAP] launch #${counts.flap.launches}: ${normalized.tokenTicker} — ${normalized.tokenName}`);
});
flapDiscover.catch((err) => console.error("[FLAP] discover() error:", err));

console.log(`subscribing to live Pump.fun, Pons, and Flap for ${durationSeconds}s...\n`);
await new Promise((resolve) => setTimeout(resolve, durationSeconds * 1000));
await persistPercentileEngineState();

console.log(
  `\n✅ Pump: ${counts.pump.launches} launches, ${counts.pump.trades} trades. ` +
    `Pons: ${counts.pons.launches} launches. Flap: ${counts.flap.launches} launches. ` +
    `(Pons/Flap trade ingestion not wired up — see their adapters.) ` +
    `Percentile cohorts: ${percentileEngine.serializeAll().length}.\n`,
);
process.exit(0);
