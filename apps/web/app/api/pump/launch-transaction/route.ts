import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { buildLaunchTransaction } from "@tli/adapters";

/**
 * Builds a REAL, unsigned Pump.fun createV2AndBuy transaction and returns
 * it base64-serialized — server-side, so it can use the project's
 * existing @tli/adapters pump-sdk integration (which needs the Node CJS
 * `require` workaround documented in pump/real-adapter.ts's header, not
 * something that works in a browser bundle).
 *
 * SECURITY: this route never sees, generates, or needs any private key.
 * `walletPubkey` and `mintPubkey` are both public keys the client already
 * has (the connected wallet's address, and a fresh Keypair the client
 * generated itself — see app/launch/page.tsx). Signing happens entirely
 * client-side after this route returns.
 *
 * Devnet-only for now, deliberately — see app/providers/wallet-provider.tsx.
 * SOLANA_RPC_URL, if set, still must point at devnet; there is no
 * client-supplied network parameter that could redirect this at mainnet.
 */

const DEVNET_RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

const MIN_SOL_AMOUNT_LAMPORTS = 1_000_000n; // 0.001 SOL — enough to seed the curve with a real, non-dust buy, not a magic number a creator would hit by typo
const MAX_SOL_AMOUNT_LAMPORTS = 5_000_000_000n; // 5 SOL — devnet-appropriate ceiling; well above real devnet faucet limits, so a typo can't produce a transaction asking for absurd amounts

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
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 32) {
    return NextResponse.json({ error: "name must be a non-empty string up to 32 characters" }, { status: 400 });
  }
  if (typeof symbol !== "string" || symbol.trim().length === 0 || symbol.length > 10) {
    return NextResponse.json({ error: "symbol must be a non-empty string up to 10 characters" }, { status: 400 });
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
    const connection = new Connection(DEVNET_RPC_URL, "confirmed");
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
