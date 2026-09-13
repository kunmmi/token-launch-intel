#!/usr/bin/env node
/**
 * Populates a PERSISTENT PGlite data directory with real, live launches
 * (and, for Pump, trades + percentiles) from every venue with a working
 * real adapter, so apps/web (pointed at the same directory via
 * DATABASE_URL=pglite://<dir>) can render genuine on-chain data without
 * Docker. See client.ts's header comment for why PGlite mode exists and
 * its single-process limitation — this script and the Next.js dev server
 * must not run against the same directory AT THE SAME TIME; run this
 * first, let it finish, then start the web app.
 *
 * Supersedes the old seed-live-pump-data.mjs (Pump-only) — this runs every
 * real adapter (currently Pump + Pons; Flap once its adapter exists)
 * concurrently against the same database, since duplicating this file per
 * venue got unmaintainable fast.
 *
 * Run: node scripts/seed-live-data.mjs [durationSeconds] [dataDir]
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, and, countDistinct } from "drizzle-orm";
import { readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

async function importDist(relativePath) {
  return import(pathToFileURL(path.join(REPO_ROOT, relativePath)).href);
}

const { chains, venues, tokens, launches, creators, creatorAddresses, trades, percentileEngineState, PERCENTILE_ENGINE_SINGLETON_ID } =
  await importDist("packages/db/dist/schema/index.js");
const { PumpAdapter } = await importDist("packages/adapters/dist/pump/real-adapter.js");
const { PonsAdapter } = await importDist("packages/adapters/dist/pons/real-adapter.js");
const { CohortPercentileEngine } = await importDist("packages/analytics/dist/index.js");

const durationSeconds = Number(process.argv[2] ?? 60);
const dataDir = path.resolve(REPO_ROOT, process.argv[3] ?? "./local-data/pglite");
const isFreshDb = !existsSync(dataDir);
mkdirSync(path.dirname(dataDir), { recursive: true }); // PGlite creates the leaf dir itself, not intermediate ones

console.log(`\n=== Seeding persistent local dev DB at ${dataDir} (fresh: ${isFreshDb}) ===\n`);

const pglite = new PGlite(dataDir);
const db = drizzle(pglite, {
  schema: { chains, venues, tokens, launches, creators, creatorAddresses, trades, percentileEngineState },
});
const percentileEngine = new CohortPercentileEngine();

if (isFreshDb) {
  const migrationsDir = path.join(REPO_ROOT, "packages/db/migrations");
  const sqlFiles = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of sqlFiles) {
    const sql = readFileSync(path.join(migrationsDir, file), "utf-8");
    const statements = sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
    for (const statement of statements) await pglite.exec(statement);
    console.log(`applied migration: ${file}`);
  }
  await db.insert(chains).values([
    { id: "solana", displayName: "Solana" },
    { id: "robinhood", displayName: "Robinhood Chain" },
    { id: "bnb", displayName: "BNB Chain" },
  ]);
  await db.insert(venues).values([
    { id: "pump", displayName: "Pump.fun", chainId: "solana", registryStatus: "active", hasHostedApi: true },
    { id: "pons", displayName: "Pons", chainId: "robinhood", registryStatus: "active", hasHostedApi: false },
    { id: "flap", displayName: "Flap", chainId: "bnb", registryStatus: "active", hasHostedApi: false },
  ]);
  console.log("seeded chains + venues\n");
}

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

const counts = { pump: { launches: 0, trades: 0 }, pons: { launches: 0, trades: 0 } };

const pumpAdapter = new PumpAdapter("https://api.mainnet-beta.solana.com");
const pumpDiscover = pumpAdapter.discover(async (event) => {
  if (event.kind === "launch") {
    const normalized = await pumpAdapter.normalizeLaunch(event);
    await writeLaunch(normalized);
    counts.pump.launches++;
    console.log(`[PUMP] launch #${counts.pump.launches}: ${normalized.tokenTicker} — ${normalized.tokenName} (${normalized.tokenAddress})`);
  } else if (event.kind === "trade") {
    const normalized = await pumpAdapter.normalizeTrade(event);
    const tokenId = await writeTrade(normalized);
    counts.pump.trades++;
    if (normalized.side === "buy") await recordBuyerPercentile(tokenId);
  }
});
pumpDiscover.catch((err) => console.error("[PUMP] discover() error:", err));

const ponsAdapter = new PonsAdapter();
const ponsDiscover = ponsAdapter.discover(async (event) => {
  if (event.kind !== "launch") return; // PonsAdapter.normalizeTrade is intentionally unimplemented — see its header
  const normalized = await ponsAdapter.normalizeLaunch(event);
  await writeLaunch(normalized);
  counts.pons.launches++;
  console.log(`[PONS] launch #${counts.pons.launches}: ${normalized.tokenTicker} — ${normalized.tokenName} (${normalized.venueSchemaVersion})`);
});
ponsDiscover.catch((err) => console.error("[PONS] discover() error:", err));

console.log(`subscribing to live Pump.fun (WebSocket push) and Pons (polling) for ${durationSeconds}s...\n`);
await new Promise((resolve) => setTimeout(resolve, durationSeconds * 1000));
await persistPercentileEngineState();
await pglite.close();

console.log(
  `\n✅ Pump: ${counts.pump.launches} launches, ${counts.pump.trades} trades. ` +
    `Pons: ${counts.pons.launches} launches (no trade ingestion — see PonsAdapter.normalizeTrade). ` +
    `Percentile cohorts: ${percentileEngine.serializeAll().length}.\n`,
);
console.log(`Now run the web app with:`);
console.log(`   DATABASE_URL=pglite://${path.relative(REPO_ROOT, dataDir).replace(/\\/g, "/")} npm run dev:web\n`);
process.exit(0);
