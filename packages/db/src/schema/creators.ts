import { pgTable, text, timestamp, boolean, uuid, primaryKey } from "drizzle-orm/pg-core";

/**
 * Platform-level creator profile (Section 13/14). In M0 this is populated
 * passively from observed deployer addresses — no signed cross-wallet
 * linking yet (that's Section 14 / M1). displayName is nullable because
 * most creators in M0 are anonymous addresses with no claimed profile.
 */
export const creators = pgTable("creators", {
  id: uuid("id").primaryKey().defaultRandom(),
  displayName: text("display_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A wallet address observed deploying tokens, optionally linked to a
 * platform Creator profile. `isSelfAttested` distinguishes "creator claimed
 * this is theirs" from `isSignatureVerified`, which requires a signed
 * message proof (Section 14) — NOT implemented in M0. Public creator
 * attribution must never claim a link that isn't at least self-attested;
 * model-suspected links are a separate, internal-only concept not
 * represented in this table (PRD Section 14: "Suspected relationships may
 * be used internally... public creator attribution requires strong evidence").
 */
export const creatorAddresses = pgTable(
  "creator_addresses",
  {
    creatorId: uuid("creator_id")
      .notNull()
      .references(() => creators.id),
    chainId: text("chain_id").notNull(),
    address: text("address").notNull(),
    isSelfAttested: boolean("is_self_attested").notNull().default(false),
    isSignatureVerified: boolean("is_signature_verified").notNull().default(false),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.address] }),
  }),
);
