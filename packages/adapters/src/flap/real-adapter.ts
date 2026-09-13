import type { VenueAdapter, RawVenueEvent, NormalizedLaunch, NormalizedTrade } from "@tli/core";

/**
 * REAL Flap adapter — NOT YET FUNCTIONAL.
 *
 * Confirmed via docs.flap.sh: launches go through VaultPortal's
 * `newTokenV6WithVault` / `newTokenV7WithVault`, which are genuinely
 * non-custodial (wallet signs directly) but come with real decoding
 * complexity this session confirmed and the PRD didn't mention:
 *
 *   - Multiple concurrent vault schemas (V6, V7, tax variants) — this
 *     adapter's normalizeLaunch() MUST detect version from calldata/topic0
 *     before decoding, not assume one shape (see venueSchemaVersion field
 *     on NormalizedLaunch, added specifically for this).
 *   - Vanity salt-mining (7777/8888 suffixes) is part of the construction
 *     flow, which matters for prepareLaunch() in M1 but not for read-only
 *     discovery here — noted so the M1 implementer isn't surprised by it.
 *
 * Before implementing: pull the VaultPortal + Portal ABIs from
 * docs.flap.sh/flap/developers/deployed-contract-addresses and the
 * FlapVaultExample repo, generate typed bindings per version.
 */
export class FlapAdapter implements VenueAdapter {
  readonly venue = "flap" as const;

  async discover(_onEvent: (event: RawVenueEvent) => Promise<void>, _fromCursor?: string): Promise<void> {
    throw new Error("FlapAdapter.discover: requires VaultPortal/Portal ABI bindings per vault version. See file header.");
  }

  async normalizeLaunch(_event: RawVenueEvent): Promise<NormalizedLaunch> {
    throw new Error("FlapAdapter.normalizeLaunch: requires vault-version detection + decoding.");
  }

  async normalizeTrade(_event: RawVenueEvent): Promise<NormalizedTrade> {
    throw new Error("FlapAdapter.normalizeTrade: requires Portal trade event decoding.");
  }

  async getLaunchState(_tokenAddress: string): Promise<Partial<NormalizedLaunch>> {
    throw new Error("FlapAdapter.getLaunchState: not implemented.");
  }

  async getGraduationState(
    _tokenAddress: string,
  ): Promise<{ graduationState: NormalizedLaunch["graduationState"]; rawProgress: number }> {
    throw new Error("FlapAdapter.getGraduationState: not implemented — depends on vault state layout per version.");
  }

  async reconcile(_fromBlockOrSlot: string, _toBlockOrSlot: string): Promise<RawVenueEvent[]> {
    throw new Error("FlapAdapter.reconcile: not implemented.");
  }
}
