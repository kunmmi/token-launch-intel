import { pgTable, text, timestamp, uuid, integer, doublePrecision, jsonb, index } from "drizzle-orm/pg-core";
import { tokens } from "./tokens.js";

/**
 * One row per holder-concentration measurement of a token, taken via
 * getTokenLargestAccounts (Solana only — see packages/adapters/src/pump's
 * getHolderSnapshot). Multiple rows per token over time, same pattern as
 * `trades`: never overwritten in place, so historical concentration is
 * queryable, not just "the latest number."
 *
 * HONEST LIMITS on what this table actually represents, stated here rather
 * than only in adapter comments, since this is the table a future reader is
 * most likely to open first:
 *   - getTokenLargestAccounts returns at most the top 20 token accounts by
 *     balance, not every holder. `topAccounts` below IS that raw top-20 (or
 *     fewer), not a full holder registry — there is no "total holder count"
 *     column here because that number cannot be produced from this RPC call
 *     without getProgramAccounts (restricted on every free-tier RPC tried in
 *     this project, including Alchemy's).
 *   - `top10ConcentrationPct` excludes accounts owned by the token's own
 *     bonding-curve PDA (verified live: bondingCurvePda(mint) from
 *     @pump-fun/pump-sdk matched a real largest-account owner exactly) —
 *     unsold curve reserve is not "concentration risk" in the normal sense,
 *     and including it would make every fresh launch read as ~100%
 *     concentrated regardless of real buyer behavior.
 *   - EVM venues (Pons/Flap) have no snapshot rows yet — no free RPC path to
 *     equivalent EVM holder data was found in this session; see README.
 */
export const holderSnapshots = pgTable(
  "holder_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => tokens.id),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    totalSupplyRaw: text("total_supply_raw").notNull(), // base units, text to avoid float precision loss (same convention as trades.amountRaw)
    circulatingSupplyRaw: text("circulating_supply_raw").notNull(), // totalSupplyRaw minus bonding-curve-owned reserve
    /** Real top-20-or-fewer accounts as returned by the RPC — {address, balanceRaw, isCurveReserve}[]. Raw evidence, not just the derived percentage. */
    topAccounts: jsonb("top_accounts").notNull(),
    /** Count of topAccounts entries with balance > 0 that are NOT the curve reserve — real distinct buyers visible in the top 20, not a total holder count. */
    visibleHolderCount: integer("visible_holder_count").notNull(),
    /** % of circulatingSupplyRaw held by the top 10 non-curve accounts among topAccounts. Null if circulating supply is zero (nothing bought yet). */
    top10ConcentrationPct: doublePrecision("top10_concentration_pct"),
  },
  (table) => ({
    tokenIdIdx: index("holder_snapshots_token_id_idx").on(table.tokenId),
  }),
);
