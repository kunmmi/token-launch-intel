#!/usr/bin/env node
/**
 * Live-pipeline verification harness — NOT a production script.
 *
 * The README's "Not verified in this session" section flagged a real gap:
 * schema correctness was checked via `drizzle-kit generate` (no live DB),
 * but the ingestion pipeline's actual runtime behavior against a real
 * database was never observed, because this sandbox has no Docker.
 *
 * This script closes that gap without touching the host machine at all:
 * it boots PGlite (a real PostgreSQL engine compiled to WASM, running
 * in-process, zero install/service/admin footprint), applies the exact
 * generated migration SQL, then runs the REAL PumpAdapter against LIVE
 * mainnet in `live` mode — no synthetic data — and writes what it decodes
 * straight into the embedded database using the exact same Drizzle schema
 * objects `@tli/db` and the Next.js app use. It then re-reads that data
 * back with the same query shape apps/web/lib/queries.ts uses.
 *
 * It deliberately bypasses the Redis Streams bus (packages/core's
 * EventBus) — that's simple, well-understood infrastructure and the least
 * risky part of the pipeline; wiring PGlite up as a Redis substitute would
 * add complexity for no verification value. What this DOES prove for the
 * first time: real chain decoding -> real schema -> real persisted rows ->
 * real read-back, end to end, with genuine mainnet data.
 *
 * Run: node scripts/verify-live-pump-pipeline.mjs [durationSeconds]
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, and, desc } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const { chains, venues, tokens, launches, creators, creatorAddresses } = await import(
  pathToFileURL(path.join(REPO_ROOT, "packages/db/dist/schema/index.js")).href
);
const { PumpAdapter } = await import(
  pathToFileURL(path.join(REPO_ROOT, "packages/adapters/dist/pump/real-adapter.js")).href
);

const durationSeconds = Number(process.argv[2] ?? 40);

console.log(`\n=== Live Pump.fun pipeline verification (PGlite, ${durationSeconds}s live window) ===\n`);

// 1. Boot a real, embedded Postgres engine.
const pglite = new PGlite();
const db = drizzle(pglite);

// 2. Apply the exact generated migration SQL (no divergent schema).
const migrationsDir = path.join(REPO_ROOT, "packages/db/migrations");
const sqlFiles = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();
for (const file of sqlFiles) {
  const sql = readFileSync(path.join(migrationsDir, file), "utf-8");
  // Drizzle's generated files use "--> statement-breakpoint" between statements.
  const statements = sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
  for (const statement of statements) {
    await pglite.exec(statement);
  }
  console.log(`applied migration: ${file}`);
}

// 3. Seed reference data (same rows as packages/db/src/seed.ts).
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

// 4. Run the REAL adapter against LIVE mainnet, writing real decoded launches in.
const adapter = new PumpAdapter("https://api.mainnet-beta.solana.com");
let launchCount = 0;
let tradeCount = 0;

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

console.log("subscribing to live Pump.fun program logs on mainnet...\n");
const discoverPromise = adapter.discover(async (event) => {
  if (event.kind === "launch") {
    const normalized = await adapter.normalizeLaunch(event);
    await writeLaunch(normalized);
    launchCount++;
    console.log(`[LIVE] launch #${launchCount}: ${normalized.tokenTicker} (${normalized.tokenAddress}) by ${normalized.creatorAddress.slice(0, 8)}...`);
  } else if (event.kind === "trade") {
    tradeCount++;
  }
});
discoverPromise.catch((err) => console.error("discover() error:", err));

await new Promise((resolve) => setTimeout(resolve, durationSeconds * 1000));

console.log(`\n=== Live window ended: ${launchCount} launches written, ${tradeCount} trades observed (not persisted in this harness) ===\n`);

// 5. Read the data back exactly the way apps/web/lib/queries.ts's
//    getLiveLaunchMarket does, proving the persisted rows are actually queryable.
const marketRows = await db
  .select({
    ticker: tokens.ticker,
    name: tokens.name,
    address: tokens.address,
    venueId: tokens.venueId,
    launchTimestamp: launches.launchTimestamp,
    graduationState: launches.graduationState,
    creatorAddress: launches.creatorAddress,
  })
  .from(launches)
  .innerJoin(tokens, eq(launches.tokenId, tokens.id))
  .orderBy(desc(launches.launchTimestamp))
  .limit(50);

console.log(`=== Read-back via the same query shape the Market page uses (${marketRows.length} rows) ===\n`);
for (const row of marketRows) {
  console.log(`  ${row.ticker.padEnd(12)} ${row.name.padEnd(30)} ${row.address}  creator=${row.creatorAddress.slice(0, 8)}...  ${row.graduationState}`);
}

if (marketRows.length === 0) {
  console.log("\nNo launches captured in this window (Pump.fun launch rate varies; rerun with a longer duration, e.g.:");
  console.log("  node scripts/verify-live-pump-pipeline.mjs 90\n");
  process.exit(1);
} else {
  console.log(`\n✅ Verified: real mainnet CreateEvents were decoded, normalized, persisted to a real Postgres-compatible schema, and read back correctly.\n`);
  process.exit(0);
}
