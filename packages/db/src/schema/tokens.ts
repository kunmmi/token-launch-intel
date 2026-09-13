import { pgTable, text, timestamp, uuid, integer, doublePrecision, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { venues, chains } from "./venues.js";
import { creators } from "./creators.js";

/**
 * Canonical token record — one row per (chain, address). A token can only
 * belong to one venue in M0 (no cross-venue re-listing scenario modeled yet).
 */
export const tokens = pgTable(
  "tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chainId: text("chain_id")
      .notNull()
      .references(() => chains.id),
    address: text("address").notNull(), // contract address (EVM) or mint (Solana)
    venueId: text("venue_id")
      .notNull()
      .references(() => venues.id),
    name: text("name").notNull(),
    ticker: text("ticker").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    chainAddressUnique: uniqueIndex("tokens_chain_address_unique").on(table.chainId, table.address),
  }),
);

/**
 * One row per launch event (Section 24: Launch entity). launchTimestamp is
 * age-zero per the normalization spec — the venue's token-creation tx
 * timestamp, never first-trade or first-seen-by-us.
 *
 * rawGraduationProgress/normalizedGraduationProgressPct: the raw venue-native
 * number is preserved permanently; the normalized percentage is a derived,
 * revisable modeling choice (see packages/core/src/schema.ts).
 */
export const launches = pgTable(
  "launches",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  tokenId: uuid("token_id")
    .notNull()
    .references(() => tokens.id),
  creatorId: uuid("creator_id").references(() => creators.id), // nullable until creator resolution runs
  creatorAddress: text("creator_address").notNull(), // always populated even before creator resolution
  launchTimestamp: timestamp("launch_timestamp", { withTimezone: true }).notNull(),
  launchTxHash: text("launch_tx_hash").notNull(),
  launchBlockOrSlot: text("launch_block_or_slot").notNull(),
  venueSchemaVersion: text("venue_schema_version").notNull(), // e.g. "pons-v2", "flap-v7"
  graduationState: text("graduation_state").notNull().default("NOT_GRADUATED"),
  rawGraduationProgress: doublePrecision("raw_graduation_progress").notNull().default(0),
  normalizedGraduationProgressPct: doublePrecision("normalized_graduation_progress_pct").notNull().default(0),
  rawPayload: jsonb("raw_payload").notNull(),
  ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // One launch per token in M0 (no re-launch/relist modeling yet). This is
    // what makes normalizer writes idempotent under at-least-once delivery
    // from the Redis Streams consumer group.
    tokenIdUnique: uniqueIndex("launches_token_id_unique").on(table.tokenId),
  }),
);
