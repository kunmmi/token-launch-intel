import { db, tokens, launches, creators, creatorAddresses, venues, trades } from "@tli/db";
import { desc, eq, and, inArray, countDistinct } from "drizzle-orm";
import type { Venue } from "@tli/core";
import { loadPercentileEngine, buyerPercentile, sellerPercentile } from "./percentile";

/**
 * M0 data-access layer. Deliberately thin — direct Drizzle queries, no
 * GraphQL/tRPC layer yet (not justified at this scale per the M0 design
 * doc's "don't over-build" guidance). Venue-relative percentiles ARE now
 * included (uniqueBuyerPercentile) — loaded from the normalizer's
 * periodically-persisted engine state, see lib/percentile.ts.
 */

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
    .orderBy(desc(launches.launchTimestamp))
    .limit(candidateLimit);

  const withStats = await attachBuyerStats(rows);
  return withStats.filter((row) => matchesView(row, view)).slice(0, limit);
}

export interface TokenDetail extends MarketRow {
  launchTxHash: string;
  launchBlockOrSlot: string;
  venueSchemaVersion: string;
  rawGraduationProgress: number;
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
  return withStats!;
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
