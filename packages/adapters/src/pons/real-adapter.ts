import type { VenueAdapter, RawVenueEvent, NormalizedLaunch, NormalizedTrade } from "@tli/core";

/**
 * REAL Pons adapter — NOT YET FUNCTIONAL.
 *
 * Confirmed via docs.ponsfamily.com: Pons has NO hosted API. Integrators
 * must index the V1/V2 factory contracts and bonding curves directly from
 * Robinhood Chain RPC logs. That makes this adapter's reconcile() method
 * (gap-recovery via eth_getLogs backfill) load-bearing in a way it isn't
 * for venues with a fallback API — there is no second source to cross-check
 * against if the live subscription drops an event.
 *
 * Before implementing:
 *   1. Pull the V1 + V2 factory ABI and contract-meta.json from the
 *      ponsdotdev/ponsfamily repo (confirmed public) and generate typed
 *      bindings — do not hand-decode event topics from memory.
 *   2. Run the Phase 0 spike item on Robinhood Chain RPC reliability
 *      (rate limits, log-range limits, node availability) since it's newer
 *      infra with fewer RPC vendors than Solana/BNB — this determines
 *      whether reconcile() can hit the P95<5s / 99%-detection targets at all.
 */
export class PonsAdapter implements VenueAdapter {
  readonly venue = "pons" as const;

  async discover(_onEvent: (event: RawVenueEvent) => Promise<void>, _fromCursor?: string): Promise<void> {
    throw new Error("PonsAdapter.discover: requires V1/V2 factory ABI bindings + RPC reliability spike. See file header.");
  }

  async normalizeLaunch(_event: RawVenueEvent): Promise<NormalizedLaunch> {
    throw new Error("PonsAdapter.normalizeLaunch: requires factory ABI event decoding.");
  }

  async normalizeTrade(_event: RawVenueEvent): Promise<NormalizedTrade> {
    throw new Error("PonsAdapter.normalizeTrade: requires curve-contract trade event decoding.");
  }

  async getLaunchState(_tokenAddress: string): Promise<Partial<NormalizedLaunch>> {
    throw new Error("PonsAdapter.getLaunchState: not implemented.");
  }

  async getGraduationState(
    _tokenAddress: string,
  ): Promise<{ graduationState: NormalizedLaunch["graduationState"]; rawProgress: number }> {
    throw new Error("PonsAdapter.getGraduationState: not implemented — depends on curve contract state layout.");
  }

  async reconcile(_fromBlockOrSlot: string, _toBlockOrSlot: string): Promise<RawVenueEvent[]> {
    throw new Error(
      "PonsAdapter.reconcile: not implemented — CRITICAL since Pons has no hosted API to cross-check against.",
    );
  }
}
