import { db, trades, launches, tokens } from "@tli/db";
import { eq, and, countDistinct } from "drizzle-orm";
import type { Venue } from "@tli/core";

/**
 * Real unique-buyer count for a token, computed on demand from the trades
 * table (COUNT DISTINCT wallet_address WHERE side='buy'). At M0 scale this
 * per-trade query is fine; it becomes the first thing to optimize (a
 * materialized counter, or moving trades to ClickHouse per the design doc)
 * once real launch volume shows up — not before, per "don't over-build".
 */
export async function getUniqueBuyerCount(tokenId: string): Promise<number> {
  const [row] = await db
    .select({ count: countDistinct(trades.walletAddress) })
    .from(trades)
    .where(and(eq(trades.tokenId, tokenId), eq(trades.side, "buy"), eq(trades.isSystemWallet, false)));
  return row?.count ?? 0;
}

export interface TokenLaunchInfo {
  venue: Venue;
  launchTimestamp: Date;
}

export async function getTokenLaunchInfo(tokenId: string): Promise<TokenLaunchInfo | null> {
  const [row] = await db
    .select({ venueId: tokens.venueId, launchTimestamp: launches.launchTimestamp })
    .from(launches)
    .innerJoin(tokens, eq(launches.tokenId, tokens.id))
    .where(eq(tokens.id, tokenId))
    .limit(1);
  if (!row) return null;
  return { venue: row.venueId as Venue, launchTimestamp: row.launchTimestamp };
}
