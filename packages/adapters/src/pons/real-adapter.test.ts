import { test } from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import {
  PonsAdapter,
  eventKindFor,
  serializeLogArgs,
  graduationFromV1Status,
  graduationFromV2Phase,
} from "./real-adapter.js";
import { PONS_V2_FACTORY_ABI, PONS_V2_CURVE_ABI } from "./abi.js";
import type { RawVenueEvent } from "@tli/core";
import realV2Launches from "./__fixtures__/real-v2-token-launched.json" with { type: "json" };
import realV2CurveTrades from "./__fixtures__/real-v2-curve-trades.json" with { type: "json" };

/**
 * real-v2-token-launched.json holds two GENUINE Robinhood Chain mainnet
 * TokenLaunched logs (real tx hashes, checkable on robinhoodchain.blockscout.com),
 * captured live in this session via eth_getLogs against the V2 factory.
 * The fixture-based test below decodes those exact log bytes through the
 * same ethers Interface construction real-adapter.ts uses, with zero
 * network dependency at test time.
 */

test("eventKindFor: V1 uses TokenDeployed as the launch moment, ignores TokenLaunched to avoid double-counting", () => {
  assert.equal(eventKindFor("pons-v1", "TokenDeployed"), "launch");
  assert.equal(eventKindFor("pons-v1", "TokenLaunched"), "unknown");
  assert.equal(eventKindFor("pons-v1", "SomeOtherEvent"), "unknown");
});

test("eventKindFor: V2 has no separate deploy event, so TokenLaunched IS the launch moment; PoolGraduated is graduation", () => {
  assert.equal(eventKindFor("pons-v2", "TokenLaunched"), "launch");
  assert.equal(eventKindFor("pons-v2", "PoolGraduated"), "graduation");
  assert.equal(eventKindFor("pons-v2", "LaunchConfigAdded"), "unknown");
});

test("graduationFromV1Status: not graduated, zero progress when nothing paired in yet", () => {
  const result = graduationFromV1Status(0n, 1_000_000n, false);
  assert.equal(result.graduationState, "NOT_GRADUATED");
  assert.equal(result.rawProgress, 0);
});

test("graduationFromV1Status: partial progress is GRADUATING", () => {
  const result = graduationFromV1Status(300_000n, 1_000_000n, false);
  assert.equal(result.graduationState, "GRADUATING");
  assert.ok(Math.abs(result.rawProgress - 0.3) < 1e-9);
});

test("graduationFromV1Status: graduated flag wins regardless of computed progress", () => {
  const result = graduationFromV1Status(1_000_000n, 1_000_000n, true);
  assert.equal(result.graduationState, "GRADUATED");
  assert.equal(result.rawProgress, 1);
});

test("graduationFromV2Phase: maps the real GraduationPhase enum ordinals (0=NotGraduated,1=Swept,2=PoolCreated,3=Rescued)", () => {
  assert.equal(graduationFromV2Phase(0).graduationState, "NOT_GRADUATED");
  assert.equal(graduationFromV2Phase(1).graduationState, "GRADUATING");
  assert.equal(graduationFromV2Phase(2).graduationState, "GRADUATED");
  assert.equal(graduationFromV2Phase(3).graduationState, "GRADUATED");
});

test("real captured V2 TokenLaunched logs decode to the expected values via serializeLogArgs", () => {
  const iface = new Interface(PONS_V2_FACTORY_ABI);
  assert.equal(realV2Launches.length, 2, "fixture should hold exactly the 2 captured logs");

  for (const fixture of realV2Launches) {
    const parsed = iface.parseLog({ topics: fixture.topics, data: fixture.data });
    assert.ok(parsed, `expected ${fixture.transactionHash} to decode as a known V2 event`);
    assert.equal(parsed!.name, "TokenLaunched");

    const args = serializeLogArgs(parsed!.fragment.inputs, parsed!.args);
    assert.equal(args["token"], fixture.decoded.token);
    assert.equal(args["curve"], fixture.decoded.curve);
    assert.equal(args["deployer"], fixture.decoded.deployer);
    assert.equal(args["pairToken"], fixture.decoded.pairToken);
    assert.equal(args["launchConfigId"], fixture.decoded.launchConfigId);
    assert.equal(args["graduationThreshold"], fixture.decoded.graduationThreshold);
  }
});

test("real captured V2 TokenLaunched log produces a correct RawVenueEvent shape end to end (excluding the ERC-20 metadata call, which needs network)", () => {
  const iface = new Interface(PONS_V2_FACTORY_ABI);
  const fixture = realV2Launches[0]!;
  const parsed = iface.parseLog({ topics: fixture.topics, data: fixture.data })!;
  const kind = eventKindFor("pons-v2", parsed.name);
  assert.equal(kind, "launch");

  const event: RawVenueEvent = {
    venue: "pons",
    kind,
    txHash: fixture.transactionHash,
    logIndex: fixture.index,
    blockOrSlot: String(fixture.blockNumber),
    observedAtTimestamp: Math.floor(Date.now() / 1000),
    raw: { schemaVersion: "pons-v2", eventName: parsed.name, args: serializeLogArgs(parsed.fragment.inputs, parsed.args) },
  };

  const raw = event.raw as { args: Record<string, unknown> };
  assert.equal(raw.args["token"], fixture.decoded.token);
  assert.equal(raw.args["deployer"], fixture.decoded.deployer);
});

test("real captured V2 CurveBuy logs decode correctly (per-launch curve trades, not factory events)", () => {
  const iface = new Interface(PONS_V2_CURVE_ABI);
  assert.equal(realV2CurveTrades.length, 2, "fixture should hold exactly the 2 captured logs");

  for (const fixture of realV2CurveTrades) {
    const parsed = iface.parseLog({ topics: fixture.topics, data: fixture.data });
    assert.ok(parsed, `expected ${fixture.transactionHash} to decode as CurveBuy/CurveSell`);
    assert.equal(parsed!.name, fixture.decoded.eventName);

    const args = serializeLogArgs(parsed!.fragment.inputs, parsed!.args);
    const isBuy = fixture.decoded.eventName === "CurveBuy";
    assert.equal(args[isBuy ? "buyer" : "seller"], fixture.decoded.wallet);
    assert.equal(args["recipient"], fixture.decoded.recipient);
    assert.equal(args[isBuy ? "tokensOut" : "tokensIn"], fixture.decoded.amount);
  }
});

test("PonsAdapter.normalizeTrade rejects V1 schema versions explicitly rather than silently approximating", async () => {
  const adapter = new PonsAdapter();
  const event: RawVenueEvent = {
    venue: "pons",
    kind: "trade",
    txHash: "0xtest",
    logIndex: 0,
    blockOrSlot: "123",
    observedAtTimestamp: Math.floor(Date.now() / 1000),
    raw: { schemaVersion: "pons-v1", eventName: "SomePoolSwap", args: {} },
  };
  await assert.rejects(() => adapter.normalizeTrade(event), /no trade decoding for schemaVersion "pons-v1"/);
});

test("PonsAdapter can be constructed without hitting the network", () => {
  const adapter = new PonsAdapter();
  assert.equal(adapter.venue, "pons");
});
