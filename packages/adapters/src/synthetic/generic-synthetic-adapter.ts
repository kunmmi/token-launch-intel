import type { VenueAdapter, RawVenueEvent, NormalizedLaunch, NormalizedTrade, Venue, Chain } from "@tli/core";

/**
 * SYNTHETIC adapter factory — generates schema-valid but entirely fake
 * launch events, parameterized per venue so the Market UI can demonstrate
 * cross-venue comparison (the actual product thesis) before any real chain
 * integration is wired up. See pump/real-adapter.ts etc. for why the real
 * integrations aren't ready yet.
 *
 * `activityBias` lets each synthetic venue produce a different distribution
 * shape (e.g. Pump = high volume/low per-launch activity, Pons = lower
 * volume/higher per-launch activity) so the venue-relative percentile engine
 * has something non-trivial to differentiate — otherwise three identical
 * random distributions would make the percentile demo meaningless.
 */
export interface SyntheticAdapterConfig {
  venue: Venue;
  chain: Chain;
  /** Multiplier applied to synthetic buyer-count generation, to give venues distinct activity profiles. */
  activityBias: number;
}

interface SyntheticLaunchPayload {
  address: string;
  name: string;
  ticker: string;
  creator: string;
  syntheticInitialBuyerCount: number;
}

export class GenericSyntheticAdapter implements VenueAdapter {
  readonly venue: Venue;
  private readonly chain: Chain;
  private readonly activityBias: number;
  private launchCounter = 0;

  constructor(config: SyntheticAdapterConfig) {
    this.venue = config.venue;
    this.chain = config.chain;
    this.activityBias = config.activityBias;
  }

  async discover(onEvent: (event: RawVenueEvent) => Promise<void>, _fromCursor?: string): Promise<void> {
    const intervalMs = Number(process.env.SYNTHETIC_LAUNCH_INTERVAL_MS ?? 3000);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await onEvent(this.makeSyntheticLaunchEvent());
      await sleep(intervalMs + Math.random() * intervalMs);
    }
  }

  async normalizeLaunch(event: RawVenueEvent): Promise<NormalizedLaunch> {
    const raw = event.raw as SyntheticLaunchPayload;
    return {
      venue: this.venue,
      chain: this.chain,
      tokenAddress: raw.address,
      tokenName: raw.name,
      tokenTicker: raw.ticker,
      creatorAddress: raw.creator,
      launchTimestamp: event.observedAtTimestamp,
      launchTxHash: event.txHash,
      launchBlockOrSlot: event.blockOrSlot,
      venueSchemaVersion: `${this.venue}-synthetic-v1`,
      graduationState: "NOT_GRADUATED",
      rawGraduationProgress: 0,
      normalizedGraduationProgressPct: 0,
      rawPayload: raw as unknown as Record<string, unknown>,
    };
  }

  async normalizeTrade(_event: RawVenueEvent): Promise<NormalizedTrade> {
    throw new Error(`${this.venue} synthetic adapter: trade normalization not implemented in M0 bootstrap.`);
  }

  async getLaunchState(_tokenAddress: string): Promise<Partial<NormalizedLaunch>> {
    return {};
  }

  async getGraduationState(): Promise<{ graduationState: NormalizedLaunch["graduationState"]; rawProgress: number }> {
    return { graduationState: "NOT_GRADUATED", rawProgress: 0 };
  }

  async reconcile(): Promise<RawVenueEvent[]> {
    return [];
  }

  private makeSyntheticLaunchEvent(): RawVenueEvent {
    this.launchCounter += 1;
    const suffix = randomSuffix();
    const payload: SyntheticLaunchPayload = {
      address: `Synthetic-${this.venue}-${this.launchCounter}-${suffix}`,
      name: `${this.venue.toUpperCase()} Synthetic Token ${this.launchCounter}`,
      ticker: `${this.venue.slice(0, 3).toUpperCase()}${this.launchCounter}`,
      creator: `SyntheticCreator-${this.venue}-${1 + (this.launchCounter % 5)}`,
      syntheticInitialBuyerCount: Math.floor(Math.random() * 50 * this.activityBias),
    };
    return {
      venue: this.venue,
      kind: "launch",
      txHash: `synthetic-${this.venue}-tx-${this.launchCounter}-${suffix}`,
      logIndex: 0,
      blockOrSlot: String(300_000_000 + this.launchCounter),
      observedAtTimestamp: Math.floor(Date.now() / 1000),
      raw: payload,
    };
  }
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
