"use client";

import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Keypair, Transaction } from "@solana/web3.js";

/**
 * Real Pump.fun coin launch, devnet only (see app/providers/wallet-provider.tsx).
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
 */
export function LaunchForm() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [solAmount, setSolAmount] = useState("0.01");

  const [status, setStatus] = useState<"idle" | "uploading-metadata" | "building-transaction" | "awaiting-signature" | "submitting" | "done" | "error">("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [resultSignature, setResultSignature] = useState<string | null>(null);
  const [resultMint, setResultMint] = useState<string | null>(null);

  const solLamports = (() => {
    const parsed = Number(solAmount);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return BigInt(Math.round(parsed * 1_000_000_000));
  })();

  const canSubmit =
    connected && publicKey !== null && name.trim().length > 0 && symbol.trim().length > 0 && imageFile !== null && solLamports !== null && status === "idle";

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
        }),
      });
      const txJson = await txRes.json();
      if (!txRes.ok) throw new Error(txJson.error ?? "Failed to build launch transaction");

      const transaction = Transaction.from(Buffer.from(txJson.transactionBase64, "base64"));
      transaction.partialSign(mintKeypair); // co-signs as the new mint account — never touches the server

      setStatus("awaiting-signature");
      setStatusMessage(`Approve in your wallet — this will spend ${solAmount} SOL (devnet) and create ${name} (${symbol}).`);

      setStatus("submitting");
      const signature = await sendTransaction(transaction, connection);
      setStatusMessage("Submitted — waiting for confirmation...");

      const latestBlockhash = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature, ...latestBlockhash }, "confirmed");

      setResultSignature(signature);
      setResultMint(mintKeypair.publicKey.toBase58());
      setStatus("done");
      setStatusMessage(null);
    } catch (err) {
      setStatus("error");
      setStatusMessage(err instanceof Error ? err.message : "Launch failed");
    }
  }

  return (
    <div style={{ maxWidth: 480 }}>
      <div style={{ marginBottom: 16 }}>
        <WalletMultiButton />
      </div>

      {!connected && (
        <p style={{ color: "#8b93a7", fontSize: 13 }}>Connect a Solana wallet (set to Devnet) to launch a coin.</p>
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
      <Field label="Initial buy (SOL, devnet)">
        <input value={solAmount} onChange={(e) => setSolAmount(e.target.value)} style={inputStyle} />
      </Field>

      <button
        onClick={handleLaunch}
        disabled={!canSubmit}
        style={{
          marginTop: 12,
          padding: "10px 20px",
          borderRadius: 8,
          border: "none",
          background: canSubmit ? "#9db4ff" : "#23262f",
          color: canSubmit ? "#0b0d12" : "#5b6273",
          cursor: canSubmit ? "pointer" : "not-allowed",
          fontWeight: 600,
        }}
      >
        {status === "idle" ? "Launch on Devnet" : "Working..."}
      </button>

      {statusMessage && <p style={{ color: "#8b93a7", fontSize: 13, marginTop: 12 }}>{statusMessage}</p>}

      {status === "error" && (
        <p style={{ color: "#ff8080", fontSize: 13, marginTop: 12 }}>Failed: {statusMessage}</p>
      )}

      {status === "done" && resultSignature && resultMint && (
        <div style={{ marginTop: 16, padding: 12, border: "1px solid #23262f", borderRadius: 8 }}>
          <p style={{ margin: 0, color: "#8fd19e" }}>Launched — finalized on devnet.</p>
          <p style={{ margin: "6px 0 0", fontSize: 13, wordBreak: "break-all" }}>
            Mint: {resultMint}
          </p>
          <p style={{ margin: "6px 0 0", fontSize: 13 }}>
            <a href={`https://explorer.solana.com/tx/${resultSignature}?cluster=devnet`} target="_blank" rel="noreferrer" style={{ color: "#9db4ff" }}>
              View transaction on Solana Explorer
            </a>
          </p>
        </div>
      )}
    </div>
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
