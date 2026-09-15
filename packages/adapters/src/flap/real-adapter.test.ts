import { test } from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { FlapAdapter, eventKindFor, serializeLogArgs, graduationFromTokenState, priceUsdFromBnbTrade } from "./real-adapter.js";
import { FLAP_PORTAL_ABI, TOKEN_STATUS } from "./abi.js";
import type { RawVenueEvent } from "@tli/core";
import realTokenCreated from "./__fixtures__/real-token-created.json" with { type: "json" };

/**
 * real-token-created.json holds two GENUINE BNB Chain mainnet TokenCreated
 * logs (real tx hashes, checkable on bscscan.com), captured live via
 * eth_getLogs against the real Portal contract in this session. The
 * fixture-based test below decodes those exact log bytes through the same
 * ethers Interface construction real-adapter.ts uses, with zero network
 * dependency at test time.
 */

test("eventKindFor maps Portal events to RawVenueEvent kinds", () => {
  assert.equal(eventKindFor("TokenCreated"), "launch");
  assert.equal(eventKindFor("TokenBought"), "trade");
  assert.equal(eventKindFor("TokenSold"), "trade");
  assert.equal(eventKindFor("LaunchedToDEX"), "graduation");
  assert.equal(eventKindFor("SomeOtherEvent"), "unknown");
});

test("graduationFromTokenState: DEX status means graduated regardless of progress field", () => {
  const result = graduationFromTokenState(TOKEN_STATUS.DEX, 500_000_000_000_000_000n);
  assert.equal(result.graduationState, "GRADUATED");
  assert.equal(result.rawProgress, 1);
});

test("graduationFromTokenState: Tradable status with zero progress is NOT_GRADUATED", () => {
  const result = graduationFromTokenState(TOKEN_STATUS.Tradable, 0n);
  assert.equal(result.graduationState, "NOT_GRADUATED");
  assert.equal(result.rawProgress, 0);
});

test("graduationFromTokenState: Tradable status with partial progress is GRADUATING, correctly scaled from Wad", () => {
  // 1e18 = 100%, so 250000000000000000 (2.5e17) = 25%
  const result = graduationFromTokenState(TOKEN_STATUS.Tradable, 250_000_000_000_000_000n);
  assert.equal(result.graduationState, "GRADUATING");
  assert.ok(Math.abs(result.rawProgress - 0.25) < 1e-9, `expected ~0.25, got ${result.rawProgress}`);
});

test("real captured BNB Chain TokenCreated logs decode to the expected values via serializeLogArgs", () => {
  const iface = new Interface(FLAP_PORTAL_ABI);
  assert.equal(realTokenCreated.length, 2, "fixture should hold exactly the 2 captured logs");

  for (const fixture of realTokenCreated) {
    const parsed = iface.parseLog({ topics: fixture.topics, data: fixture.data });
    assert.ok(parsed, `expected ${fixture.transactionHash} to decode as TokenCreated`);
    assert.equal(parsed!.name, "TokenCreated");

    const args = serializeLogArgs(parsed!.fragment.inputs, parsed!.args);
    assert.equal(args["ts"], fixture.decoded.ts);
    assert.equal(args["creator"], fixture.decoded.creator);
    assert.equal(args["nonce"], fixture.decoded.nonce);
    assert.equal(args["token"], fixture.decoded.token);
    assert.equal(args["name"], fixture.decoded.name);
    assert.equal(args["symbol"], fixture.decoded.symbol);
    assert.equal(args["meta"], fixture.decoded.meta);
  }
});

test("real captured TokenCreated log normalizes end to end via FlapAdapter.normalizeLaunch (no follow-up RPC needed, unlike Pump/Pons)", async () => {
  const adapter = new FlapAdapter();
  const iface = new Interface(FLAP_PORTAL_ABI);
  const fixture = realTokenCreated[0]!;
  const parsed = iface.parseLog({ topics: fixture.topics, data: fixture.data })!;

  const event: RawVenueEvent = {
    venue: "flap",
    kind: "launch",
    txHash: fixture.transactionHash,
    logIndex: fixture.index,
    blockOrSlot: String(fixture.blockNumber),
    observedAtTimestamp: Math.floor(Date.now() / 1000),
    raw: { eventName: parsed.name, args: serializeLogArgs(parsed.fragment.inputs, parsed.args) },
  };

  const normalized = await adapter.normalizeLaunch(event);
  assert.equal(normalized.tokenAddress, fixture.decoded.token);
  assert.equal(normalized.tokenName, fixture.decoded.name);
  assert.equal(normalized.tokenTicker, fixture.decoded.symbol);
  assert.equal(normalized.creatorAddress, fixture.decoded.creator);
  assert.equal(normalized.launchTimestamp, Number(fixture.decoded.ts));
  assert.equal(normalized.launchTxHash, fixture.transactionHash);
});

test("FlapAdapter can be constructed without hitting the network", () => {
  const adapter = new FlapAdapter();
  assert.equal(adapter.venue, "flap");
});

test("priceUsdFromBnbTrade: 0.5 BNB for 10000 tokens (18 decimals) at a real BNB/USD price gives a plausible per-token USD price", () => {
  const bnbAmountWei = 0.5 * 1e18;
  const tokenAmountRaw = 10_000 * 1e18; // 18 decimals, verified live via a real Flap token's decimals() call
  const priceUsd = priceUsdFromBnbTrade(bnbAmountWei, tokenAmountRaw, 719.26);
  assert.ok(priceUsd !== null);
  assert.ok(Math.abs(priceUsd! - (0.5 * 719.26) / 10_000) < 1e-9);
});

test("priceUsdFromBnbTrade: zero token amount returns null instead of Infinity/NaN", () => {
  assert.equal(priceUsdFromBnbTrade(1e18, 0, 700), null);
});
