import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { PublicKey } from "@solana/web3.js";
import { BorshCoder, EventParser } from "@coral-xyz/anchor";
import BN from "bn.js";
import { PumpAdapter, eventKindFor, serializeEventData, graduationFromReserves, priceUsdFromSolTrade } from "./real-adapter.js";
import type { RawVenueEvent } from "@tli/core";
import realCreateEvents from "./__fixtures__/real-create-events.json" with { type: "json" };

/**
 * IMPORTANT — what these tests do and don't cover:
 *
 * `__fixtures__/real-create-events.json` holds two GENUINE mainnet
 * transactions' `logMessages`, captured live from
 * `connection.onLogs(PUMP_PROGRAM_ID, ...)` against public RPC in this
 * session (signatures/mints are real and checkable on any Solana explorer).
 * The fixture-based tests below run those exact log lines through the same
 * EventParser/BorshCoder construction real-adapter.ts uses, with zero
 * network dependency at test time — this is a true regression test of the
 * decode path, not a synthetic approximation of it.
 *
 * That capture is also how a real bug got caught: this file originally
 * fabricated event names as "createEvent"/"tradeEvent" (camelCase) for its
 * synthetic-data tests below, matching a wrong assumption baked into
 * eventKindFor(). Live decoding of these real logs showed Anchor's
 * EventParser actually returns PascalCase names ("CreateEvent",
 * "TradeEvent") exactly as declared in the IDL — meaning the real adapter
 * was silently classifying every real event as "unknown" and dropping it.
 * Both eventKindFor() and these fixtures now reflect the real, verified
 * casing; see the regression guard in the eventKindFor test below and the
 * comment on eventKindFor() itself in real-adapter.ts.
 *
 * The remaining synthetic-data tests (normalizeLaunch/normalizeTrade with
 * hand-built event objects) still add value: they isolate the pure mapping
 * logic from decode concerns and are easier to extend with edge cases
 * (missing fields, zero values) than real captured transactions would be.
 */

const pumpSdkRequire = createRequire(import.meta.url);
const { pumpIdl, PUMP_PROGRAM_ID } = pumpSdkRequire("@pump-fun/pump-sdk") as typeof import("@pump-fun/pump-sdk");
const testCoder = new BorshCoder(pumpIdl as ConstructorParameters<typeof BorshCoder>[0]);
const testParser = new EventParser(new PublicKey(PUMP_PROGRAM_ID), testCoder);

test("real captured mainnet CreateEvent logs decode to the expected values", () => {
  assert.equal(realCreateEvents.length, 2, "fixture should hold exactly the 2 captured transactions");

  for (const fixture of realCreateEvents) {
    const decodedEvents = [...testParser.parseLogs(fixture.logs)];
    const createEvent = decodedEvents.find((e) => e.name === "CreateEvent");
    assert.ok(createEvent, `expected a CreateEvent in real tx ${fixture.signature}`);

    const data = createEvent.data as { name: string; symbol: string; mint: PublicKey; creator: PublicKey; timestamp: BN };
    assert.equal(data.name, fixture.decoded.name);
    assert.equal(data.symbol, fixture.decoded.symbol);
    assert.equal(data.mint.toBase58(), fixture.decoded.mint);
    assert.equal(data.creator.toBase58(), fixture.decoded.creator);
    assert.equal(data.timestamp.toString(), fixture.decoded.timestamp);
  }
});

test("real captured mainnet CreateEvent normalizes end-to-end via PumpAdapter.normalizeLaunch", async () => {
  const adapter = new PumpAdapter("https://api.mainnet-beta.solana.com"); // constructing doesn't hit the network
  const fixture = realCreateEvents[0]!;
  const decodedEvents = [...testParser.parseLogs(fixture.logs)];
  const createEvent = decodedEvents.find((e) => e.name === "CreateEvent")!;

  const rawEvent: RawVenueEvent = {
    venue: "pump",
    kind: "launch",
    txHash: fixture.signature,
    logIndex: 0,
    blockOrSlot: String(fixture.slot),
    observedAtTimestamp: Math.floor(Date.now() / 1000),
    raw: { eventName: createEvent.name, data: createEvent.data },
  };

  const normalized = await adapter.normalizeLaunch(rawEvent);
  assert.equal(normalized.tokenAddress, fixture.decoded.mint);
  assert.equal(normalized.tokenName, fixture.decoded.name);
  assert.equal(normalized.tokenTicker, fixture.decoded.symbol);
  assert.equal(normalized.creatorAddress, fixture.decoded.creator);
  assert.equal(normalized.launchTimestamp, Number(fixture.decoded.timestamp));
  assert.equal(normalized.launchTxHash, fixture.signature);
});

test("eventKindFor maps known Anchor event names (PascalCase, as EventParser actually returns them) to RawVenueEvent kinds", () => {
  assert.equal(eventKindFor("CreateEvent"), "launch");
  assert.equal(eventKindFor("TradeEvent"), "trade");
  assert.equal(eventKindFor("CompleteEvent"), "graduation");
  assert.equal(eventKindFor("SomeFutureEvent"), "unknown");
  // Regression guard for the actual bug found in this session: the wrong
  // camelCase form must NOT match, or this adapter silently drops every
  // real event again.
  assert.equal(eventKindFor("createEvent"), "unknown");
});

test("serializeEventData converts PublicKey and BN fields to strings for jsonb storage", () => {
  const mint = new PublicKey("11111111111111111111111111111111");
  const amount = new BN("123456789012345");
  const out = serializeEventData({ mint, amount, isBuy: true, name: "Test" });
  assert.equal(out["mint"], mint.toBase58());
  assert.equal(out["amount"], "123456789012345");
  assert.equal(out["isBuy"], true);
  assert.equal(out["name"], "Test");
});

test("graduationFromReserves: fresh curve (all reserves remaining) is NOT_GRADUATED at 0 progress", () => {
  const result = graduationFromReserves(1_000_000n, 1_000_000n);
  assert.equal(result.graduationState, "NOT_GRADUATED");
  assert.equal(result.rawProgress, 0);
});

test("graduationFromReserves: partially sold curve is GRADUATING with proportional progress", () => {
  const result = graduationFromReserves(400_000n, 1_000_000n);
  assert.equal(result.graduationState, "GRADUATING");
  assert.ok(Math.abs(result.rawProgress - 0.6) < 1e-9, `expected ~0.6, got ${result.rawProgress}`);
});

test("graduationFromReserves: zero initial reserves (defensive) doesn't divide by zero", () => {
  const result = graduationFromReserves(0n, 0n);
  assert.equal(result.graduationState, "NOT_GRADUATED");
  assert.equal(result.rawProgress, 0);
});

test("normalizeLaunch maps a decoded CreateEvent to the common schema correctly", async () => {
  const adapter = new PumpAdapter("https://api.mainnet-beta.solana.com"); // constructing doesn't hit the network
  const mint = new PublicKey("A14Xc1ArgTTYdzo5RBcnbcwC4m15Tc9Rzm8cEdMuvwpE");
  const creator = new PublicKey("3cxVvQFF4PUtZYtMXFLVQBpNvSSKAogPxbgYro1RTN7a");

  const event: RawVenueEvent = {
    venue: "pump",
    kind: "launch",
    txHash: "test-sig",
    logIndex: 0,
    blockOrSlot: "123456",
    observedAtTimestamp: 1_700_000_000,
    raw: {
      eventName: "CreateEvent",
      data: {
        name: "Test Token",
        symbol: "TEST",
        mint,
        creator,
        timestamp: new BN(1_700_000_000),
      },
    },
  };

  const normalized = await adapter.normalizeLaunch(event);
  assert.equal(normalized.venue, "pump");
  assert.equal(normalized.chain, "solana");
  assert.equal(normalized.tokenAddress, mint.toBase58());
  assert.equal(normalized.tokenName, "Test Token");
  assert.equal(normalized.tokenTicker, "TEST");
  assert.equal(normalized.creatorAddress, creator.toBase58());
  assert.equal(normalized.launchTimestamp, 1_700_000_000);
  assert.equal(normalized.graduationState, "NOT_GRADUATED");
});

test("normalizeTrade maps a decoded TradeEvent to the common schema correctly", async () => {
  const adapter = new PumpAdapter("https://api.mainnet-beta.solana.com");
  const mint = new PublicKey("A14Xc1ArgTTYdzo5RBcnbcwC4m15Tc9Rzm8cEdMuvwpE");
  const user = new PublicKey("3cxVvQFF4PUtZYtMXFLVQBpNvSSKAogPxbgYro1RTN7a");

  const event: RawVenueEvent = {
    venue: "pump",
    kind: "trade",
    txHash: "test-sig-2",
    logIndex: 1,
    blockOrSlot: "123457",
    observedAtTimestamp: 1_700_000_100,
    raw: {
      eventName: "TradeEvent",
      data: {
        mint,
        user,
        is_buy: true,
        token_amount: new BN("500000000"),
        timestamp: new BN(1_700_000_100),
      },
    },
  };

  const normalized = await adapter.normalizeTrade(event);
  assert.equal(normalized.tokenAddress, mint.toBase58());
  assert.equal(normalized.walletAddress, user.toBase58());
  assert.equal(normalized.side, "buy");
  assert.equal(normalized.amountRaw, "500000000");
  assert.equal(normalized.timestamp, 1_700_000_100);
  // No quote_amount/sol_amount in this fixture (deliberately, to avoid a
  // network-dependent test) — priceUsdForTrade should short-circuit to
  // null rather than hang or throw.
  assert.equal(normalized.priceUsd, null);
});

test("priceUsdFromSolTrade: real captured trade (0.98765432 SOL for 2775630.378083 tokens) gives a plausible per-token USD price", () => {
  // sol_amount=987654320 lamports, token_amount=2775630378083 (raw, 6
  // decimals) — decoded live from a real mainnet TradeEvent in this
  // session (see this file's real-adapter.ts sibling for the capture).
  const priceUsd = priceUsdFromSolTrade(987_654_320, 2_775_630_378_083, 102.47);
  assert.ok(priceUsd !== null);
  assert.ok(Math.abs(priceUsd! - 0.0000364619651699797) < 1e-12);
  // Sanity check in a more human unit: implied market cap at Pump's
  // standard 1e9 total supply should land in a plausible range for an
  // active bonding curve (a few thousand to tens of thousands of dollars),
  // not something wildly out of range that would indicate a decimals bug.
  const impliedMarketCapUsd = priceUsd! * 1_000_000_000;
  assert.ok(impliedMarketCapUsd > 1_000 && impliedMarketCapUsd < 1_000_000);
});

test("priceUsdFromSolTrade: zero token amount returns null instead of Infinity/NaN", () => {
  assert.equal(priceUsdFromSolTrade(1_000_000_000, 0, 100), null);
});
