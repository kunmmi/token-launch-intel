import { z } from "zod";
import { VENUES, CHAINS } from "./venue.js";

/**
 * Common graduation state enum. Every venue's native graduation mechanic
 * (bonding-curve completion, vault threshold, etc.) maps into this enum,
 * but the raw venue-native progress value MUST be preserved alongside it
 * (rawProgress) — the normalized enum is a modeling choice we may revise,
 * the raw number is ground truth we can never recover retroactively.
 */
export const GraduationStateEnum = z.enum([
  "NOT_GRADUATED",
  "GRADUATING",
  "GRADUATED",
]);
export type GraduationState = z.infer<typeof GraduationStateEnum>;

export const VenueEnum = z.enum(VENUES);
export const ChainEnum = z.enum(CHAINS);

/**
 * One row per launch event, in the common normalized schema. This is the
 * contract every VenueAdapter.normalizeLaunch() must produce, regardless
 * of source venue.
 */
export const NormalizedLaunchSchema = z.object({
  venue: VenueEnum,
  chain: ChainEnum,
  /** Contract address (EVM) or mint address (Solana). Canonical token id within its chain. */
  tokenAddress: z.string().min(1),
  tokenName: z.string(),
  tokenTicker: z.string(),
  /** Deployer/creator wallet address as observed on-chain — not yet a platform Creator profile. */
  creatorAddress: z.string().min(1),
  /**
   * Age zero: the block/slot timestamp of the venue's token-creation
   * transaction. Never first-trade, never first-seen-by-us.
   */
  launchTimestamp: z.number().int().positive(),
  launchTxHash: z.string().min(1),
  launchBlockOrSlot: z.string(), // string because Solana slot vs EVM block number differ in range/precision needs
  /** Venue contract/schema version this launch was decoded under (e.g. "pons-v2", "flap-v7"). */
  venueSchemaVersion: z.string(),
  graduationState: GraduationStateEnum,
  /** Raw venue-native progress metric, preserved verbatim. Never discarded. */
  rawGraduationProgress: z.number(),
  normalizedGraduationProgressPct: z.number().min(0).max(100),
  /** Raw payload as decoded from chain, kept for audit/replay/debugging decode logic. */
  rawPayload: z.record(z.unknown()),
});
export type NormalizedLaunch = z.infer<typeof NormalizedLaunchSchema>;

/**
 * One row per trade, deduplicated by (venue, txHash, logIndex) upstream.
 * Wallet addresses appearing in a venue's VenueSystemAddress registry
 * (AMM/vault/system/burn addresses) must be filtered BEFORE this record is
 * counted toward unique-buyer/holder metrics — but the trade itself is
 * still recorded here for completeness/audit.
 */
export const NormalizedTradeSchema = z.object({
  venue: VenueEnum,
  chain: ChainEnum,
  tokenAddress: z.string().min(1),
  walletAddress: z.string().min(1),
  side: z.enum(["buy", "sell"]),
  /** Token amount in base units (string to avoid float precision loss). */
  amountRaw: z.string(),
  /** Trade price in a common unit (USD at time of trade), best-effort from Level 2/3 enrichment. */
  priceUsd: z.number().nonnegative().nullable(),
  txHash: z.string().min(1),
  logIndex: z.number().int().nonnegative(),
  blockOrSlot: z.string(),
  timestamp: z.number().int().positive(),
  isSystemWallet: z.boolean(),
});
export type NormalizedTrade = z.infer<typeof NormalizedTradeSchema>;

/**
 * Historical outcome snapshot at one standardized horizon (PRD Section 25).
 * One row per (tokenAddress, horizonSeconds).
 */
export const LaunchSnapshotSchema = z.object({
  venue: VenueEnum,
  chain: ChainEnum,
  tokenAddress: z.string().min(1),
  horizonSeconds: z.number().int().nonnegative(),
  capturedAtTimestamp: z.number().int().positive(),
  marketCapUsd: z.number().nonnegative().nullable(),
  liquidityUsd: z.number().nonnegative().nullable(),
  holderCount: z.number().int().nonnegative(),
  uniqueBuyerCount: z.number().int().nonnegative(),
  uniqueSellerCount: z.number().int().nonnegative(),
  buyVolumeUsd: z.number().nonnegative().nullable(),
  sellVolumeUsd: z.number().nonnegative().nullable(),
  graduationState: GraduationStateEnum,
  creatorPositionPct: z.number().min(0).max(100).nullable(),
  top10ConcentrationPct: z.number().min(0).max(100).nullable(),
  priceDrawdownPct: z.number().nullable(),
  peakMarketCapUsd: z.number().nonnegative().nullable(),
});
export type LaunchSnapshot = z.infer<typeof LaunchSnapshotSchema>;
