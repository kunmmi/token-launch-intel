#!/usr/bin/env node
/**
 * Populates a PERSISTENT PGlite data directory with real, live Pump.fun
 * launches, so apps/web (pointed at the same directory via
 * DATABASE_URL=pglite://<dir>) can render genuine on-chain data without
 * Docker. See client.ts's header comment for why PGlite mode exists and
 * its single-process limitation — this script and the Next.js dev server
 * must not run against the same directory AT THE SAME TIME; run this
 * first, let it finish, then start the web app.
 *
 * Run: node scripts/seed-live-pump-data.mjs [durationSeconds] [dataDir]
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, and } from "drizzle-orm";
import { readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const { chains, venues, tokens, launches, creators, creatorAddresses, trades } = await import(
  pathToFileURL(path.join(REPO_ROOT, "packages/db/dist/schema/index.js")).href
);
const { PumpAdapter } = await import(
  pathToFileURL(path.join(REPO_ROOT, "packages/adapters/dist/pump/real-adapter.js")).href
);

const durationSeconds = Number(process.argv[2] ?? 60);
const dataDir = path.resolve(REPO_ROOT, process.argv[3] ?? "./local-data/pglite");
const isFreshDb = !existsSync(dataDir);
mkdirSync(path.dirname(dataDir), { recursive: true }); // PGlite creates the leaf dir itself, not intermediate ones

console.log(`\n=== Seeding persistent local dev DB at ${dataDir} (fresh: ${isFreshDb}) ===\n`);

const pglite = new PGlite(dataDir);
const db = drizzle(pglite, { schema: { chains, venues, tokens, launches, creators, creatorAddresses, trades } });

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
}

const adapter = new PumpAdapter("https://api.mainnet-beta.solana.com");
let launchCount = 0;
let tradeCount = 0;
console.log(`subscribing to live Pump.fun program logs for ${durationSeconds}s...\n`);
const discoverPromise = adapter.discover(async (event) => {
  if (event.kind === "launch") {
    const normalized = await adapter.normalizeLaunch(event);
    await writeLaunch(normalized);
    launchCount++;
    console.log(`[LIVE] launch #${launchCount}: ${normalized.tokenTicker} — ${normalized.tokenName} (${normalized.tokenAddress})`);
  } else if (event.kind === "trade") {
    const normalized = await adapter.normalizeTrade(event);
    await writeTrade(normalized);
    tradeCount++;
  }
});
discoverPromise.catch((err) => console.error("discover() error:", err));

await new Promise((resolve) => setTimeout(resolve, durationSeconds * 1000));
await pglite.close();
console.log(`\n✅ Wrote ${launchCount} real launches and ${tradeCount} real trades to ${dataDir}. Now run the web app with:`);
console.log(`   DATABASE_URL=pglite://${path.relative(REPO_ROOT, dataDir).replace(/\\/g, "/")} npm run dev:web\n`);
process.exit(0);
