import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { buildLaunchTransaction } from "@tli/adapters";

/**
 * Builds a REAL, unsigned Pump.fun createV2AndBuy transaction and returns
 * it base64-serialized — server-side, so it can use the project's
 * existing @tli/adapters pump-sdk integration (which needs the static
 * bundled-import workaround documented in pump/real-adapter.ts's header,
 * not something that works in a browser bundle).
 *
 * SECURITY: this route never sees, generates, or needs any private key.
 * `walletPubkey` and `mintPubkey` are both public keys the client already
 * has (the connected wallet's address, and a fresh Keypair the client
 * generated itself — see app/launch/launch-form.tsx). Signing happens
 * entirely client-side after this route returns.
 *
 * Mainnet only, at the user's explicit request — the earlier Devnet path
 * was removed entirely, not just hidden from the UI.
 * MAX_SOL_AMOUNT_LAMPORTS is a real guard against a typo (an extra zero)
 * turning into a real, irreversible loss, not just malformed-input
 * protection.
 */

const MAINNET_RPC_URL = process.env.SOLANA_MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";

const MIN_SOL_AMOUNT_LAMPORTS = 1_000_000n; // 0.001 SOL — enough to seed the curve with a real, non-dust buy, not a magic number a creator would hit by typo
const MAX_SOL_AMOUNT_LAMPORTS = 500_000_000n; // 0.5 SOL — real money; a real guard against a typo, not just malformed input. Raise deliberately if a real creator genuinely needs more, never as a default.

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { walletPubkey, mintPubkey, name, symbol, uri, solAmountLamports } = body as Record<string, unknown>;

  if (typeof walletPubkey !== "string" || typeof mintPubkey !== "string") {
    return NextResponse.json({ error: "walletPubkey and mintPubkey are required strings" }, { status: 400 });
  }
  // Pump.fun's create instruction CPIs into the real Metaplex Token
  // Metadata program, which hard-enforces MAX_NAME_LENGTH=32 and
  // MAX_SYMBOL_LENGTH=10 as UTF-8 BYTE counts on-chain — validating by JS
  // .length (UTF-16 code units) would wrongly pass CJK names that are
  // actually over the real byte limit and would fail on submission.
  if (typeof name !== "string" || name.trim().length === 0 || Buffer.byteLength(name, "utf8") > 32) {
    return NextResponse.json({ error: "name must be non-empty and at most 32 UTF-8 bytes (Pump's on-chain metadata limit; ~10 CJK characters)" }, { status: 400 });
  }
  if (typeof symbol !== "string" || symbol.trim().length === 0 || Buffer.byteLength(symbol, "utf8") > 10) {
    return NextResponse.json({ error: "symbol must be non-empty and at most 10 UTF-8 bytes (Pump's on-chain metadata limit)" }, { status: 400 });
  }
  if (typeof uri !== "string" || !uri.startsWith("https://")) {
    return NextResponse.json({ error: "uri must be a real https URL (upload metadata first via /api/pump/metadata)" }, { status: 400 });
  }
  if (typeof solAmountLamports !== "string" && typeof solAmountLamports !== "number") {
    return NextResponse.json({ error: "solAmountLamports is required" }, { status: 400 });
  }

  let lamports: bigint;
  let walletKey: PublicKey;
  let mintKey: PublicKey;
  try {
    lamports = BigInt(solAmountLamports as string | number);
    walletKey = new PublicKey(walletPubkey);
    mintKey = new PublicKey(mintPubkey);
  } catch {
    return NextResponse.json({ error: "Malformed walletPubkey, mintPubkey, or solAmountLamports" }, { status: 400 });
  }

  if (lamports < MIN_SOL_AMOUNT_LAMPORTS || lamports > MAX_SOL_AMOUNT_LAMPORTS) {
    return NextResponse.json(
      { error: `solAmountLamports must be between ${MIN_SOL_AMOUNT_LAMPORTS} and ${MAX_SOL_AMOUNT_LAMPORTS}` },
      { status: 400 },
    );
  }

  try {
    const connection = new Connection(MAINNET_RPC_URL, "confirmed");
    const { transaction, estimatedTokenAmountRaw } = await buildLaunchTransaction({
      connection,
      walletPubkey: walletKey,
      mintPubkey: mintKey,
      name,
      symbol,
      uri,
      solAmountLamports: lamports,
    });

    const serialized = transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    return NextResponse.json({ transactionBase64: serialized, estimatedTokenAmountRaw });
  } catch (err) {
    console.error("[launch-transaction] failed to build transaction:", err);
    return NextResponse.json({ error: "Failed to build launch transaction. See server logs." }, { status: 500 });
  }
}
