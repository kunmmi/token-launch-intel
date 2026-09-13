import { db, tokens, launches, creators, creatorAddresses, venues, trades } from "@tli/db";
import { desc, eq, and, inArray, countDistinct } from "drizzle-orm";

/**
 * M0 data-access layer. Deliberately thin — direct Drizzle queries, no
 * GraphQL/tRPC layer yet (not justified at this scale per the M0 design
 * doc's "don't over-build" guidance). Venue-relative percentiles are NOT
 * included here yet: the percentile engine (packages/analytics) currently
 * lives only inside the normalizer process and isn't persisted/exposed via
 * an API — that wiring is the next concrete piece of work, not faked here.
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
}

/** Batched buyer-count lookup — one query for N tokens instead of N queries. */
async function getBuyerCounts(tokenIds: string[]): Promise<Map<string, number>> {
  if (tokenIds.length === 0) return new Map();
  const rows = await db
    .select({ tokenId: trades.tokenId, count: countDistinct(trades.walletAddress) })
    .from(trades)
    .where(and(inArray(trades.tokenId, tokenIds), eq(trades.side, "buy"), eq(trades.isSystemWallet, false)))
    .groupBy(trades.tokenId);
  return new Map(rows.map((r) => [r.tokenId, r.count]));
}

export async function getLiveLaunchMarket(limit = 50): Promise<MarketRow[]> {
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
    .limit(limit);

  const buyerCounts = await getBuyerCounts(rows.map((r) => r.tokenId));
  return rows.map((row) => ({ ...row, uniqueBuyerCount: buyerCounts.get(row.tokenId) ?? null }));
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

  const buyerCounts = await getBuyerCounts([row.tokenId]);
  return { ...row, uniqueBuyerCount: buyerCounts.get(row.tokenId) ?? null };
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

  const buyerCounts = await getBuyerCounts(rows.map((r) => r.tokenId));
  const launchRows: MarketRow[] = rows.map((row) => ({
    ...row,
    uniqueBuyerCount: buyerCounts.get(row.tokenId) ?? null,
  }));

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
