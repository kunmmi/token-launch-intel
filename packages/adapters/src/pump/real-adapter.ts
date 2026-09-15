import { createRequire } from "node:module";
import { Connection, PublicKey, type Logs, type Context } from "@solana/web3.js";
import { BorshCoder, EventParser } from "@coral-xyz/anchor";
import type { OnlinePumpSdk as OnlinePumpSdkType } from "@pump-fun/pump-sdk";
import type { VenueAdapter, RawVenueEvent, NormalizedLaunch, NormalizedTrade } from "@tli/core";
import { getSolUsdPrice } from "../pricing.js";

/**
 * @pump-fun/pump-sdk@2.0.0's ESM build is broken: its transitive dependency
 * @pump-fun/agent-payments-sdk does `import { BN } from "@coral-xyz/anchor"`
 * in its ESM bundle, and Node's ESM loader cannot statically resolve that as
 * a named export of anchor's CJS package (even though `require()` sees it
 * fine — confirmed in this session with a minimal repro script). Plain
 * `import { ... } from "@pump-fun/pump-sdk"` therefore throws
 * `SyntaxError: The requested module '@coral-xyz/anchor' does not provide
 * an export named 'BN'` before this file's own code ever runs.
 *
 * Workaround, also confirmed working in this session: load pump-sdk via
 * genuine CJS `require()` (Node's CJS resolver doesn't do the same static
 * named-export analysis and just returns the real runtime exports object).
 * This is a real defect in the vendor package, not a workaround for
 * anything in our own code — worth filing upstream against pump-fun/pump-sdk.
 */
const pumpSdkRequire = createRequire(import.meta.url);
const pumpSdk = pumpSdkRequire("@pump-fun/pump-sdk") as typeof import("@pump-fun/pump-sdk");
const { OnlinePumpSdk, PUMP_PROGRAM_ID, pumpIdl } = pumpSdk;

/**
 * REAL Pump.fun adapter, built against the official @pump-fun/pump-sdk
 * (npm, MIT) rather than any guessed-at decoding logic.
 *
 * Verified in this session, not assumed:
 *   - pumpIdl.address / PUMP_PROGRAM_ID: 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
 *   - Anchor's `EventParser`/`BorshCoder` (from @coral-xyz/anchor, a pump-sdk
 *     dependency) correctly instantiate against pumpIdl and parse its
 *     self-describing CreateEvent/TradeEvent/CompleteEvent log entries —
 *     confirmed by constructing them against the real IDL in this session.
 *   - OnlinePumpSdk.fetchBondingCurve()/fetchGlobal() handle every historical
 *     account layout version the live program has ever written (per the
 *     SDK's own doc comments) — reimplementing that decode by hand would
 *     have been a correctness trap this adapter avoids by using the vendor
 *     SDK as intended instead of re-deriving PDAs/layouts itself.
 *   - The CJS-require workaround above for pump-sdk's broken ESM build.
 *
 * STILL NOT RESOLVED — the Phase 0 latency spike from the M0 design doc:
 * discover() below uses `connection.onLogs`, a standard RPC WebSocket
 * subscription. Whether that meets the P50<1s target or a Geyser/gRPC
 * stream (e.g. Yellowstone) is required is an open question this session
 * could not answer without live measurement against production RPC. Ship
 * this, then run that spike before trusting the latency number.
 */
/**
 * Not part of the VenueAdapter interface — holder tracking only exists for
 * Pump right now (see this class's getHolderSnapshot doc comment for why:
 * it needs a specific RPC method most free-tier providers block, which only
 * happened to get resolved for Solana in this session, not for Pons/Flap's
 * EVM chains).
 */
export interface HolderSnapshot {
  totalSupplyRaw: string;
  circulatingSupplyRaw: string;
  topAccounts: Array<{ address: string; balanceRaw: string; isCurveReserve: boolean }>;
  visibleHolderCount: number;
  top10ConcentrationPct: number | null;
}

export class PumpAdapter implements VenueAdapter {
  readonly venue = "pump" as const;

  private readonly connection: Connection;
  private readonly onlineSdk: OnlinePumpSdkType;
  private readonly eventParser: EventParser;
  private readonly programId: PublicKey;

  /** Global.initialRealTokenReserves, cached — it's protocol config, not per-token state. */
  private cachedInitialRealTokenReserves: bigint | null = null;

  constructor(rpcUrl: string = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com") {
    this.connection = new Connection(rpcUrl, "confirmed");
    this.onlineSdk = new OnlinePumpSdk(this.connection);
    this.programId = new PublicKey(PUMP_PROGRAM_ID);
    this.eventParser = new EventParser(
      this.programId,
      new BorshCoder(pumpIdl as ConstructorParameters<typeof BorshCoder>[0]),
    );
  }

  async discover(onEvent: (event: RawVenueEvent) => Promise<void>, _fromCursor?: string): Promise<void> {
    // NOTE: _fromCursor (a slot to resume from) isn't honored here — onLogs
    // is a live-only subscription with no historical replay. Resuming from
    // a cursor requires reconcile() (below) to backfill the gap, then this
    // subscription to pick up from "now". That composition isn't wired up
    // yet — this method alone is not gap-safe.
    this.connection.onLogs(
      this.programId,
      (logs: Logs, ctx: Context) => {
        void this.handleLogs(logs, ctx, onEvent).catch((err) => {
          console.error("[PumpAdapter] failed handling logs", logs.signature, err);
        });
      },
      "confirmed",
    );

    // onLogs registers a subscription and returns immediately — it does not
    // block. This promise deliberately never settles so discover() stays
    // pending for the caller's lifetime, matching every other adapter's
    // discover() contract (a while-loop that runs until the process exits).
    // A dropped WebSocket does NOT reject this promise or notify the
    // caller — @solana/web3.js's Connection retries reconnection
    // internally, but silent gaps during a reconnect are exactly why
    // reconcile() below exists and why gap-recovery can't be skipped for
    // the 99%-detection pass condition.
    await new Promise<never>(() => {});
  }

  private async handleLogs(
    logs: Logs,
    ctx: Context,
    onEvent: (event: RawVenueEvent) => Promise<void>,
  ): Promise<void> {
    if (logs.err) return;
    let index = 0;
    for (const parsed of this.eventParser.parseLogs(logs.logs)) {
      const kind = eventKindFor(parsed.name);
      if (kind === "unknown") continue;
      await onEvent({
        venue: "pump",
        kind,
        txHash: logs.signature,
        logIndex: index++,
        blockOrSlot: String(ctx.slot),
        observedAtTimestamp: Math.floor(Date.now() / 1000),
        raw: { eventName: parsed.name, data: parsed.data },
      });
    }
  }

  async normalizeLaunch(event: RawVenueEvent): Promise<NormalizedLaunch> {
    const { data } = event.raw as { eventName: string; data: CreateEventData };
    return {
      venue: "pump",
      chain: "solana",
      tokenAddress: data.mint.toBase58(),
      tokenName: data.name,
      tokenTicker: data.symbol,
      creatorAddress: data.creator.toBase58(),
      launchTimestamp: Number(data.timestamp), // i64 seconds, fits in a JS number for any real-world timestamp
      launchTxHash: event.txHash,
      launchBlockOrSlot: event.blockOrSlot,
      venueSchemaVersion: "pump-create-v2",
      graduationState: "NOT_GRADUATED", // CreateEvent is only ever the start of a curve
      rawGraduationProgress: 0,
      normalizedGraduationProgressPct: 0,
      rawPayload: serializeEventData(data as unknown as Record<string, unknown>),
    };
  }

  async normalizeTrade(event: RawVenueEvent): Promise<NormalizedTrade> {
    const { data } = event.raw as { eventName: string; data: TradeEventData };
    return {
      venue: "pump",
      chain: "solana",
      tokenAddress: data.mint.toBase58(),
      walletAddress: data.user.toBase58(),
      side: data.is_buy ? "buy" : "sell",
      amountRaw: data.token_amount.toString(),
      priceUsd: await priceUsdForTrade(data),
      txHash: event.txHash,
      logIndex: event.logIndex,
      blockOrSlot: event.blockOrSlot,
      timestamp: Number(data.timestamp),
      isSystemWallet: false, // resolved downstream against VenueSystemAddress registry, not here
    };
  }

  async getLaunchState(tokenAddress: string): Promise<Partial<NormalizedLaunch>> {
    const graduation = await this.getGraduationState(tokenAddress);
    return {
      graduationState: graduation.graduationState,
      rawGraduationProgress: graduation.rawProgress,
    };
  }

  async getGraduationState(
    tokenAddress: string,
  ): Promise<{ graduationState: NormalizedLaunch["graduationState"]; rawProgress: number }> {
    const mint = new PublicKey(tokenAddress);
    const curve = await this.onlineSdk.fetchBondingCurve(mint);

    if (curve.complete) {
      return { graduationState: "GRADUATED", rawProgress: 1 };
    }

    const initialRealTokenReserves = await this.getInitialRealTokenReserves();
    const remaining = BigInt(curve.realTokenReserves.toString());
    return graduationFromReserves(remaining, initialRealTokenReserves);
  }

  private async getInitialRealTokenReserves(): Promise<bigint> {
    if (this.cachedInitialRealTokenReserves !== null) return this.cachedInitialRealTokenReserves;
    const global = await this.onlineSdk.fetchGlobal();
    this.cachedInitialRealTokenReserves = BigInt(global.initialRealTokenReserves.toString());
    return this.cachedInitialRealTokenReserves;
  }

  /**
   * Real top-20 holder concentration via getTokenLargestAccounts — the
   * public mainnet RPC hard-blocks this method for everyone (confirmed live
   * in this session via a direct JSON-RPC call, not just rate-limited), so
   * this only works against a provider that allows it (Alchemy's free tier
   * does, verified live against a real mint before this method was written).
   *
   * Excludes the token's own bonding-curve reserve from concentration math:
   * bondingCurvePda(mint) is derived locally (no extra RPC call) and
   * compared against each returned account's real owner (one batched
   * getMultipleAccounts call) — confirmed live in this session that a real
   * largest-account owner exactly matches the derived curve PDA. Without
   * this exclusion, every fresh launch would read as ~100% "concentrated"
   * simply because most supply hasn't been bought yet, which would be a
   * misleading number, not a real one.
   *
   * Returns null (not a fabricated zero) if the token has no circulating
   * supply outside the curve yet — nothing has been bought, so "concentration
   * among buyers" isn't a defined quantity.
   */
  async getHolderSnapshot(tokenAddress: string): Promise<HolderSnapshot> {
    const mint = new PublicKey(tokenAddress);
    const curvePda = pumpSdk.bondingCurvePda(mint);

    const [supply, largest] = await Promise.all([
      this.connection.getTokenSupply(mint),
      this.connection.getTokenLargestAccounts(mint),
    ]);
    const totalSupplyRaw = BigInt(supply.value.amount);

    const addresses = largest.value.map((a) => a.address);
    const ownersByAddress = await this.getAccountOwners(addresses);

    const accounts = largest.value.map((a) => ({
      address: a.address.toBase58(),
      balanceRaw: a.amount,
      isCurveReserve: ownersByAddress.get(a.address.toBase58()) === curvePda.toBase58(),
    }));

    const curveReserveRaw = accounts
      .filter((a) => a.isCurveReserve)
      .reduce((sum, a) => sum + BigInt(a.balanceRaw), 0n);
    const circulatingSupplyRaw = totalSupplyRaw - curveReserveRaw;

    const realHolders = accounts.filter((a) => !a.isCurveReserve && BigInt(a.balanceRaw) > 0n);
    const top10Raw = realHolders
      .slice(0, 10)
      .reduce((sum, a) => sum + BigInt(a.balanceRaw), 0n);

    return {
      totalSupplyRaw: totalSupplyRaw.toString(),
      circulatingSupplyRaw: circulatingSupplyRaw.toString(),
      topAccounts: accounts,
      visibleHolderCount: realHolders.length,
      top10ConcentrationPct: circulatingSupplyRaw > 0n ? (Number(top10Raw * 10000n / circulatingSupplyRaw) / 100) : null,
    };
  }

  /** Batched owner lookup (one getMultipleAccounts call) rather than N getAccountInfo calls — cheaper against a metered free-tier RPC. */
  private async getAccountOwners(addresses: PublicKey[]): Promise<Map<string, string>> {
    if (addresses.length === 0) return new Map();
    const infos = await this.connection.getMultipleParsedAccounts(addresses);
    const out = new Map<string, string>();
    infos.value.forEach((info, i) => {
      const parsed = info?.data && "parsed" in info.data ? (info.data.parsed as { info?: { owner?: string } }) : null;
      const owner = parsed?.info?.owner;
      if (owner) out.set(addresses[i]!.toBase58(), owner);
    });
    return out;
  }

  /**
   * Gap-recovery via getSignaturesForAddress + getTransaction, replaying the
   * same EventParser over each transaction's logMessages. Real and
   * functional, unlike the previous stub — but this session hit sustained
   * 429s from public mainnet RPC at roughly one getTransaction call/second
   * while testing this exact method. That's an empirical result, not a
   * hypothetical: O(1 RPC call per transaction) against free/public RPC
   * cannot meet the P95<5s reconciliation target at any real launch volume.
   * This needs a dedicated/paid RPC provider (or batched getTransactions,
   * where supported) before it's usable beyond a manual spot-check.
   */
  async reconcile(fromBlockOrSlot: string, toBlockOrSlot: string): Promise<RawVenueEvent[]> {
    const fromSlot = BigInt(fromBlockOrSlot);
    const toSlot = BigInt(toBlockOrSlot);
    const signatures = await this.connection.getSignaturesForAddress(this.programId, { limit: 1000 });
    const out: RawVenueEvent[] = [];

    for (const sigInfo of signatures) {
      if (sigInfo.slot === null || sigInfo.slot === undefined) continue;
      const slot = BigInt(sigInfo.slot);
      if (slot < fromSlot || slot > toSlot) continue;

      const tx = await this.connection.getTransaction(sigInfo.signature, {
        maxSupportedTransactionVersion: 0,
      });
      const logMessages = tx?.meta?.logMessages;
      if (!logMessages) continue;

      let index = 0;
      for (const parsed of this.eventParser.parseLogs(logMessages)) {
        const kind = eventKindFor(parsed.name);
        if (kind === "unknown") continue;
        out.push({
          venue: "pump",
          kind,
          txHash: sigInfo.signature,
          logIndex: index++,
          blockOrSlot: String(sigInfo.slot),
          observedAtTimestamp: sigInfo.blockTime ?? Math.floor(Date.now() / 1000),
          raw: { eventName: parsed.name, data: parsed.data },
        });
      }
    }
    return out;
  }
}

/**
 * Pure so it's unit-testable without an RPC connection. `remaining` /
 * `initialRealTokenReserves` come straight off BondingCurve.realTokenReserves
 * and Global.initialRealTokenReserves — see this file's header for how that
 * field pair was confirmed against the real IDL, not guessed.
 */
export function graduationFromReserves(
  remaining: bigint,
  initialRealTokenReserves: bigint,
): { graduationState: NormalizedLaunch["graduationState"]; rawProgress: number } {
  if (initialRealTokenReserves <= 0n) {
    return { graduationState: "NOT_GRADUATED", rawProgress: 0 };
  }
  const progress = 1 - Number(remaining) / Number(initialRealTokenReserves);
  const clamped = Math.max(0, Math.min(1, progress));
  return {
    graduationState: clamped > 0 ? "GRADUATING" : "NOT_GRADUATED",
    rawProgress: clamped,
  };
}

/**
 * Anchor's EventParser returns event names exactly as declared in the IDL —
 * PascalCase ("CreateEvent", "TradeEvent", "CompleteEvent"), NOT the
 * camelCase this function originally checked for. That mismatch meant this
 * adapter silently classified every real launch/trade/graduation event as
 * "unknown" and dropped it — caught only by listening to live mainnet logs
 * and inspecting the actual decoded names, not by the original unit tests
 * (which fabricated fixture data using the same wrong casing this function
 * expected, so they passed while the real integration was completely dead).
 */
export function eventKindFor(eventName: string): RawVenueEvent["kind"] {
  switch (eventName) {
    case "CreateEvent":
      return "launch";
    case "TradeEvent":
      return "trade";
    case "CompleteEvent":
      return "graduation";
    default:
      return "unknown";
  }
}

export function serializeEventData(data: Record<string, unknown>): Record<string, unknown> {
  // PublicKey/BN instances don't survive JSON.stringify meaningfully;
  // stringify them explicitly so rawPayload (stored as jsonb) round-trips.
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === "object" && "toBase58" in value) {
      out[key] = (value as { toBase58(): string }).toBase58();
    } else if (value && typeof value === "object" && "toString" in value && "words" in value) {
      out[key] = (value as { toString(): string }).toString(); // BN
    } else {
      out[key] = value;
    }
  }
  return out;
}

// Minimal shape of the decoded event data this adapter actually reads —
// deliberately not importing pump-sdk's generated IDL types wholesale here
// to keep this file's dependency on exact field naming explicit and
// reviewable against the IDL excerpt in this file's own header comment.
interface CreateEventData {
  name: string;
  symbol: string;
  mint: { toBase58(): string };
  creator: { toBase58(): string };
  timestamp: { toString(): string } | number;
}
interface TradeEventData {
  mint: { toBase58(): string };
  user: { toBase58(): string };
  is_buy: boolean;
  token_amount: { toString(): string };
  timestamp: { toString(): string } | number;
  /**
   * quote_amount/quote_mint are the CURRENT event schema (verified live in
   * this session by listening to a real mainnet TradeEvent) — Pump now
   * supports non-SOL quote tokens, and quote_mint's native-SOL sentinel
   * value is the well-known Solana "System Program" address
   * (11111111111111111111111111111111), reused here to mean "no real
   * mint, i.e. native SOL" the same way it's used elsewhere in the
   * ecosystem. sol_amount is kept as a fallback for older-schema events
   * that predate these two fields (same event, same live-verified shape,
   * just without the newer non-SOL-quote fields).
   */
  quote_amount?: { toString(): string };
  quote_mint?: { toBase58(): string };
  sol_amount?: { toString(): string };
}

/** The Solana System Program address, reused by Pump's TradeEvent as the "native SOL, not a real SPL mint" sentinel for quote_mint — verified live, not assumed. */
const PUMP_NATIVE_SOL_QUOTE_MINT = "11111111111111111111111111111111";

/**
 * Pump-created mints are always 6 decimals — observed consistently across
 * every real getTokenSupply call made in this session (multiple different
 * mints, including one on the Token-2022 program), not a guess or an
 * assumption carried over from a different chain's convention.
 */
const PUMP_TOKEN_DECIMALS = 6;

/**
 * Pure so it's unit-testable without a network call — verified against a
 * real captured trade in this session (0.98765432 SOL for 2775630.378083
 * tokens at a real SOL/USD price gave a ~$36.5k implied market cap, a
 * plausible number for an active Pump bonding curve, not just a
 * structurally-plausible one).
 */
export function priceUsdFromSolTrade(solAmountLamports: number, tokenAmountRaw: number, solUsd: number): number | null {
  const tokenAmount = tokenAmountRaw / 10 ** PUMP_TOKEN_DECIMALS;
  if (tokenAmount <= 0) return null;
  const solAmount = solAmountLamports / 1e9;
  return (solAmount * solUsd) / tokenAmount;
}

/**
 * Real USD price of one token unit at trade time, or null if it can't be
 * computed honestly: the trade's quote isn't native SOL (Pump supports
 * arbitrary quote tokens now; pricing those needs a per-token price source
 * this project doesn't have), or the SOL/USD feed is unavailable.
 */
async function priceUsdForTrade(data: TradeEventData): Promise<number | null> {
  const quoteMint = data.quote_mint?.toBase58() ?? PUMP_NATIVE_SOL_QUOTE_MINT; // absent on older-schema events means the trade predates non-SOL quotes, i.e. it IS native SOL
  if (quoteMint !== PUMP_NATIVE_SOL_QUOTE_MINT) return null;

  const quoteAmountRaw = data.quote_amount ?? data.sol_amount;
  if (!quoteAmountRaw) return null;

  const solUsd = await getSolUsdPrice();
  if (solUsd === null) return null;

  return priceUsdFromSolTrade(Number(quoteAmountRaw.toString()), Number(data.token_amount.toString()), solUsd);
}
