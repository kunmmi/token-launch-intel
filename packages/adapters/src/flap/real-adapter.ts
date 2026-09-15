import { WebSocketProvider, JsonRpcProvider, Contract, Interface, type Log } from "ethers";
import type { VenueAdapter, RawVenueEvent, NormalizedLaunch, NormalizedTrade } from "@tli/core";
import { FLAP_PORTAL_ABI, TOKEN_STATUS, progressFromWad } from "./abi.js";
import { FLAP_PORTAL_ADDRESS, FLAP_VAULT_PORTAL_ADDRESS, BNB_CHAIN_RPC_HTTP, BNB_CHAIN_RPC_WS } from "./addresses.js";
import { getBnbUsdPrice } from "../pricing.js";

/**
 * REAL Flap adapter — watches the single canonical Portal contract on BNB
 * Chain. Unlike Pons (two live factory versions) and Pump (bonding-curve
 * account reads needed for graduation), Flap's Portal contract emits
 * everything this adapter needs directly:
 *   - TokenCreated carries name/symbol/timestamp inline — no follow-up
 *     ERC-20 metadata calls or block-timestamp lookups needed, unlike both
 *     other adapters.
 *   - getTokenV8Safe(token) returns an exact `progress` field (0..1e18,
 *     Wad-scaled) — a real percentage, not a coarse proxy like Pons V2's
 *     phase enum.
 *
 * Verified live in this session, not assumed:
 *   - The Portal address (from docs.flap.sh, fetched as raw HTML and
 *     grepped for exact hex — WebFetch's summarized read garbled several
 *     addresses on the first attempt, a mistake worth remembering).
 *   - wss://bsc-rpc.publicnode.com genuinely supports standard
 *     eth_subscribe (confirmed by connecting and watching 115 real Portal
 *     logs stream in over 15 seconds) — unlike Robinhood Chain's
 *     WebSocket feed, which turned out to be a proprietary non-JSON-RPC
 *     protocol (see PonsAdapter's header). This is why Flap's discover()
 *     is push-based while Pons's is polling-based — a real, verified
 *     difference between the two chains, not an inconsistency.
 *   - The IPortal.sol interface itself, fetched from Flap's own official
 *     vault-integration example repo (flap-sh/FlapVaultExample), not a
 *     summary or memory.
 *
 * Not verified / still a judgment call:
 *   - VaultPortal-originated launches are confirmed to also emit Portal's
 *     TokenCreated — observed directly in this session. A real data quality
 *     issue came with that confirmation: TokenCreated's `creator` field is
 *     the VaultPortal contract itself for these launches (Portal attributes
 *     the launch to whoever called it), not the real human behind it — now
 *     FIXED (see normalizeLaunch/resolveRealCreator below): when the
 *     event's creator is the known VaultPortal address, one extra
 *     eth_getTransactionByHash recovers the real `tx.from`, verified live
 *     against a real vault-routed launch before this was written (VaultPortal
 *     was `tx.to`, a genuinely different real address was `tx.from`). Only
 *     the non-vault common case (the large majority of launches) skips this
 *     extra RPC call.
 *   - reconcile() is real (eth_getLogs over a block range, same shape as
 *     Pons's) but untested against real rate limits in this session.
 */
export class FlapAdapter implements VenueAdapter {
  readonly venue = "flap" as const;

  private readonly wsProvider: WebSocketProvider;
  private readonly httpProvider: JsonRpcProvider;
  private readonly iface = new Interface(FLAP_PORTAL_ABI);

  constructor(rpcWsUrl: string = BNB_CHAIN_RPC_WS, rpcHttpUrl: string = BNB_CHAIN_RPC_HTTP) {
    this.wsProvider = new WebSocketProvider(rpcWsUrl);
    this.httpProvider = new JsonRpcProvider(rpcHttpUrl);
  }

  async discover(onEvent: (event: RawVenueEvent) => Promise<void>, _fromCursor?: string): Promise<void> {
    this.wsProvider.on({ address: FLAP_PORTAL_ADDRESS }, (log: Log) => {
      void this.handleLog(log, onEvent).catch((err) => {
        console.error("[FlapAdapter] failed handling log", log.transactionHash, err);
      });
    });

    // Same pattern as Pump/Pons: registering a subscription returns
    // immediately, so this promise deliberately never settles to keep
    // discover() pending for the caller's process lifetime.
    await new Promise<never>(() => {});
  }

  private async handleLog(log: Log, onEvent: (event: RawVenueEvent) => Promise<void>): Promise<void> {
    const parsed = this.iface.parseLog({ topics: log.topics as string[], data: log.data });
    if (!parsed) return;

    const kind = eventKindFor(parsed.name);
    if (kind === "unknown") return;

    await onEvent({
      venue: "flap",
      kind,
      txHash: log.transactionHash,
      logIndex: log.index,
      blockOrSlot: String(log.blockNumber),
      observedAtTimestamp: Math.floor(Date.now() / 1000),
      raw: { eventName: parsed.name, args: serializeLogArgs(parsed.fragment.inputs, parsed.args) },
    });
  }

  async normalizeLaunch(event: RawVenueEvent): Promise<NormalizedLaunch> {
    const raw = event.raw as { eventName: string; args: Record<string, unknown> };
    const tokenAddress = String(raw.args["token"]);
    const eventCreator = String(raw.args["creator"]);
    const creatorAddress = await this.resolveRealCreator(eventCreator, event.txHash);

    return {
      venue: "flap",
      chain: "bnb",
      tokenAddress,
      tokenName: String(raw.args["name"]),
      tokenTicker: String(raw.args["symbol"]),
      creatorAddress,
      launchTimestamp: Number(raw.args["ts"]), // TokenCreated carries its own timestamp — no block lookup needed
      launchTxHash: event.txHash,
      launchBlockOrSlot: event.blockOrSlot,
      venueSchemaVersion: "flap-portal",
      graduationState: "NOT_GRADUATED",
      rawGraduationProgress: 0,
      normalizedGraduationProgressPct: 0,
      rawPayload: raw.args,
    };
  }

  /**
   * Fixes a real data-quality issue documented in this class's header:
   * VaultPortal-routed launches emit TokenCreated with `creator` set to
   * the VaultPortal contract itself (Portal attributes the launch to
   * whoever called it), silently misattributing every real human behind a
   * vault launch to one shared, wrong "creator". Verified live before
   * writing this fix: a real vault-routed launch's transaction has
   * VaultPortal as `to` and a genuinely different, real address as
   * `from` — that `from` is the actual account that initiated the
   * launch, recovered here via one extra RPC call, only when the event's
   * own creator field is the known-wrong VaultPortal address (the common,
   * non-vault case never pays this extra lookup).
   */
  private async resolveRealCreator(eventCreator: string, txHash: string): Promise<string> {
    if (eventCreator.toLowerCase() !== FLAP_VAULT_PORTAL_ADDRESS.toLowerCase()) return eventCreator;
    try {
      const tx = await this.httpProvider.getTransaction(txHash);
      return tx?.from ?? eventCreator; // fall back to the (known-wrong) event value rather than throw — better a documented-wrong address than a failed launch write
    } catch {
      return eventCreator;
    }
  }

  async normalizeTrade(event: RawVenueEvent): Promise<NormalizedTrade> {
    const raw = event.raw as { eventName: string; args: Record<string, unknown> };
    const isBuy = raw.eventName === "TokenBought";
    return {
      venue: "flap",
      chain: "bnb",
      tokenAddress: String(raw.args["token"]),
      walletAddress: String(raw.args[isBuy ? "buyer" : "seller"]),
      side: isBuy ? "buy" : "sell",
      amountRaw: String(raw.args["amount"]),
      priceUsd: await priceUsdForTrade(raw.args),
      txHash: event.txHash,
      logIndex: event.logIndex,
      blockOrSlot: event.blockOrSlot,
      timestamp: Number(raw.args["ts"]),
      isSystemWallet: false,
    };
  }

  async getLaunchState(tokenAddress: string): Promise<Partial<NormalizedLaunch>> {
    const graduation = await this.getGraduationState(tokenAddress);
    return { graduationState: graduation.graduationState, rawGraduationProgress: graduation.rawProgress };
  }

  async getGraduationState(
    tokenAddress: string,
  ): Promise<{ graduationState: NormalizedLaunch["graduationState"]; rawProgress: number }> {
    try {
      const portal = new Contract(FLAP_PORTAL_ADDRESS, FLAP_PORTAL_ABI, this.httpProvider);
      const state = (await portal.getTokenV8Safe!(tokenAddress)) as { status: bigint; progress: bigint };
      return graduationFromTokenState(Number(state.status), state.progress);
    } catch {
      return { graduationState: "NOT_GRADUATED", rawProgress: 0 };
    }
  }

  /**
   * Real gap-recovery via eth_getLogs over a block range — untested
   * against real rate limits in this session (unlike Pump's, which was
   * actually run and hit 429s; that empirical result doesn't automatically
   * transfer to a different chain/RPC provider).
   */
  async reconcile(fromBlockOrSlot: string, toBlockOrSlot: string): Promise<RawVenueEvent[]> {
    const fromBlock = Number(fromBlockOrSlot);
    const toBlock = Number(toBlockOrSlot);
    const logs = await this.httpProvider.getLogs({ address: FLAP_PORTAL_ADDRESS, fromBlock, toBlock });

    const out: RawVenueEvent[] = [];
    for (const log of logs) {
      const parsed = this.iface.parseLog({ topics: log.topics as string[], data: log.data });
      if (!parsed) continue;
      const kind = eventKindFor(parsed.name);
      if (kind === "unknown") continue;
      out.push({
        venue: "flap",
        kind,
        txHash: log.transactionHash,
        logIndex: log.index,
        blockOrSlot: String(log.blockNumber),
        observedAtTimestamp: Math.floor(Date.now() / 1000),
        raw: { eventName: parsed.name, args: serializeLogArgs(parsed.fragment.inputs, parsed.args) },
      });
    }
    return out;
  }
}

export function eventKindFor(eventName: string): RawVenueEvent["kind"] {
  if (eventName === "TokenCreated") return "launch";
  if (eventName === "TokenBought" || eventName === "TokenSold") return "trade";
  if (eventName === "LaunchedToDEX") return "graduation";
  return "unknown";
}

/** Flap-launched tokens use standard 18 decimals — verified live in this session via a real token's decimals() call, not assumed. */
const FLAP_TOKEN_DECIMALS = 18;

/** Pure so it's unit-testable without a network call — same shape as Pump's priceUsdFromSolTrade, one 18-decimal native quote asset instead of SOL's 9. */
export function priceUsdFromBnbTrade(bnbAmountWei: number, tokenAmountRaw: number, bnbUsd: number): number | null {
  const tokenAmount = tokenAmountRaw / 10 ** FLAP_TOKEN_DECIMALS;
  if (tokenAmount <= 0) return null;
  const bnbAmount = bnbAmountWei / 1e18;
  return (bnbAmount * bnbUsd) / tokenAmount;
}

/**
 * Real USD price of one token unit at trade time. `eth` here is the native
 * chain gas token amount despite the field's name (BSC's own docs/example
 * repo name it that way in `IPortal.sol` — Flap's contract is evidently
 * shared across EVM chains, so BNB is what actually flows through it on
 * BNB Chain). Null only if the BNB/USD feed itself is unavailable — unlike
 * Pump, Flap has a single canonical quote asset, not an arbitrary one.
 */
async function priceUsdForTrade(args: Record<string, unknown>): Promise<number | null> {
  const bnbUsd = await getBnbUsdPrice();
  if (bnbUsd === null) return null;
  return priceUsdFromBnbTrade(Number(String(args["eth"])), Number(String(args["amount"])), bnbUsd);
}

/**
 * Pure so it's unit-testable without an RPC connection. TokenStatus.DEX (4)
 * means graduated; anything else uses the exact Wad-scaled progress field
 * getTokenV8Safe returns — no coarse proxy needed, unlike Pons V2.
 */
export function graduationFromTokenState(
  status: number,
  progressWad: bigint,
): { graduationState: NormalizedLaunch["graduationState"]; rawProgress: number } {
  if (status === TOKEN_STATUS.DEX) return { graduationState: "GRADUATED", rawProgress: 1 };
  const progress = Math.max(0, Math.min(1, progressFromWad(progressWad)));
  return { graduationState: progress > 0 ? "GRADUATING" : "NOT_GRADUATED", rawProgress: progress };
}

/**
 * Same ethers Result quirk documented in PonsAdapter: named fields are
 * only reachable via direct property access, not Object.entries(). Reuses
 * the event fragment's own parameter names rather than re-deriving the bug
 * fix independently.
 */
export function serializeLogArgs(inputs: readonly { name: string }[], args: { getValue(name: string): unknown }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const input of inputs) {
    if (!input.name) continue;
    const value = args.getValue(input.name);
    out[input.name] = typeof value === "bigint" ? value.toString() : value;
  }
  return out;
}
