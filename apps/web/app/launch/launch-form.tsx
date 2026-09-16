"use client";

import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Keypair, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { useSolanaNetwork } from "../providers/wallet-provider";

const MAX_SOL_BY_NETWORK = { devnet: 5, "mainnet-beta": 0.5 } as const; // mirrors the server-side ceiling in app/api/pump/launch-transaction/route.ts — client-side copy is UX-only, the server enforces the real limit

// Pump.fun writes name/symbol into a real Metaplex Token Metadata account
// (via createV2's CPI), and that program hard-enforces MAX_NAME_LENGTH=32
// and MAX_SYMBOL_LENGTH=10 as UTF-8 BYTE counts, not character counts — a
// real on-chain constraint, not this app's choice. A JS-length-based
// maxLength (the old approach) undercounts for CJK text, since each
// Chinese/Japanese/Korean character is 3 bytes in UTF-8: it let a creator
// type e.g. 20 Chinese characters (well under a 32-char limit) that would
// actually be 60 bytes and fail on-chain. These are byte limits so CJK
// names size correctly — about 10 CJK characters fit in 32 bytes.
const PUMP_NAME_MAX_BYTES = 32;
const PUMP_SYMBOL_MAX_BYTES = 10;

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Trims from the end (respecting surrogate pairs, so multi-byte characters like CJK or emoji are never split mid-character) until the string fits within maxBytes of UTF-8. */
function truncateToUtf8Bytes(s: string, maxBytes: number): string {
  if (utf8ByteLength(s) <= maxBytes) return s;
  const chars = [...s];
  while (chars.length > 0 && utf8ByteLength(chars.join("")) > maxBytes) chars.pop();
  return chars.join("");
}

/**
 * Real Pump.fun coin launch — devnet or mainnet, see
 * app/providers/wallet-provider.tsx for the network-switching design
 * (defaults to devnet every page load; mainnet needs an explicit choice
 * each session, never persisted).
 *
 * Flow, and why each step is where it is:
 *  1. Upload image+metadata to Pump.fun's real IPFS endpoint (server-side
 *     proxy, /api/pump/metadata) — needs a real hosted URI before the
 *     on-chain transaction can reference it.
 *  2. Generate a fresh mint Keypair HERE, client-side, in the browser.
 *     Its secret key never leaves this component — not sent to the
 *     server, not logged, not stored. It only exists to co-sign the one
 *     transaction that creates this specific mint account.
 *  3. Ask the server to build the actual instructions
 *     (/api/pump/launch-transaction) — needs @tli/adapters' pump-sdk
 *     integration, which only runs in Node, not a browser bundle.
 *  4. Sign with the mint keypair locally, then hand the transaction to
 *     the connected wallet (Phantom etc.) via wallet-adapter's
 *     sendTransaction — THAT is where the creator's own wallet signs and
 *     the transaction actually gets submitted. This app never signs
 *     anything with the creator's key; it can't, it never has it.
 *
 * MAINNET SAFETY, specific to this file: an explicit "I understand this
 * is real money" checkbox gates the submit button (separate from, and in
 * addition to, the wallet's own signature prompt — belt and suspenders,
 * since the wallet popup is easy to click through on autopilot after
 * enough devnet testing). The real per-transaction spend ceiling lives
 * server-side (launch-transaction/route.ts); the client-side max here is
 * just an earlier, friendlier error message for the same limit.
 */
export function LaunchForm() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected, disconnect } = useWallet();
  const { network, setNetwork } = useSolanaNetwork();
  const isMainnet = network === "mainnet-beta";

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [solAmount, setSolAmount] = useState("0.01");
  const [mainnetConfirmed, setMainnetConfirmed] = useState(false);
  const [walletBalanceSol, setWalletBalanceSol] = useState<number | null>(null);

  const [status, setStatus] = useState<"idle" | "uploading-metadata" | "building-transaction" | "awaiting-signature" | "submitting" | "done" | "error">("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [resultSignature, setResultSignature] = useState<string | null>(null);
  const [resultMint, setResultMint] = useState<string | null>(null);
  const [recordedInApp, setRecordedInApp] = useState<boolean | null>(null); // null = still trying / not attempted yet

  useEffect(() => {
    setMainnetConfirmed(false);
    setWalletBalanceSol(null);
  }, [network, publicKey]);

  useEffect(() => {
    if (!publicKey) return;
    let cancelled = false;
    connection
      .getBalance(publicKey)
      .then((lamports) => {
        if (!cancelled) setWalletBalanceSol(lamports / LAMPORTS_PER_SOL);
      })
      .catch(() => {
        if (!cancelled) setWalletBalanceSol(null);
      });
    return () => {
      cancelled = true;
    };
  }, [connection, publicKey, status]);

  const solLamports = (() => {
    const parsed = Number(solAmount);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    if (parsed > MAX_SOL_BY_NETWORK[network]) return null;
    return BigInt(Math.round(parsed * LAMPORTS_PER_SOL));
  })();

  const insufficientBalance = walletBalanceSol !== null && solLamports !== null && walletBalanceSol < Number(solAmount) + 0.01; // +0.01 SOL rough fee/rent buffer, not exact

  const canSubmit =
    connected &&
    publicKey !== null &&
    name.trim().length > 0 &&
    symbol.trim().length > 0 &&
    imageFile !== null &&
    solLamports !== null &&
    !insufficientBalance &&
    (!isMainnet || mainnetConfirmed) &&
    status === "idle";

  function handleNetworkSwitch(next: "devnet" | "mainnet-beta") {
    if (next === network) return;
    void disconnect().catch(() => {}); // force a fresh, explicit reconnect on the new network rather than carrying over a connection from the old one
    setNetwork(next);
    setStatus("idle");
    setStatusMessage(null);
    setResultSignature(null);
    setResultMint(null);
    setRecordedInApp(null);
  }

  async function handleLaunch() {
    if (!publicKey || !imageFile || solLamports === null) return;

    try {
      setStatus("uploading-metadata");
      setStatusMessage("Uploading image + metadata to Pump.fun's real IPFS endpoint...");
      const metadataForm = new FormData();
      metadataForm.append("file", imageFile);
      metadataForm.append("name", name);
      metadataForm.append("symbol", symbol);
      metadataForm.append("description", description);
      const metadataRes = await fetch("/api/pump/metadata", { method: "POST", body: metadataForm });
      const metadataJson = await metadataRes.json();
      if (!metadataRes.ok) throw new Error(metadataJson.error ?? "Metadata upload failed");
      const uri: string = metadataJson.metadataUri;

      setStatus("building-transaction");
      setStatusMessage("Generating mint keypair and building the real launch transaction...");
      const mintKeypair = Keypair.generate();
      const txRes = await fetch("/api/pump/launch-transaction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletPubkey: publicKey.toBase58(),
          mintPubkey: mintKeypair.publicKey.toBase58(),
          name,
          symbol,
          uri,
          solAmountLamports: solLamports.toString(),
          network,
        }),
      });
      const txJson = await txRes.json();
      if (!txRes.ok) throw new Error(txJson.error ?? "Failed to build launch transaction");

      const transaction = Transaction.from(Buffer.from(txJson.transactionBase64, "base64"));
      transaction.partialSign(mintKeypair); // co-signs as the new mint account — never touches the server

      setStatus("awaiting-signature");
      setStatusMessage(
        `Approve in your wallet — this will spend ${solAmount} SOL (${isMainnet ? "MAINNET, real money" : "devnet"}) and create ${name} (${symbol}).`,
      );

      setStatus("submitting");
      const signature = await sendTransaction(transaction, connection);
      setStatusMessage("Submitted — waiting for confirmation...");

      const latestBlockhash = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature, ...latestBlockhash }, "confirmed");

      setResultSignature(signature);
      setResultMint(mintKeypair.publicKey.toBase58());
      setStatus("done");
      setStatusMessage(null);

      // Best-effort: write this launch into the app's own database so it
      // shows up on Market/Token pages. The on-chain launch already fully
      // succeeded above regardless of whether this write succeeds — a
      // failure here shouldn't be shown as if the launch itself failed.
      try {
        const confirmedTx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
        const recordRes = await fetch("/api/pump/record-launch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mintAddress: mintKeypair.publicKey.toBase58(),
            name,
            symbol,
            creatorAddress: publicKey.toBase58(),
            launchTxHash: signature,
            slot: confirmedTx?.slot ?? 0,
            launchTimestamp: confirmedTx?.blockTime ?? Math.floor(Date.now() / 1000),
            network,
          }),
        });
        setRecordedInApp(recordRes.ok);
      } catch {
        setRecordedInApp(false);
      }
    } catch (err) {
      setStatus("error");
      setStatusMessage(err instanceof Error ? err.message : "Launch failed");
    }
  }

  return (
    <div style={{ maxWidth: 480 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <NetworkButton label="Devnet · test money" active={!isMainnet} onClick={() => handleNetworkSwitch("devnet")} />
        <NetworkButton label="Mainnet · real money" active={isMainnet} danger onClick={() => handleNetworkSwitch("mainnet-beta")} />
      </div>

      {isMainnet && (
        <div className="warn-banner" style={{ marginBottom: 16, fontWeight: 600 }}>
          MAINNET SELECTED — this spends real SOL from your real wallet. Transactions on Solana cannot be reversed or
          refunded. Make sure your wallet is actually set to Mainnet, not Devnet, before connecting.
        </div>
      )}

      <div style={{ marginBottom: 16 }}>
        <WalletMultiButton />
      </div>

      {!connected && (
        <p style={{ color: "var(--paper-2)", fontSize: 13 }}>
          Connect a Solana wallet (set to {isMainnet ? "Mainnet" : "Devnet"}) to launch a coin.
        </p>
      )}
      {connected && walletBalanceSol !== null && (
        <p className="num" style={{ color: "var(--paper-2)", fontSize: 13 }}>
          Wallet balance: {walletBalanceSol.toFixed(4)} SOL
        </p>
      )}

      <div className="field">
        <label className="field-label">
          Name ({PUMP_NAME_MAX_BYTES} bytes max, on-chain limit — ~{Math.floor(PUMP_NAME_MAX_BYTES / 3)} Chinese/Japanese/Korean characters)
        </label>
        <input
          className="field-input"
          value={name}
          onChange={(e) => setName(truncateToUtf8Bytes(e.target.value, PUMP_NAME_MAX_BYTES))}
          placeholder="My Coin / 我的代币"
        />
        <p className="footnote" style={{ marginTop: 4, paddingTop: 0, borderTop: "none" }}>
          {utf8ByteLength(name)}/{PUMP_NAME_MAX_BYTES} bytes — CJK characters use 3 bytes each on Pump&apos;s on-chain metadata
        </p>
      </div>
      <div className="field">
        <label className="field-label">Symbol ({PUMP_SYMBOL_MAX_BYTES} bytes max, on-chain limit)</label>
        <input
          className="field-input"
          value={symbol}
          onChange={(e) => setSymbol(truncateToUtf8Bytes(e.target.value.toUpperCase(), PUMP_SYMBOL_MAX_BYTES))}
          placeholder="MYCOIN"
        />
        <p className="footnote" style={{ marginTop: 4, paddingTop: 0, borderTop: "none" }}>
          {utf8ByteLength(symbol)}/{PUMP_SYMBOL_MAX_BYTES} bytes
        </p>
      </div>
      <div className="field">
        <label className="field-label">Description</label>
        <textarea className="field-input" value={description} onChange={(e) => setDescription(e.target.value)} style={{ minHeight: 64, resize: "vertical" }} />
      </div>
      <div className="field">
        <label className="field-label">Image</label>
        <input type="file" accept="image/*" onChange={(e) => setImageFile(e.target.files?.[0] ?? null)} />
      </div>
      <div className="field">
        <label className="field-label">
          Initial buy (SOL, max {MAX_SOL_BY_NETWORK[network]} on {network})
        </label>
        <input className="field-input num" value={solAmount} onChange={(e) => setSolAmount(e.target.value)} />
      </div>
      {insufficientBalance && (
        <p style={{ color: "var(--red-0)", fontSize: 12, marginTop: -8, marginBottom: 12 }}>
          Wallet balance looks too low to cover this amount plus network fees.
        </p>
      )}

      {isMainnet && (
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12, color: "var(--red-0)", marginBottom: 14, lineHeight: 1.5 }}>
          <input type="checkbox" checked={mainnetConfirmed} onChange={(e) => setMainnetConfirmed(e.target.checked)} style={{ marginTop: 2 }} />
          <span>I understand this launches a real coin on Solana mainnet using real SOL, and that this cannot be undone.</span>
        </label>
      )}

      <button onClick={handleLaunch} disabled={!canSubmit} className={`btn ${isMainnet ? "btn-danger" : "btn-primary"}`} style={{ width: "100%" }}>
        {status === "idle" ? `Launch on ${isMainnet ? "Mainnet" : "Devnet"}` : "Working…"}
      </button>

      {statusMessage && <p style={{ color: "var(--paper-2)", fontSize: 13, marginTop: 14 }}>{statusMessage}</p>}

      {status === "error" && <p style={{ color: "var(--red-0)", fontSize: 13, marginTop: 14 }}>Failed: {statusMessage}</p>}

      {status === "done" && resultSignature && resultMint && (
        <div className="panel fade-up" style={{ marginTop: 16 }}>
          <div className="panel-body">
            <p style={{ margin: 0, color: "var(--green-0)", fontWeight: 700 }}>Launched — finalized on {network}.</p>
            <p style={{ margin: "8px 0 0", fontSize: 12, wordBreak: "break-all", color: "var(--paper-1)" }}>Mint: {resultMint}</p>
            <p style={{ margin: "8px 0 0", fontSize: 13 }}>
              <a
                href={`https://explorer.solana.com/tx/${resultSignature}${isMainnet ? "" : "?cluster=devnet"}`}
                target="_blank"
                rel="noreferrer"
                className="addr-link"
              >
                View transaction on Solana Explorer →
              </a>
            </p>
            {recordedInApp === null && <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--paper-3)" }}>Recording this launch in the app…</p>}
            {recordedInApp === true && (
              <p style={{ margin: "8px 0 0", fontSize: 13 }}>
                <a href={`/token/${isMainnet ? "solana" : "solana-devnet"}/${resultMint}`} className="addr-link">
                  View on this app&apos;s Token page →
                </a>
              </p>
            )}
            {recordedInApp === false && (
              <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--paper-3)" }}>
                The launch itself succeeded on-chain, but recording it in this app&apos;s own database failed — it
                won&apos;t show up on the Market/Token pages. Not a sign anything on-chain went wrong.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function NetworkButton({ label, active, onClick, danger }: { label: string; active: boolean; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className="tab"
      style={{
        flex: 1,
        border: `1px solid ${active ? (danger ? "var(--red-1)" : "var(--amber-2)") : "var(--line)"}`,
        background: active ? (danger ? "rgba(230,72,58,0.12)" : "rgba(255,157,61,0.1)") : "var(--ink-1)",
        color: active ? (danger ? "var(--red-0)" : "var(--amber-0)") : "var(--paper-2)",
        fontWeight: active ? 700 : 500,
      }}
    >
      {label}
    </button>
  );
}
