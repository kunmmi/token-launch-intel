import { db, tokens, launches, creators, creatorAddresses, venues, trades, holderSnapshots } from "@tli/db";
import { desc, eq, and, inArray, countDistinct, gte, ne } from "drizzle-orm";
import type { Venue } from "@tli/core";
import { loadPercentileEngine, buyerPercentile, sellerPercentile, concentrationPercentile, buyVolumeUsdPercentile } from "./percentile";

/**
 * M0 data-access layer. Deliberately thin — direct Drizzle queries, no
 * GraphQL/tRPC layer yet (not justified at this scale per the M0 design
 * doc's "don't over-build" guidance). Venue-relative percentiles ARE now
 * included (uniqueBuyerPercentile) — loaded from the normalizer's
 * periodically-persisted engine state, see lib/percentile.ts.
 */

/**
 * Real coins launched from /launch (see app/api/pump/record-launch) are
 * stored under this chain id, never "solana" — structurally distinct from
 * real mainnet Pump data so a free-money devnet test launch can never be
 * mistaken for (or pollute percentile stats alongside) a real one. Excluded
 * from the default live market feed below; still fully visible on its own
 * Token page (real on-chain facts, just not mixed into aggregate rankings).
 */
const DEVNET_TEST_CHAIN_ID = "solana-devnet";

export interface MarketRow {
  tokenId: string;
  chainId: string;
  address: string;
  name: string;
  ticker: string;
  venueId: string;
  launchTimestamp: Date;
  graduationState: string;
  normalizedGraduationProgressPct: number;
  creatorId: string | null;
  creatorAddress: string;
  /**
   * Real unique-buyer count from the trades table (COUNT DISTINCT
   * wallet_address WHERE side='buy'), when any trades have been ingested
   * for this token — null if none yet (no trade ingestion has run, or the
   * token genuinely has zero buys). Not a percentile — see module header.
   */
  uniqueBuyerCount: number | null;
  /** Venue-relative percentile rank (0-100) of uniqueBuyerCount at this token's current age. Null if unavailable. */
  uniqueBuyerPercentile: number | null;
  /**
   * Real unique-seller count from the trades table, same shape as
   * uniqueBuyerCount. Null if no sell trades ingested yet for this token —
   * either genuinely zero sells, or (for Pons/Flap) the scheduled live
   * refresh only recently started ingesting trades for those venues.
   */
  uniqueSellerCount: number | null;
  /** Venue-relative percentile rank (0-100) of uniqueSellerCount at this token's current age. Null if unavailable. */
  uniqueSellerPercentile: number | null;
}

async function attachBuyerStats<T extends { tokenId: string; venueId: string; launchTimestamp: Date }>(
  rows: T[],
): Promise<
  Array<
    T & {
      uniqueBuyerCount: number | null;
      uniqueBuyerPercentile: number | null;
      uniqueSellerCount: number | null;
      uniqueSellerPercentile: number | null;
    }
  >
> {
  const tokenIds = rows.map((r) => r.tokenId);
  const [buyerCounts, sellerCounts, engine] = await Promise.all([
    getTradeCounts(tokenIds, "buy"),
    getTradeCounts(tokenIds, "sell"),
    loadPercentileEngine(),
  ]);
  return rows.map((row) => {
    const uniqueBuyerCount = buyerCounts.get(row.tokenId) ?? null;
    const uniqueSellerCount = sellerCounts.get(row.tokenId) ?? null;
    return {
      ...row,
      uniqueBuyerCount,
      uniqueBuyerPercentile: buyerPercentile(engine, row.venueId as Venue, row.launchTimestamp, uniqueBuyerCount),
      uniqueSellerCount,
      uniqueSellerPercentile: sellerPercentile(engine, row.venueId as Venue, row.launchTimestamp, uniqueSellerCount),
    };
  });
}

/** Batched unique-wallet-count lookup for one trade side — one query for N tokens instead of N queries. */
async function getTradeCounts(tokenIds: string[], side: "buy" | "sell"): Promise<Map<string, number>> {
  if (tokenIds.length === 0) return new Map();
  const rows = await db
    .select({ tokenId: trades.tokenId, count: countDistinct(trades.walletAddress) })
    .from(trades)
    .where(and(inArray(trades.tokenId, tokenIds), eq(trades.side, side), eq(trades.isSystemWallet, false)))
    .groupBy(trades.tokenId);
  return new Map(rows.map((r) => [r.tokenId, r.count]));
}

/**
 * PRD Section 7's New/Heating Up/Near Graduation/Graduated tabs, over the
 * one normalized launch market. "heating_up" is a documented approximation
 * — it means "has at least one real recorded buy" rather than a true
 * buyer-velocity/acceleration signal (which needs the trade-volume history
 * this M0 pass doesn't track yet). Not fabricated as something stronger
 * than it is.
 */
export const MARKET_VIEWS = ["all", "new", "heating_up", "near_graduation", "graduated"] as const;
export type MarketView = (typeof MARKET_VIEWS)[number];

const NEW_AGE_THRESHOLD_SECONDS = 300; // 5 minutes, matching PRD Section 8's example filter

function matchesView(row: MarketRow, view: MarketView): boolean {
  switch (view) {
    case "all":
      return true;
    case "new":
      return (Date.now() - row.launchTimestamp.getTime()) / 1000 < NEW_AGE_THRESHOLD_SECONDS;
    case "heating_up":
      return (row.uniqueBuyerCount ?? 0) > 0;
    case "near_graduation":
      return row.graduationState === "GRADUATING";
    case "graduated":
      return row.graduationState === "GRADUATED";
  }
}

export async function getLiveLaunchMarket(limit = 50, view: MarketView = "all"): Promise<MarketRow[]> {
  // Fetch a larger candidate set than `limit` since the view filter is
  // applied after the DB query (age-based filtering needs a runtime "now"
  // comparison, and at M0 data volume this is simpler and fast enough than
  // pushing every view's logic into SQL — revisit if the candidate table
  // grows large enough for this scan to matter).
  const candidateLimit = view === "all" ? limit : Math.max(limit * 6, 300);

  const rows = await db
    .select({
      tokenId: tokens.id,
      chainId: tokens.chainId,
      address: tokens.address,
      name: tokens.name,
      ticker: tokens.ticker,
      venueId: tokens.venueId,
      launchTimestamp: launches.launchTimestamp,
      graduationState: launches.graduationState,
      normalizedGraduationProgressPct: launches.normalizedGraduationProgressPct,
      creatorId: launches.creatorId,
      creatorAddress: launches.creatorAddress,
    })
    .from(launches)
    .innerJoin(tokens, eq(launches.tokenId, tokens.id))
    .where(ne(tokens.chainId, DEVNET_TEST_CHAIN_ID))
    .orderBy(desc(launches.launchTimestamp))
    .limit(candidateLimit);

  const withStats = await attachBuyerStats(rows);
  return withStats.filter((row) => matchesView(row, view)).slice(0, limit);
}

export interface HolderSnapshotSummary {
  capturedAt: Date;
  visibleHolderCount: number;
  top10ConcentrationPct: number | null;
  top10ConcentrationPercentile: number | null;
  topAccounts: Array<{ address: string; balanceRaw: string; isCurveReserve: boolean }>;
}

export interface TokenDetail extends MarketRow {
  launchTxHash: string;
  launchBlockOrSlot: string;
  venueSchemaVersion: string;
  rawGraduationProgress: number;
  /**
   * Most recent real getTokenLargestAccounts snapshot — Pump only, null for
   * every other venue and for Pump tokens not yet reached by
   * scripts/snapshot-pump-holders.mjs's rolling window. See
   * packages/db/src/schema/holders.ts for what this number does and does
   * not represent (top 20 accounts, not a full holder registry).
   */
  holderSnapshot: HolderSnapshotSummary | null;
  /**
   * Real sum of buy-side trade value in USD, or null if no priced buy
   * trades exist yet for this token — Pons is always null here (its
   * priceUsd is always null, see pons/real-adapter.ts's normalizeTrade).
   */
  buyVolumeUsd: number | null;
  /** Venue-relative percentile rank (0-100) of buyVolumeUsd at this token's current age. Null if unavailable. */
  buyVolumeUsdPercentile: number | null;
}

// Verified live in this session (see the matching constant + comment in
// scripts/seed-live-venue.mjs, and real-adapter.ts in each venue) — not
// guessed. Pons omitted: priceUsd is always null there.
const TOKEN_DECIMALS_BY_VENUE: Record<string, number> = { pump: 6, flap: 18 };

async function getBuyVolumeUsd(tokenId: string, venueId: string): Promise<number | null> {
  const decimals = TOKEN_DECIMALS_BY_VENUE[venueId];
  if (decimals === undefined) return null;

  const rows = await db
    .select({ amountRaw: trades.amountRaw, priceUsd: trades.priceUsd })
    .from(trades)
    .where(and(eq(trades.tokenId, tokenId), eq(trades.side, "buy"), eq(trades.isSystemWallet, false)));

  let total = 0;
  let anyPriced = false;
  for (const row of rows) {
    if (row.priceUsd === null) continue;
    anyPriced = true;
    total += (Number(row.amountRaw) / 10 ** decimals) * row.priceUsd;
  }
  return anyPriced ? total : null;
}

async function getLatestHolderSnapshot(
  tokenId: string,
  venueId: string,
  launchTimestamp: Date,
): Promise<HolderSnapshotSummary | null> {
  if (venueId !== "pump") return null; // no EVM holder data exists yet — see holders.ts

  const [row] = await db
    .select({
      capturedAt: holderSnapshots.capturedAt,
      visibleHolderCount: holderSnapshots.visibleHolderCount,
      top10ConcentrationPct: holderSnapshots.top10ConcentrationPct,
      topAccounts: holderSnapshots.topAccounts,
    })
    .from(holderSnapshots)
    .where(eq(holderSnapshots.tokenId, tokenId))
    .orderBy(desc(holderSnapshots.capturedAt))
    .limit(1);
  if (!row) return null;

  const engine = await loadPercentileEngine();
  return {
    capturedAt: row.capturedAt,
    visibleHolderCount: row.visibleHolderCount,
    top10ConcentrationPct: row.top10ConcentrationPct,
    top10ConcentrationPercentile: concentrationPercentile(engine, venueId as Venue, launchTimestamp, row.top10ConcentrationPct),
    topAccounts: row.topAccounts as HolderSnapshotSummary["topAccounts"],
  };
}

export async function getTokenDetail(chainId: string, address: string): Promise<TokenDetail | null> {
  const rows = await db
    .select({
      tokenId: tokens.id,
      chainId: tokens.chainId,
      address: tokens.address,
      name: tokens.name,
      ticker: tokens.ticker,
      venueId: tokens.venueId,
      launchTimestamp: launches.launchTimestamp,
      launchTxHash: launches.launchTxHash,
      launchBlockOrSlot: launches.launchBlockOrSlot,
      venueSchemaVersion: launches.venueSchemaVersion,
      graduationState: launches.graduationState,
      rawGraduationProgress: launches.rawGraduationProgress,
      normalizedGraduationProgressPct: launches.normalizedGraduationProgressPct,
      creatorId: launches.creatorId,
      creatorAddress: launches.creatorAddress,
    })
    .from(launches)
    .innerJoin(tokens, eq(launches.tokenId, tokens.id))
    .where(and(eq(tokens.chainId, chainId), eq(tokens.address, address)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const [withStats] = await attachBuyerStats([row]);
  const [holderSnapshot, buyVolumeUsd, engine] = await Promise.all([
    getLatestHolderSnapshot(row.tokenId, row.venueId, row.launchTimestamp),
    getBuyVolumeUsd(row.tokenId, row.venueId),
    loadPercentileEngine(),
  ]);
  return {
    ...withStats!,
    holderSnapshot,
    buyVolumeUsd,
    buyVolumeUsdPercentile: buyVolumeUsdPercentile(engine, row.venueId as Venue, row.launchTimestamp, buyVolumeUsd),
  };
}

export interface CreatorHistoryRow {
  creatorId: string;
  displayName: string | null;
  addresses: Array<{ chainId: string; address: string; isSelfAttested: boolean; isSignatureVerified: boolean }>;
  totalLaunches: number;
  graduatedCount: number;
  launches: MarketRow[];
}

/**
 * Section 13's "show evidence, not a mysterious trust score" — deliberately
 * no computed reputation metric yet, just the raw historical facts.
 */
export async function getCreatorHistory(creatorId: string): Promise<CreatorHistoryRow | null> {
  const creatorRows = await db.select().from(creators).where(eq(creators.id, creatorId)).limit(1);
  const creator = creatorRows[0];
  if (!creator) return null;

  const addresses = await db
    .select({
      chainId: creatorAddresses.chainId,
      address: creatorAddresses.address,
      isSelfAttested: creatorAddresses.isSelfAttested,
      isSignatureVerified: creatorAddresses.isSignatureVerified,
    })
    .from(creatorAddresses)
    .where(eq(creatorAddresses.creatorId, creatorId));

  const rows = await db
    .select({
      tokenId: tokens.id,
      chainId: tokens.chainId,
      address: tokens.address,
      name: tokens.name,
      ticker: tokens.ticker,
      venueId: tokens.venueId,
      launchTimestamp: launches.launchTimestamp,
      graduationState: launches.graduationState,
      normalizedGraduationProgressPct: launches.normalizedGraduationProgressPct,
      creatorId: launches.creatorId,
      creatorAddress: launches.creatorAddress,
    })
    .from(launches)
    .innerJoin(tokens, eq(launches.tokenId, tokens.id))
    .where(eq(launches.creatorId, creatorId))
    .orderBy(desc(launches.launchTimestamp));

  const launchRows: MarketRow[] = await attachBuyerStats(rows);

  return {
    creatorId: creator.id,
    displayName: creator.displayName,
    addresses,
    totalLaunches: launchRows.length,
    graduatedCount: launchRows.filter((l) => l.graduationState === "GRADUATED").length,
    launches: launchRows,
  };
}

export async function getVenues() {
  return db.select().from(venues);
}

export interface VenueComparisonRow {
  venueId: string;
  /** Real launches in the comparison window — the actual sample size behind every other field here, shown alongside them rather than hidden. */
  recentLaunchCount: number;
  /** % of recent launches currently GRADUATING or GRADUATED. Null if recentLaunchCount is 0 (nothing to compute a rate from). */
  graduatingOrGraduatedPct: number | null;
  /** Average real unique-buyer count across recent launches that have any ingested trade data. Null if none do. */
  avgUniqueBuyers: number | null;
  /** Average real top-10 holder concentration across recent launches with a snapshot — Pump only in practice, see holders.ts. */
  avgTop10ConcentrationPct: number | null;
}

const COMPARISON_WINDOW_HOURS = 6;

/**
 * "Which venue is hot right now" — real, small-sample numbers for a
 * creator deciding where to launch, not a manufactured recommendation.
 * Deliberately no single "winner" is picked here; the launch page shows
 * these side by side and lets the creator read them, same raw-data-first
 * principle as everywhere else in this project.
 */
export async function getVenueComparison(): Promise<VenueComparisonRow[]> {
  const since = new Date(Date.now() - COMPARISON_WINDOW_HOURS * 60 * 60 * 1000);
  const recentLaunches = await db
    .select({ venueId: tokens.venueId, tokenId: tokens.id, graduationState: launches.graduationState })
    .from(launches)
    .innerJoin(tokens, eq(launches.tokenId, tokens.id))
    .where(gte(launches.launchTimestamp, since));

  const tokenIds = recentLaunches.map((r) => r.tokenId);
  const [buyerCounts, holderRows] = await Promise.all([
    getTradeCounts(tokenIds, "buy"),
    tokenIds.length === 0
      ? Promise.resolve([])
      : db
          .select({ tokenId: holderSnapshots.tokenId, top10ConcentrationPct: holderSnapshots.top10ConcentrationPct, capturedAt: holderSnapshots.capturedAt })
          .from(holderSnapshots)
          .where(inArray(holderSnapshots.tokenId, tokenIds))
          .orderBy(desc(holderSnapshots.capturedAt)),
  ]);

  // Most recent snapshot per token — holderRows is already ordered newest-first, so the first occurrence per tokenId wins.
  const latestConcentrationByToken = new Map<string, number>();
  for (const row of holderRows) {
    if (row.top10ConcentrationPct === null || latestConcentrationByToken.has(row.tokenId)) continue;
    latestConcentrationByToken.set(row.tokenId, row.top10ConcentrationPct);
  }

  const byVenue = new Map<string, typeof recentLaunches>();
  for (const row of recentLaunches) {
    const list = byVenue.get(row.venueId) ?? [];
    list.push(row);
    byVenue.set(row.venueId, list);
  }

  const out: VenueComparisonRow[] = [];
  for (const [venueId, rows] of byVenue.entries()) {
    const graduatingOrGraduated = rows.filter((r) => r.graduationState === "GRADUATING" || r.graduationState === "GRADUATED").length;
    const buyerCountsForVenue = rows.map((r) => buyerCounts.get(r.tokenId)).filter((c): c is number => c !== undefined);
    const concentrationsForVenue = rows.map((r) => latestConcentrationByToken.get(r.tokenId)).filter((c): c is number => c !== undefined);

    out.push({
      venueId,
      recentLaunchCount: rows.length,
      graduatingOrGraduatedPct: rows.length > 0 ? (graduatingOrGraduated / rows.length) * 100 : null,
      avgUniqueBuyers: buyerCountsForVenue.length > 0 ? buyerCountsForVenue.reduce((a, b) => a + b, 0) / buyerCountsForVenue.length : null,
      avgTop10ConcentrationPct:
        concentrationsForVenue.length > 0 ? concentrationsForVenue.reduce((a, b) => a + b, 0) / concentrationsForVenue.length : null,
    });
  }
  return out;
}
