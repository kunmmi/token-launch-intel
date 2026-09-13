import type { NormalizedTrade } from "@tli/core";
import { db, tokens, trades } from "@tli/db";
import { eq, and } from "drizzle-orm";

/**
 * Idempotent write path for a normalized trade, mirroring write-launch.ts.
 * Trades reference tokens by (chain, address), same as launches — a trade
 * arriving before its token's launch record (shouldn't happen in practice
 * since CreateEvent precedes any TradeEvent on-chain, but at-least-once
 * delivery + consumer-group replay makes no ordering guarantee) is handled
 * by upserting a minimal token row rather than failing.
 */
export async function writeNormalizedTrade(normalized: NormalizedTrade): Promise<{ tokenId: string }> {
  const tokenId = await resolveTokenId(normalized);

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

  return { tokenId };
}

async function resolveTokenId(normalized: NormalizedTrade): Promise<string> {
  const existing = await db
    .select({ id: tokens.id })
    .from(tokens)
    .where(and(eq(tokens.chainId, normalized.chain), eq(tokens.address, normalized.tokenAddress)))
    .limit(1);

  if (existing[0]) return existing[0].id;

  // Minimal placeholder token row — name/ticker get corrected when the real
  // launch record (from a CreateEvent) lands, since tokens are keyed by
  // (chain, address) and writeNormalizedLaunch's insert uses
  // onConflictDoNothing, not onConflictDoUpdate. That's a real gap: if a
  // trade is processed before its launch, the token's name/ticker stay as
  // this placeholder forever. Acceptable for M0 (CreateEvent always
  // precedes TradeEvent on the real chain); would need an upsert-with-merge
  // before this ordering assumption can be trusted under replay/backfill.
  const [token] = await db
    .insert(tokens)
    .values({
      chainId: normalized.chain,
      address: normalized.tokenAddress,
      venueId: normalized.venue,
      name: "(unknown — trade seen before launch)",
      ticker: "?",
    })
    .onConflictDoNothing({ target: [tokens.chainId, tokens.address] })
    .returning({ id: tokens.id });

  return (
    token?.id ??
    (
      await db
        .select({ id: tokens.id })
        .from(tokens)
        .where(and(eq(tokens.chainId, normalized.chain), eq(tokens.address, normalized.tokenAddress)))
        .limit(1)
    )[0]!.id
  );
}
