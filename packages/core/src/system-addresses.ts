import type { Venue } from "./venue.js";

/**
 * Registry entry for an address that must NEVER count as a buyer, seller,
 * or holder in any metric (AMM pools, bonding-curve vaults, burn addresses,
 * protocol treasuries). This is a maintained data asset backed by the
 * `venue_system_address` Postgres table (packages/db) — this in-memory
 * helper is only a typed view for adapter code, not the source of truth.
 */
export interface VenueSystemAddress {
  venue: Venue;
  address: string;
  label: string;
  reason: "amm_pool" | "bonding_curve_vault" | "burn" | "protocol_treasury" | "other";
}

export class SystemAddressRegistry {
  private readonly byVenue = new Map<Venue, Set<string>>();

  load(entries: VenueSystemAddress[]): void {
    for (const entry of entries) {
      const key = entry.address.toLowerCase();
      const set = this.byVenue.get(entry.venue) ?? new Set<string>();
      set.add(key);
      this.byVenue.set(entry.venue, set);
    }
  }

  isSystemWallet(venue: Venue, address: string): boolean {
    return this.byVenue.get(venue)?.has(address.toLowerCase()) ?? false;
  }
}
