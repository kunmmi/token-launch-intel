import { createRequire } from "node:module";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import BN from "bn.js";

/**
 * Real Pump.fun coin-creation transaction builder — the counterpart to
 * real-adapter.ts's read-only observation methods, this is the first
 * WRITE capability in the project (M1: a creator launching a real coin
 * from this app, not just watching launches happen elsewhere).
 *
 * Verified live on Solana devnet before this file was written, not
 * assumed to work from reading the SDK's types: the real Pump.fun program
 * (6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P) and its Global config
 * account are genuinely deployed and initialized on devnet (checked via a
 * raw getAccountInfo call, not just "the address responds"). A throwaway
 * devnet wallet then ran this exact instruction-building path end-to-end
 * — createV2AndBuyInstructions → sign with wallet + fresh mint keypair →
 * sendRawTransaction — and produced a real, finalized on-chain mint with
 * the expected name/symbol/6-decimals/1e9-supply, confirmed via a
 * follow-up getAccountInfo on the new mint address.
 *
 * SECURITY DESIGN, non-negotiable: this module builds an UNSIGNED
 * transaction and returns it to the caller. It never holds, generates
 * server-side, or transmits any private key — not the creator's wallet
 * key (obviously), and not even the fresh, otherwise-worthless mint
 * keypair a real launch needs to co-sign with (that's generated
 * client-side in the browser and never leaves it — see apps/web's launch
 * page). This file's only job is building the instructions; signing and
 * submission happen entirely on the client, through the creator's own
 * connected wallet.
 */

const pumpSdkRequire = createRequire(import.meta.url);
const pumpSdk = pumpSdkRequire("@pump-fun/pump-sdk") as typeof import("@pump-fun/pump-sdk");
const { PumpSdk, OnlinePumpSdk, getBuyTokenAmountFromSolAmount } = pumpSdk;

/** The Solana System Program address, reused by Pump as the "native SOL, not a real SPL mint" sentinel for quoteMint — same constant verified live for TradeEvent.quote_mint in real-adapter.ts. This project only ever launches SOL-quoted coins; a quote-token launch flow is a different, unbuilt feature. */
const NATIVE_SOL_QUOTE_MINT = new PublicKey("11111111111111111111111111111111");

export interface BuildLaunchTransactionParams {
  connection: Connection;
  /** The creator's wallet — becomes both the transaction fee payer and the coin's creator/first buyer. Never a private key, always a public key from the connected wallet. */
  walletPubkey: PublicKey;
  /** A fresh, throwaway keypair's PUBLIC key only, generated client-side — see this file's header. */
  mintPubkey: PublicKey;
  name: string;
  symbol: string;
  /** Metadata URI (image + name + symbol + description), already uploaded — see apps/web's metadata upload route. Not validated on-chain; garbage in, garbage shown, same as the real pump.fun frontend. */
  uri: string;
  /** Initial buy size, in lamports. Real pump.fun launches conventionally seed the curve with a real buy; this project doesn't force a minimum, but the caller (the launch page) should sanity-check it isn't zero or dust. */
  solAmountLamports: bigint;
}

export interface BuiltLaunchTransaction {
  /** Unsigned — feePayer and recentBlockhash are set, but nothing has signed it yet. */
  transaction: Transaction;
  /** The exact token amount the creator will receive for solAmountLamports, computed against the real, current bonding-curve constants (not a guess/estimate) — shown to the creator before they sign. */
  estimatedTokenAmountRaw: string;
}

/**
 * Builds the real createV2AndBuyInstructions call (Pump's current,
 * non-deprecated create path) against whatever `connection` points at —
 * devnet or mainnet-beta, the caller decides, this function doesn't care.
 */
export async function buildLaunchTransaction(params: BuildLaunchTransactionParams): Promise<BuiltLaunchTransaction> {
  const { connection, walletPubkey, mintPubkey, name, symbol, uri, solAmountLamports } = params;

  const onlineSdk = new OnlinePumpSdk(connection);
  const global = await onlineSdk.fetchGlobal();
  const offlineSdk = new PumpSdk();

  const solAmount = new BN(solAmountLamports.toString());
  const tokenAmount = getBuyTokenAmountFromSolAmount({
    global,
    feeConfig: null,
    mintSupply: null,
    bondingCurve: null, // fresh curve — no existing on-chain state to read yet, this coin doesn't exist
    amount: solAmount,
    quoteMint: NATIVE_SOL_QUOTE_MINT,
    quoteControl: null,
  });

  const instructions = await offlineSdk.createV2AndBuyInstructions({
    global,
    mint: mintPubkey,
    name,
    symbol,
    uri,
    creator: walletPubkey,
    user: walletPubkey,
    amount: tokenAmount,
    solAmount,
    mayhemMode: false,
  });

  const transaction = new Transaction().add(...instructions);
  transaction.feePayer = walletPubkey;
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;

  return { transaction, estimatedTokenAmountRaw: tokenAmount.toString() };
}
