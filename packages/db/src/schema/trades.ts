import { pgTable, text, timestamp, uuid, doublePrecision, boolean, uniqueIndex, index } from "drizzle-orm/pg-core";
import { tokens } from "./tokens.js";

/**
 * One row per trade. ARCHITECTURAL NOTE, stated plainly rather than
 * glossed over: the M0 design doc calls for trades to live in a
 * time-series store (ClickHouse), not Postgres — Postgres write-amplification
 * under a continuous trade firehose was flagged as a real scaling risk in
 * the original critique of this project. This table exists here anyway
 * because no ClickHouse client/schema work has been done yet, and getting
 * a real, working end-to-end trade pipeline (even on the "wrong" store)
 * was judged more valuable for M0 functionality than blocking on infra that
 * doesn't exist. This is a known, load-bearing compromise: migrate this
 * table's writes to ClickHouse before real launch volume, not after.
 */
export const trades = pgTable(
  "trades",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => tokens.id),
    walletAddress: text("wallet_address").notNull(),
    side: text("side").notNull(), // "buy" | "sell"
    amountRaw: text("amount_raw").notNull(), // base units, stored as text to avoid float precision loss
    priceUsd: doublePrecision("price_usd"),
    txHash: text("tx_hash").notNull(),
    logIndex: text("log_index").notNull(), // text so it composes cleanly into the unique index below regardless of source type
    blockOrSlot: text("block_or_slot").notNull(),
    tradeTimestamp: timestamp("trade_timestamp", { withTimezone: true }).notNull(),
    isSystemWallet: boolean("is_system_wallet").notNull().default(false),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Idempotency key under at-least-once delivery from the Redis Streams
    // consumer group — same rationale as launches.tokenIdUnique.
    txLogUnique: uniqueIndex("trades_tx_hash_log_index_unique").on(table.txHash, table.logIndex),
    tokenIdIdx: index("trades_token_id_idx").on(table.tokenId),
  }),
);
