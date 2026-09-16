import { NextResponse } from "next/server";
import { buildPonsLaunchTransaction } from "@tli/adapters";

/**
 * Builds a REAL Pons launchAndBuy transaction (to/data/value) — see
 * packages/adapters/src/pons/launch.ts for how every parameter was
 * confirmed against Pons's real, open-source contracts and a real, decoded
 * on-chain transaction.
 *
 * SECURITY: this route never sees, generates, or needs any private key —
 * it returns unsigned transaction parameters for the client's own wallet
 * to sign via eth_sendTransaction.
 *
 * Mainnet only: Pons has no separate testnet deployment documented, same
 * situation as Flap. A real spend ceiling is enforced regardless — the
 * value carries both the (small, fixed) launch fee and the creator's own
 * initial buy, so the ceiling bounds the buy side the same way Pump's and
 * Flap's ceilings bound their initial buys.
 */

const MIN_QUOTE_IN_WEI = 1_000_000_000_000_000n; // 0.001 ETH
const MAX_QUOTE_IN_WEI = 500_000_000_000_000_000n; // 0.5 ETH — mirrors Pump's/Flap's mainnet ceilings for the same reason
const MAX_CREATOR_TAX_BPS = 1000; // the real factory's maxCreatorTaxBps ceiling — anything above this reverts with CreatorTaxTooHigh on-chain regardless, this just fails fast

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { creatorAddress, name, symbol, logoUrl, description, twitterUrl, creatorTaxBps, quoteInWei } = body as Record<string, unknown>;

  if (typeof creatorAddress !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(creatorAddress)) {
    return NextResponse.json({ error: "creatorAddress must be a valid EVM address" }, { status: 400 });
  }
  if (typeof name !== "string" || name.trim().length === 0 || Buffer.byteLength(name, "utf8") > 200) {
    return NextResponse.json({ error: "name must be non-empty and at most 200 UTF-8 bytes" }, { status: 400 });
  }
  if (typeof symbol !== "string" || symbol.trim().length === 0 || Buffer.byteLength(symbol, "utf8") > 32) {
    return NextResponse.json({ error: "symbol must be non-empty and at most 32 UTF-8 bytes" }, { status: 400 });
  }
  if (typeof logoUrl !== "string" || !logoUrl.startsWith("https://")) {
    return NextResponse.json({ error: "logoUrl must be a real https URL (upload the image first via /api/pons/metadata)" }, { status: 400 });
  }
  if (typeof description !== "string") {
    return NextResponse.json({ error: "description must be a string (may be empty)" }, { status: 400 });
  }
  if (typeof twitterUrl !== "string") {
    return NextResponse.json({ error: "twitterUrl must be a string (may be empty)" }, { status: 400 });
  }
  if (typeof creatorTaxBps !== "number" || !Number.isInteger(creatorTaxBps) || creatorTaxBps < 0 || creatorTaxBps > MAX_CREATOR_TAX_BPS) {
    return NextResponse.json({ error: `creatorTaxBps must be an integer between 0 and ${MAX_CREATOR_TAX_BPS}` }, { status: 400 });
  }
  if (typeof quoteInWei !== "string" && typeof quoteInWei !== "number") {
    return NextResponse.json({ error: "quoteInWei is required" }, { status: 400 });
  }

  let quoteIn: bigint;
  try {
    quoteIn = BigInt(quoteInWei as string | number);
  } catch {
    return NextResponse.json({ error: "Malformed quoteInWei" }, { status: 400 });
  }

  if (quoteIn < MIN_QUOTE_IN_WEI || quoteIn > MAX_QUOTE_IN_WEI) {
    return NextResponse.json({ error: `quoteInWei must be between ${MIN_QUOTE_IN_WEI} and ${MAX_QUOTE_IN_WEI}` }, { status: 400 });
  }

  try {
    const built = await buildPonsLaunchTransaction({
      creatorAddress,
      name,
      symbol,
      logoUrl,
      description,
      twitterUrl,
      creatorTaxBps,
      quoteInWei: quoteIn,
    });
    return NextResponse.json(built);
  } catch (err) {
    console.error("[pons/launch-transaction] failed to build transaction:", err);
    return NextResponse.json({ error: "Failed to build launch transaction. See server logs." }, { status: 500 });
  }
}
