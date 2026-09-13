import type { VenueAdapter, RawVenueEvent, NormalizedLaunch, NormalizedTrade } from "@tli/core";

/**
 * REAL Pump.fun adapter — NOT YET FUNCTIONAL.
 *
 * Deliberately left unimplemented rather than guessed at. Wiring this up
 * correctly requires two things this session could confirm exist but could
 * not safely fabricate the exact shape of:
 *
 *   1. The Pump.fun program's `create_v2` instruction layout, from the
 *      official IDL (published alongside @pump-fun/pump-sdk on npm and in
 *      the pump-fun/pump-public-docs repo). Decoding logic must be built
 *      against the actual IDL file, not reconstructed from memory.
 *   2. A resolution to the M0 design doc's Phase 0 latency spike: whether
 *      standard `logsSubscribe` RPC meets the P50<1s target, or whether a
 *      Geyser/gRPC (e.g. Yellowstone) stream is required. That decision
 *      changes this file's entire connection/subscription strategy, so
 *      building it before the spike answer would mean throwing it away.
 *
 * Until both are resolved, this class documents the correct SHAPE of the
 * integration (satisfies VenueAdapter) so the rest of the pipeline
 * (normalizer, percentile engine, API, frontend) can be built and tested
 * against it via SyntheticPumpAdapter without blocking on live chain access.
 */
export class PumpAdapter implements VenueAdapter {
  readonly venue = "pump" as const;

  async discover(_onEvent: (event: RawVenueEvent) => Promise<void>, _fromCursor?: string): Promise<void> {
    throw new Error(
      "PumpAdapter.discover: requires the Phase 0 latency spike result (Geyser vs RPC subscription) " +
        "and the official pump-fun IDL before implementation. See file header.",
    );
  }

  async normalizeLaunch(_event: RawVenueEvent): Promise<NormalizedLaunch> {
    throw new Error("PumpAdapter.normalizeLaunch: requires official create_v2 IDL for byte-exact decoding.");
  }

  async normalizeTrade(_event: RawVenueEvent): Promise<NormalizedTrade> {
    throw new Error("PumpAdapter.normalizeTrade: requires official buy/sell instruction IDL for decoding.");
  }

  async getLaunchState(_tokenAddress: string): Promise<Partial<NormalizedLaunch>> {
    throw new Error("PumpAdapter.getLaunchState: not implemented — depends on discover()/IDL work above.");
  }

  async getGraduationState(
    _tokenAddress: string,
  ): Promise<{ graduationState: NormalizedLaunch["graduationState"]; rawProgress: number }> {
    throw new Error("PumpAdapter.getGraduationState: not implemented — depends on bonding-curve account layout.");
  }

  async reconcile(_fromBlockOrSlot: string, _toBlockOrSlot: string): Promise<RawVenueEvent[]> {
    throw new Error("PumpAdapter.reconcile: not implemented — needed for the 99%-detection gap-recovery pass condition.");
  }
}
