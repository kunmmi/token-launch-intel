/**
 * Venue and chain identifiers. M0 supports exactly these three venues.
 * Adding a venue means adding an entry here + an adapter — nothing else
 * in the pipeline should hardcode a venue name (Section 27/28 of the PRD).
 */

export const CHAINS = ["solana", "robinhood", "bnb"] as const;
export type Chain = (typeof CHAINS)[number];

export const VENUES = ["pump", "pons", "flap"] as const;
export type Venue = (typeof VENUES)[number];

export const VENUE_CHAIN: Record<Venue, Chain> = {
  pump: "solana",
  pons: "robinhood",
  flap: "bnb",
};

export const VENUE_REGISTRY_STATUS = [
  "active",
  "supported",
  "watching",
  "deprecated",
] as const;
export type VenueRegistryStatus = (typeof VENUE_REGISTRY_STATUS)[number];
