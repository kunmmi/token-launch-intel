import { NextResponse } from "next/server";
import { buildFlapLaunchTransaction } from "@tli/adapters";

/**
 * Builds a REAL Flap newTokenV6 transaction (to/data/value) — see
 * packages/adapters/src/flap/launch.ts for the full story of how every
 * parameter and the vanity-address salt-mining were verified against
 * real on-chain data and a real BscScan-sourced verified contract source,
 * not guessed.
 *
 * SECURITY: this route never sees, generates, or needs any private key —
 * it returns unsigned transaction parameters for the client's own wallet
 * (MetaMask etc.) to sign via eth_sendTransaction.
 *
 * Mainnet only for now: Flap's contracts were verified against BNB Chain
 * MAINNET specifically (the real launches decoded, the real BscScan
 * verified source, the real vanity-suffix confirmation all came from
 * mainnet) — none of that has been separately verified against BNB
 * testnet, so this route doesn't claim testnet support it hasn't earned.
 * A real spend ceiling is enforced regardless, the same principle as
 * Pump's mainnet ceiling: real money, real guard against a typo.
 */

const MIN_BNB_AMOUNT_WEI = 1_000_000_000_000_000n; // 0.001 BNB
const MAX_BNB_AMOUNT_WEI = 500_000_000_000_000_000n; // 0.5 BNB — mirrors Pump's mainnet ceiling for the same reason

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { creatorAddress, name, symbol, metaCid, bnbAmountWei } = body as Record<string, unknown>;

  if (typeof creatorAddress !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(creatorAddress)) {
    return NextResponse.json({ error: "creatorAddress must be a valid EVM address" }, { status: 400 });
  }
  // Flap's newTokenV6 takes name/symbol as plain Solidity `string` — no
  // hard on-chain byte-length check was found in Portal's verified source
  // (see packages/adapters/src/flap/launch.ts's header), so these ceilings
  // are a generous UI guard, not a real protocol limit. Byte-based (not JS
  // .length) so long Chinese/Japanese/Korean names actually fit.
  if (typeof name !== "string" || name.trim().length === 0 || Buffer.byteLength(name, "utf8") > 200) {
    return NextResponse.json({ error: "name must be non-empty and at most 200 UTF-8 bytes" }, { status: 400 });
  }
  if (typeof symbol !== "string" || symbol.trim().length === 0 || Buffer.byteLength(symbol, "utf8") > 32) {
    return NextResponse.json({ error: "symbol must be non-empty and at most 32 UTF-8 bytes" }, { status: 400 });
  }
  if (typeof metaCid !== "string" || metaCid.trim().length === 0) {
    return NextResponse.json({ error: "metaCid is required (upload metadata first via /api/flap/metadata)" }, { status: 400 });
  }
  if (typeof bnbAmountWei !== "string" && typeof bnbAmountWei !== "number") {
    return NextResponse.json({ error: "bnbAmountWei is required" }, { status: 400 });
  }

  let wei: bigint;
  try {
    wei = BigInt(bnbAmountWei as string | number);
  } catch {
    return NextResponse.json({ error: "Malformed bnbAmountWei" }, { status: 400 });
  }

  if (wei < MIN_BNB_AMOUNT_WEI || wei > MAX_BNB_AMOUNT_WEI) {
    return NextResponse.json({ error: `bnbAmountWei must be between ${MIN_BNB_AMOUNT_WEI} and ${MAX_BNB_AMOUNT_WEI}` }, { status: 400 });
  }

  try {
    const built = buildFlapLaunchTransaction({ creatorAddress, name, symbol, metaCid, bnbAmountWei: wei });
    return NextResponse.json(built);
  } catch (err) {
    console.error("[flap/launch-transaction] failed to build transaction:", err);
    return NextResponse.json({ error: "Failed to build launch transaction. See server logs." }, { status: 500 });
  }
}
