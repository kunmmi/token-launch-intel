import { pgTable, text, timestamp, boolean, primaryKey } from "drizzle-orm/pg-core";

/**
 * Static reference data for chains and venues. Small, rarely-written tables —
 * belongs in Postgres, not ClickHouse.
 */
export const chains = pgTable("chains", {
  id: text("id").primaryKey(), // "solana" | "robinhood" | "bnb"
  displayName: text("display_name").notNull(),
});

export const venues = pgTable("venues", {
  id: text("id").primaryKey(), // "pump" | "pons" | "flap"
  displayName: text("display_name").notNull(),
  chainId: text("chain_id")
    .notNull()
    .references(() => chains.id),
  registryStatus: text("registry_status").notNull().default("watching"), // active|supported|watching|deprecated (Section 28)
  hasHostedApi: boolean("has_hosted_api").notNull().default(false), // false for Pons — confirmed via docs, drives adapter design
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Maintained registry of addresses that must never count toward buyer/holder/
 * concentration metrics (AMM pools, bonding-curve vaults, burn addresses,
 * protocol treasuries). This is a live data asset the indexer team updates
 * as venues ship new contract versions — not a hardcoded list.
 */
export const venueSystemAddresses = pgTable(
  "venue_system_addresses",
  {
    venueId: text("venue_id")
      .notNull()
      .references(() => venues.id),
    address: text("address").notNull(), // stored lowercase/normalized at write time
    label: text("label").notNull(),
    reason: text("reason").notNull(), // amm_pool | bonding_curve_vault | burn | protocol_treasury | other
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.venueId, table.address] }),
  }),
);
