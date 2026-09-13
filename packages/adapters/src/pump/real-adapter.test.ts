import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { PumpAdapter, eventKindFor, serializeEventData, graduationFromReserves } from "./real-adapter.js";
import type { RawVenueEvent } from "@tli/core";

/**
 * IMPORTANT — what these tests do and don't cover:
 *
 * This session confirmed interactively (see real-adapter.ts header comment)
 * that @coral-xyz/anchor's EventParser + BorshCoder correctly instantiate
 * against the real pumpIdl and that the SDK's fetchBondingCurve/fetchGlobal
 * decode real mainnet accounts. Reproducing that as a committed automated
 * fixture requires a captured real transaction's log lines, which this
 * session could not obtain: public mainnet RPC rate-limited getTransaction
 * calls to roughly 1/sec, and scanning enough recent pump.fun transactions
 * to find a CreateEvent within that budget didn't complete (see the
 * reconcile() doc comment for the same empirical finding). That's a real
 * gap, not swept under the rug — recommended follow-up is capturing one
 * real transaction's logMessages via a proper (non-free-tier) RPC key and
 * committing it as a fixture.
 *
 * What IS tested here, with no network dependency: every pure transform
 * this adapter owns — event-kind classification, event-data serialization
 * for jsonb storage, the launch/trade normalization mapping, and the
 * graduation-progress math derived from BondingCurve/Global fields.
 */

test("eventKindFor maps known Anchor event names to RawVenueEvent kinds", () => {
  assert.equal(eventKindFor("createEvent"), "launch");
  assert.equal(eventKindFor("tradeEvent"), "trade");
  assert.equal(eventKindFor("completeEvent"), "graduation");
  assert.equal(eventKindFor("someFutureEvent"), "unknown");
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
      eventName: "createEvent",
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
      eventName: "tradeEvent",
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
});
