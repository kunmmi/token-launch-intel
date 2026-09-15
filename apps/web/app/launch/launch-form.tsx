"use client";

import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Keypair, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { useSolanaNetwork } from "../providers/wallet-provider";

const MAX_SOL_BY_NETWORK = { devnet: 5, "mainnet-beta": 0.5 } as const; // mirrors the server-side ceiling in app/api/pump/launch-transaction/route.ts — client-side copy is UX-only, the server enforces the real limit

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
        <NetworkButton label="Devnet (test money)" active={!isMainnet} onClick={() => handleNetworkSwitch("devnet")} activeColor="#3a4a2a" />
        <NetworkButton label="Mainnet (real money)" active={isMainnet} onClick={() => handleNetworkSwitch("mainnet-beta")} activeColor="#4a2a2a" />
      </div>

      {isMainnet && (
        <p
          style={{
            background: "#3a1a1a",
            color: "#ff9090",
            padding: "10px 12px",
            borderRadius: 6,
            fontSize: 13,
            marginBottom: 16,
            fontWeight: 600,
          }}
        >
          MAINNET SELECTED — this spends real SOL from your real wallet. Transactions on Solana cannot be reversed or
          refunded. Make sure your wallet is actually set to Mainnet, not Devnet, before connecting.
        </p>
      )}

      <div style={{ marginBottom: 16 }}>
        <WalletMultiButton />
      </div>

      {!connected && (
        <p style={{ color: "#8b93a7", fontSize: 13 }}>
          Connect a Solana wallet (set to {isMainnet ? "Mainnet" : "Devnet"}) to launch a coin.
        </p>
      )}
      {connected && walletBalanceSol !== null && (
        <p style={{ color: "#8b93a7", fontSize: 13 }}>Wallet balance: {walletBalanceSol.toFixed(4)} SOL</p>
      )}

      <Field label="Name (max 32 chars)">
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} style={inputStyle} placeholder="My Coin" />
      </Field>
      <Field label="Symbol (max 10 chars)">
        <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} maxLength={10} style={inputStyle} placeholder="MYCOIN" />
      </Field>
      <Field label="Description">
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} style={{ ...inputStyle, minHeight: 60 }} />
      </Field>
      <Field label="Image">
        <input type="file" accept="image/*" onChange={(e) => setImageFile(e.target.files?.[0] ?? null)} />
      </Field>
      <Field label={`Initial buy (SOL, max ${MAX_SOL_BY_NETWORK[network]} on ${network})`}>
        <input value={solAmount} onChange={(e) => setSolAmount(e.target.value)} style={inputStyle} />
      </Field>
      {insufficientBalance && (
        <p style={{ color: "#ff8080", fontSize: 12, marginTop: -6, marginBottom: 12 }}>
          Wallet balance looks too low to cover this amount plus network fees.
        </p>
      )}

      {isMainnet && (
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, color: "#e0b0b0", marginBottom: 12 }}>
          <input type="checkbox" checked={mainnetConfirmed} onChange={(e) => setMainnetConfirmed(e.target.checked)} style={{ marginTop: 2 }} />
          <span>I understand this launches a real coin on Solana mainnet using real SOL, and that this cannot be undone.</span>
        </label>
      )}

      <button
        onClick={handleLaunch}
        disabled={!canSubmit}
        style={{
          marginTop: 12,
          padding: "10px 20px",
          borderRadius: 8,
          border: "none",
          background: canSubmit ? (isMainnet ? "#ff9090" : "#9db4ff") : "#23262f",
          color: canSubmit ? "#0b0d12" : "#5b6273",
          cursor: canSubmit ? "pointer" : "not-allowed",
          fontWeight: 600,
        }}
      >
        {status === "idle" ? `Launch on ${isMainnet ? "Mainnet" : "Devnet"}` : "Working..."}
      </button>

      {statusMessage && <p style={{ color: "#8b93a7", fontSize: 13, marginTop: 12 }}>{statusMessage}</p>}

      {status === "error" && (
        <p style={{ color: "#ff8080", fontSize: 13, marginTop: 12 }}>Failed: {statusMessage}</p>
      )}

      {status === "done" && resultSignature && resultMint && (
        <div style={{ marginTop: 16, padding: 12, border: "1px solid #23262f", borderRadius: 8 }}>
          <p style={{ margin: 0, color: "#8fd19e" }}>Launched — finalized on {network}.</p>
          <p style={{ margin: "6px 0 0", fontSize: 13, wordBreak: "break-all" }}>
            Mint: {resultMint}
          </p>
          <p style={{ margin: "6px 0 0", fontSize: 13 }}>
            <a
              href={`https://explorer.solana.com/tx/${resultSignature}${isMainnet ? "" : "?cluster=devnet"}`}
              target="_blank"
              rel="noreferrer"
              style={{ color: "#9db4ff" }}
            >
              View transaction on Solana Explorer
            </a>
          </p>
          {recordedInApp === null && (
            <p style={{ margin: "6px 0 0", fontSize: 13, color: "#8b93a7" }}>Recording this launch in the app...</p>
          )}
          {recordedInApp === true && (
            <p style={{ margin: "6px 0 0", fontSize: 13 }}>
              <a href={`/token/${isMainnet ? "solana" : "solana-devnet"}/${resultMint}`} style={{ color: "#9db4ff" }}>
                View on this app's Token page
              </a>
            </p>
          )}
          {recordedInApp === false && (
            <p style={{ margin: "6px 0 0", fontSize: 13, color: "#8b93a7" }}>
              The launch itself succeeded on-chain, but recording it in this app's own database failed — it won't show
              up on the Market/Token pages. Not a sign anything on-chain went wrong.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function NetworkButton({ label, active, onClick, activeColor }: { label: string; active: boolean; onClick: () => void; activeColor: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        padding: "8px 12px",
        borderRadius: 6,
        border: active ? "1px solid #4a5568" : "1px solid #23262f",
        background: active ? activeColor : "#12141b",
        color: active ? "#e6e8ec" : "#8b93a7",
        cursor: "pointer",
        fontSize: 13,
        fontWeight: active ? 600 : 400,
      }}
    >
      {label}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: "block", fontSize: 12, color: "#8b93a7", marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid #23262f",
  background: "#12141b",
  color: "#e6e8ec",
  boxSizing: "border-box",
};
