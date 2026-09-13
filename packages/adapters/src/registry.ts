import type { VenueAdapter, Venue } from "@tli/core";
import { PumpAdapter } from "./pump/real-adapter.js";
import { PonsAdapter } from "./pons/real-adapter.js";
import { FlapAdapter } from "./flap/real-adapter.js";
import { GenericSyntheticAdapter } from "./synthetic/generic-synthetic-adapter.js";

/**
 * One place that knows how to construct an adapter per venue, in either
 * mode. The normalizer and each indexer worker both go through this
 * registry rather than importing a specific adapter class directly, so
 * adding a venue (Section 28: Venue Registry) means adding one line here.
 */
export type AdapterMode = "live" | "synthetic";

const ACTIVITY_BIAS: Record<Venue, number> = {
  // Deliberately different so the venue-relative percentile engine has a
  // real distribution difference to demonstrate (PRD Section 9's "150
  // buyers means something different on Pump vs Pons" claim).
  pump: 3.0,
  pons: 1.0,
  flap: 1.8,
};

const CHAIN_FOR_VENUE: Record<Venue, "solana" | "robinhood" | "bnb"> = {
  pump: "solana",
  pons: "robinhood",
  flap: "bnb",
};

export function createAdapter(venue: Venue, mode: AdapterMode): VenueAdapter {
  if (mode === "synthetic") {
    return new GenericSyntheticAdapter({
      venue,
      chain: CHAIN_FOR_VENUE[venue],
      activityBias: ACTIVITY_BIAS[venue],
    });
  }
  switch (venue) {
    case "pump":
      return new PumpAdapter();
    case "pons":
      return new PonsAdapter();
    case "flap":
      return new FlapAdapter();
  }
}
