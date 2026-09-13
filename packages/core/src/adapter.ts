import type { NormalizedLaunch, NormalizedTrade } from "./schema.js";
import type { Venue } from "./venue.js";

/**
 * A raw, undecoded event as pulled off the chain by a venue worker, before
 * normalization. Kept intentionally loose (adapter-specific shape lives in
 * `raw`) because each venue's wire format is different — decoding happens
 * in normalizeLaunch()/normalizeTrade(), not here.
 */
export interface RawVenueEvent {
  venue: Venue;
  kind: "launch" | "trade" | "graduation" | "unknown";
  txHash: string;
  logIndex: number;
  blockOrSlot: string;
  observedAtTimestamp: number;
  raw: unknown;
}

/**
 * Full venue adapter contract (PRD Section 27). M0 only implements the
 * read-only discovery/normalization/state methods below — prepareLaunch,
 * simulateLaunch, prepareBuy, prepareSell are Phase C (M1+) and intentionally
 * throw "not implemented" here so it's impossible to accidentally wire up
 * execution before the intelligence layer is validated.
 */
export interface VenueAdapter {
  readonly venue: Venue;

  /**
   * Start/resume the venue's event subscription. Implementations MUST be
   * resumable from a given cursor (block/slot) for gap-recovery, not just
   * "start from now" — see the reconciliation requirement in the M0 design.
   */
  discover(onEvent: (event: RawVenueEvent) => Promise<void>, fromCursor?: string): Promise<void>;

  /** Decode a raw launch-creation event into the common schema. */
  normalizeLaunch(event: RawVenueEvent): Promise<NormalizedLaunch>;

  /** Decode a raw trade event into the common schema. */
  normalizeTrade(event: RawVenueEvent): Promise<NormalizedTrade>;

  /** Poll current on-chain state for a token (used by reconciliation + backfill). */
  getLaunchState(tokenAddress: string): Promise<Partial<NormalizedLaunch>>;

  /** Current graduation state + raw progress metric for a token. */
  getGraduationState(tokenAddress: string): Promise<{
    graduationState: NormalizedLaunch["graduationState"];
    rawProgress: number;
  }>;

  /**
   * Reconciliation: fetch events in [fromBlockOrSlot, toBlockOrSlot] via
   * direct log/account query (not the live subscription), to detect events
   * the streaming path missed. Required for the 99%-detection pass condition
   * (PRD Section 30) — a venue with no hosted API (e.g. Pons) has no other
   * way to verify completeness.
   */
  reconcile(fromBlockOrSlot: string, toBlockOrSlot: string): Promise<RawVenueEvent[]>;

  // --- Phase C / M1+ — not implemented in M0, present only to fix the shape ---
  prepareLaunch?(params: unknown): Promise<unknown>;
  simulateLaunch?(params: unknown): Promise<unknown>;
  prepareBuy?(params: unknown): Promise<unknown>;
  prepareSell?(params: unknown): Promise<unknown>;
  getFees?(): Promise<unknown>;
}

export function notImplementedInM0(method: string): never {
  throw new Error(
    `${method} is a Phase C/M1+ capability and is intentionally not implemented in M0 (read-only intelligence layer).`,
  );
}
