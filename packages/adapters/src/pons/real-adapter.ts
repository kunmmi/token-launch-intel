import { JsonRpcProvider, Contract, Interface, type Log } from "ethers";
import type { VenueAdapter, RawVenueEvent, NormalizedLaunch, NormalizedTrade } from "@tli/core";
import {
  PONS_V1_FACTORY_ABI,
  PONS_V2_FACTORY_ABI,
  ERC20_MINIMAL_ABI,
  GRADUATION_PHASE,
} from "./abi.js";
import {
  PONS_V1_FACTORY_ADDRESS,
  PONS_V2_FACTORY_ADDRESS,
  ROBINHOOD_CHAIN_RPC_HTTP,
} from "./addresses.js";

/**
 * REAL Pons adapter — V1 (Uniswap V3, CREATE2 factory) and V2 (bonding
 * curve -> Uniswap V4) both indexed, since both are "active" per the
 * venue registry and the README confirms both factories are live and
 * verified on chain simultaneously.
 *
 * EMPIRICAL FINDING: V1 shows zero TokenDeployed events in the most recent
 * 50,000 blocks (checked live in this session) — it appears dormant, with
 * all real launch activity happening on V2. V1 support is kept (it's
 * correct and unit-tested against the real ABI) since the factory is still
 * technically live, but don't expect it to produce real events; V1's
 * `discover()` path was verified by structure/tests, not by observing a
 * live TokenDeployed event, unlike V2 which was observed repeatedly.
 *
 * Everything below — factory addresses, event signatures, struct layouts,
 * the GraduationPhase enum, chain ID and RPC/WS endpoints — was fetched
 * from primary sources in this session (see abi.ts/addresses.ts headers),
 * not reconstructed from memory. What's still a documented judgment call
 * rather than verified fact:
 *
 *   - No hosted API exists for Pons (confirmed via docs.ponsfamily.com in
 *     an earlier session) — this adapter is the ONLY source of truth,
 *     making its reconcile() method load-bearing in a way Pump's isn't.
 *   - Name/ticker come from a follow-up ERC-20 name()/symbol() call rather
 *     than decoding the launch transaction's calldata, because both V1 and
 *     V2 events omit them and there are multiple launchToken() overloads
 *     per version (harder to decode reliably than just reading the
 *     deployed token directly). This costs 2 extra RPC calls per launch —
 *     a real, deliberate tradeoff, not an oversight.
 *   - V2's graduation progress is derived only from the GraduationPhase
 *     enum (NotGraduated/Swept/PoolCreated/Rescued), not the bonding
 *     curve's actual fill percentage — reading that would require the
 *     PonsV2BondingCurve contract's own ABI, which wasn't fetched in this
 *     session. rawGraduationProgress is a coarse phase-based proxy (0 /
 *     0.5 / 1), explicitly weaker than Pump's exact reserve-ratio
 *     progress — documented here rather than presented as equivalent.
 *   - The public RPC endpoint is documented as "rate-limited, not for
 *     production" by Robinhood's own docs — same caveat as Pump's Phase 0
 *     latency spike, not independently re-verified here.
 *   - **discover() polls via eth_getLogs, not a WebSocket subscription.**
 *     Robinhood's docs advertise `wss://feed.mainnet.chain.robinhood.com`
 *     as "the WebSocket endpoint" for logs, but connecting to it in this
 *     session and inspecting the raw frames showed it is NOT a standard
 *     `eth_subscribe` JSON-RPC feed — it streams Arbitrum Orbit's
 *     proprietary sequencer-feed protocol (raw L2 batch/delayed-message
 *     data), which ethers' WebSocketProvider cannot parse and which isn't
 *     documented for third-party consumption. Reverse-engineering that
 *     protocol was out of scope; polling `eth_getLogs` on the standard
 *     HTTP RPC is the verified-working alternative, at the cost of
 *     poll-interval latency rather than push latency — directly relevant
 *     to the P50<1s target and worth flagging for the eventual latency
 *     spike alongside Pump's Geyser-vs-RPC question.
 */
export class PonsAdapter implements VenueAdapter {
  readonly venue = "pons" as const;

  private readonly httpProvider: JsonRpcProvider;
  private readonly v1Interface = new Interface(PONS_V1_FACTORY_ABI);
  private readonly v2Interface = new Interface(PONS_V2_FACTORY_ABI);

  constructor(rpcHttpUrl: string = ROBINHOOD_CHAIN_RPC_HTTP) {
    this.httpProvider = new JsonRpcProvider(rpcHttpUrl);
  }

  async discover(onEvent: (event: RawVenueEvent) => Promise<void>, fromCursor?: string): Promise<void> {
    const pollIntervalMs = Number(process.env.PONS_POLL_INTERVAL_MS ?? 4000);
    let lastBlock = fromCursor ? Number(fromCursor) : (await this.httpProvider.getBlockNumber()) - 1;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const currentBlock = await this.httpProvider.getBlockNumber().catch(() => lastBlock);
      if (currentBlock > lastBlock) {
        await this.pollRange(lastBlock + 1, currentBlock, onEvent);
        lastBlock = currentBlock;
      }
      await sleep(pollIntervalMs);
    }
  }

  private async pollRange(fromBlock: number, toBlock: number, onEvent: (event: RawVenueEvent) => Promise<void>): Promise<void> {
    for (const [schemaVersion, address, iface] of [
      ["pons-v1", PONS_V1_FACTORY_ADDRESS, this.v1Interface],
      ["pons-v2", PONS_V2_FACTORY_ADDRESS, this.v2Interface],
    ] as const) {
      const logs = await this.httpProvider.getLogs({ address, fromBlock, toBlock }).catch((err) => {
        console.error(`[PonsAdapter] getLogs failed for ${schemaVersion}`, err);
        return [] as Log[];
      });
      for (const log of logs) {
        try {
          await this.handleLog(schemaVersion, iface, log, onEvent);
        } catch (err) {
          console.error(`[PonsAdapter] failed handling log`, log.transactionHash, err);
        }
      }
    }
  }

  private async handleLog(
    schemaVersion: "pons-v1" | "pons-v2",
    iface: Interface,
    log: Log,
    onEvent: (event: RawVenueEvent) => Promise<void>,
  ): Promise<void> {
    const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
    if (!parsed) return;

    const kind = eventKindFor(schemaVersion, parsed.name);
    if (kind === "unknown") return;

    await onEvent({
      venue: "pons",
      kind,
      txHash: log.transactionHash,
      logIndex: log.index,
      blockOrSlot: String(log.blockNumber),
      observedAtTimestamp: Math.floor(Date.now() / 1000), // corrected to the real block timestamp in normalizeLaunch()
      raw: { schemaVersion, eventName: parsed.name, args: serializeLogArgs(parsed.fragment.inputs, parsed.args) },
    });
  }

  async normalizeLaunch(event: RawVenueEvent): Promise<NormalizedLaunch> {
    const raw = event.raw as { schemaVersion: "pons-v1" | "pons-v2"; eventName: string; args: Record<string, unknown> };
    const tokenAddress = String(raw.args["token"]);
    const creatorAddress = String(raw.args[raw.schemaVersion === "pons-v1" ? "deployer" : "deployer"]);

    const [name, symbol, block] = await Promise.all([
      this.readTokenField(tokenAddress, "name"),
      this.readTokenField(tokenAddress, "symbol"),
      this.httpProvider.getBlock(Number(event.blockOrSlot)),
    ]);

    return {
      venue: "pons",
      chain: "robinhood",
      tokenAddress,
      tokenName: name,
      tokenTicker: symbol,
      creatorAddress,
      launchTimestamp: block?.timestamp ?? event.observedAtTimestamp,
      launchTxHash: event.txHash,
      launchBlockOrSlot: event.blockOrSlot,
      venueSchemaVersion: raw.schemaVersion,
      graduationState: "NOT_GRADUATED",
      rawGraduationProgress: 0,
      normalizedGraduationProgressPct: 0,
      rawPayload: raw.args,
    };
  }

  private async readTokenField(tokenAddress: string, field: "name" | "symbol"): Promise<string> {
    try {
      const token = new Contract(tokenAddress, ERC20_MINIMAL_ABI, this.httpProvider);
      const value = await (token[field] as () => Promise<string>)();
      return value;
    } catch {
      return field === "name" ? "(unknown)" : "?"; // token may not strictly follow ERC-20 metadata extension
    }
  }

  async normalizeTrade(_event: RawVenueEvent): Promise<NormalizedTrade> {
    // Neither V1 (swaps happen on the underlying Uniswap V3 pool, not the
    // factory) nor V2 (trades happen on PonsV2BondingCurve, not the
    // factory) emit trade events from the factory contracts this adapter
    // currently watches. Real trade ingestion needs a second subscription
    // per launched pool/curve address — out of scope for this pass, and
    // deliberately not faked.
    throw new Error(
      "PonsAdapter.normalizeTrade: trades happen on per-launch pool/curve contracts, not the factory. Not implemented.",
    );
  }

  async getLaunchState(tokenAddress: string): Promise<Partial<NormalizedLaunch>> {
    const graduation = await this.getGraduationState(tokenAddress);
    return { graduationState: graduation.graduationState, rawGraduationProgress: graduation.rawProgress };
  }

  async getGraduationState(
    tokenAddress: string,
  ): Promise<{ graduationState: NormalizedLaunch["graduationState"]; rawProgress: number }> {
    // Tried against V1 first, then V2 — a token belongs to exactly one
    // factory, and querying the wrong one simply reverts/returns
    // exists=false, which we treat as "try the other version" rather than
    // a hard error.
    const v1Result = await this.tryV1GraduationStatus(tokenAddress);
    if (v1Result) return v1Result;

    const v2Result = await this.tryV2GraduationStatus(tokenAddress);
    if (v2Result) return v2Result;

    return { graduationState: "NOT_GRADUATED", rawProgress: 0 };
  }

  private async tryV1GraduationStatus(
    tokenAddress: string,
  ): Promise<{ graduationState: NormalizedLaunch["graduationState"]; rawProgress: number } | null> {
    try {
      const factory = new Contract(PONS_V1_FACTORY_ADDRESS, PONS_V1_FACTORY_ABI, this.httpProvider);
      const [pairedPrincipal, threshold, graduated] = (await factory.graduationStatus!(tokenAddress)) as [
        bigint,
        bigint,
        boolean,
      ];
      if (threshold === 0n && pairedPrincipal === 0n && !graduated) return null; // token likely doesn't exist on V1
      return graduationFromV1Status(pairedPrincipal, threshold, graduated);
    } catch {
      return null;
    }
  }

  private async tryV2GraduationStatus(
    tokenAddress: string,
  ): Promise<{ graduationState: NormalizedLaunch["graduationState"]; rawProgress: number } | null> {
    try {
      const factory = new Contract(PONS_V2_FACTORY_ADDRESS, PONS_V2_FACTORY_ABI, this.httpProvider);
      const launchedToken = (await factory.getLaunchedToken!(tokenAddress)) as { exists: boolean; phase: bigint };
      if (!launchedToken.exists) return null;
      return graduationFromV2Phase(Number(launchedToken.phase));
    } catch {
      return null;
    }
  }

  /**
   * Real gap-recovery, same shape as PumpAdapter.reconcile() — but here
   * it's the ONLY source of truth, since Pons has no hosted API to
   * cross-check against. Untested against real rate limits in this
   * session (unlike Pump's reconcile, which was actually run against live
   * RPC and hit 429s) — flagging that gap rather than claiming parity.
   */
  async reconcile(fromBlockOrSlot: string, toBlockOrSlot: string): Promise<RawVenueEvent[]> {
    const fromBlock = Number(fromBlockOrSlot);
    const toBlock = Number(toBlockOrSlot);
    const out: RawVenueEvent[] = [];

    for (const [schemaVersion, address, iface] of [
      ["pons-v1", PONS_V1_FACTORY_ADDRESS, this.v1Interface],
      ["pons-v2", PONS_V2_FACTORY_ADDRESS, this.v2Interface],
    ] as const) {
      const logs = await this.httpProvider.getLogs({ address, fromBlock, toBlock });
      for (const log of logs) {
        const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
        if (!parsed) continue;
        const kind = eventKindFor(schemaVersion, parsed.name);
        if (kind === "unknown") continue;
        out.push({
          venue: "pons",
          kind,
          txHash: log.transactionHash,
          logIndex: log.index,
          blockOrSlot: String(log.blockNumber),
          observedAtTimestamp: Math.floor(Date.now() / 1000),
          raw: { schemaVersion, eventName: parsed.name, args: serializeLogArgs(parsed.fragment.inputs, parsed.args) },
        });
      }
    }
    return out;
  }
}

/** Pure so it's unit-testable without an RPC connection — mirrors Pump's graduationFromReserves. */
export function graduationFromV1Status(
  pairedPrincipal: bigint,
  threshold: bigint,
  graduated: boolean,
): { graduationState: NormalizedLaunch["graduationState"]; rawProgress: number } {
  const progress = threshold > 0n ? Number(pairedPrincipal) / Number(threshold) : 0;
  const clamped = Math.max(0, Math.min(1, progress));
  return {
    graduationState: graduated ? "GRADUATED" : clamped > 0 ? "GRADUATING" : "NOT_GRADUATED",
    rawProgress: clamped,
  };
}

/** Pure so it's unit-testable without an RPC connection. See GRADUATION_PHASE in abi.ts for the enum ordinals. */
export function graduationFromV2Phase(
  phase: number,
): { graduationState: NormalizedLaunch["graduationState"]; rawProgress: number } {
  if (phase === GRADUATION_PHASE.NotGraduated) return { graduationState: "NOT_GRADUATED", rawProgress: 0 };
  if (phase === GRADUATION_PHASE.Swept) return { graduationState: "GRADUATING", rawProgress: 0.5 };
  return { graduationState: "GRADUATED", rawProgress: 1 }; // PoolCreated or Rescued
}

export function eventKindFor(schemaVersion: "pons-v1" | "pons-v2", eventName: string): RawVenueEvent["kind"] {
  if (schemaVersion === "pons-v1") {
    // TokenDeployed fires at CREATE2 deploy time — the true age-zero moment.
    // TokenLaunched (V1) fires in the same atomic transaction once the pool
    // is live; treating it as a duplicate/no-op here rather than a second
    // launch avoids double-counting one token as two launches.
    if (eventName === "TokenDeployed") return "launch";
    return "unknown";
  }
  // V2 has no separate "deployed" event — TokenLaunched IS the age-zero moment.
  if (eventName === "TokenLaunched") return "launch";
  if (eventName === "PoolGraduated") return "graduation";
  return "unknown";
}

/**
 * ethers' decoded event `Result` is deceptive: Object.keys()/entries() only
 * return the numeric positional indices ('0', '1', ...) — named fields
 * ('token', 'deployer', ...) exist only via direct property access
 * (parsed.args.token), not as enumerable own properties. A naive
 * Object.entries(args) walk (which this function originally did) silently
 * produces an empty object. Verified interactively against a real decoded
 * TokenLaunched log in this session before fixing. The correct approach:
 * use the event fragment's own parameter list (ParamType[], always has the
 * real names) and pull each named value explicitly.
 */
export function serializeLogArgs(inputs: readonly { name: string }[], args: { getValue(name: string): unknown }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const input of inputs) {
    if (!input.name) continue; // unnamed params are legal Solidity but useless to us
    const value = args.getValue(input.name);
    out[input.name] = typeof value === "bigint" ? value.toString() : value;
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
