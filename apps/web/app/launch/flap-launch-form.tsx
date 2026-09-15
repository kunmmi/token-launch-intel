"use client";

import { useEffect, useState } from "react";
import { useEvmWallet } from "../providers/evm-wallet";

/**
 * Real Flap coin launch — BNB Chain mainnet only (no testnet path was
 * verified for Flap, unlike Pump.fun's devnet-first rollout — see
 * packages/adapters/src/flap/launch.ts's header for how this was built:
 * real function, real defaults, real metadata schema, and real CREATE2
 * vanity-address mining, ALL verified against genuine on-chain data
 * before this UI was written).
 *
 * Verified so far: the built transaction (including the mined vanity
 * salt) passes a real `eth_call` simulation against live mainnet,
 * returning the exact predicted token address with no revert. NOT yet
 * verified: an actual signed, submitted transaction from a real wallet —
 * this is the first UI ever built for it. Said plainly in the page copy
 * below, not hidden.
 */
export function FlapLaunchForm() {
  const wallet = useEvmWallet();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [bnbAmount, setBnbAmount] = useState("0.01");
  const [confirmed, setConfirmed] = useState(false);

  const [status, setStatus] = useState<"idle" | "uploading-metadata" | "building-transaction" | "awaiting-signature" | "submitting" | "done" | "error">("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [resultTxHash, setResultTxHash] = useState<string | null>(null);
  const [resultTokenAddress, setResultTokenAddress] = useState<string | null>(null);
  const [recordedInApp, setRecordedInApp] = useState<boolean | null>(null);

  useEffect(() => {
    setConfirmed(false);
  }, [wallet.address]);

  const bnbWei = (() => {
    const parsed = Number(bnbAmount);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 0.5) return null;
    return BigInt(Math.round(parsed * 1e18));
  })();

  const canSubmit =
    wallet.connected &&
    wallet.correctChain &&
    name.trim().length > 0 &&
    symbol.trim().length > 0 &&
    imageFile !== null &&
    bnbWei !== null &&
    confirmed &&
    status === "idle";

  async function handleLaunch() {
    if (!wallet.address || !imageFile || bnbWei === null || !window.ethereum) return;

    try {
      setStatus("uploading-metadata");
      setStatusMessage("Uploading image + building metadata (pinned via a real IPFS service)...");
      const metadataForm = new FormData();
      metadataForm.append("file", imageFile);
      metadataForm.append("name", name);
      metadataForm.append("symbol", symbol);
      metadataForm.append("description", description);
      metadataForm.append("creatorAddress", wallet.address);
      const metadataRes = await fetch("/api/flap/metadata", { method: "POST", body: metadataForm });
      const metadataJson = await metadataRes.json();
      if (!metadataRes.ok) throw new Error(metadataJson.error ?? "Metadata upload failed");
      const metaCid: string = metadataJson.metaCid;

      setStatus("building-transaction");
      setStatusMessage("Mining a valid vanity address (real on-chain requirement, ~5s)...");
      const txRes = await fetch("/api/flap/launch-transaction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creatorAddress: wallet.address, name, symbol, metaCid, bnbAmountWei: bnbWei.toString() }),
      });
      const txJson = await txRes.json();
      if (!txRes.ok) throw new Error(txJson.error ?? "Failed to build launch transaction");

      setStatus("awaiting-signature");
      setStatusMessage(
        `Approve in your wallet — this will spend ${bnbAmount} BNB (MAINNET, real money) and create ${name} (${symbol}) at ${txJson.predictedTokenAddress}.`,
      );

      setStatus("submitting");
      const txHash = (await window.ethereum.request({
        method: "eth_sendTransaction",
        params: [{ from: wallet.address, to: txJson.to, data: txJson.data, value: txJson.valueHex }],
      })) as string;
      setStatusMessage("Submitted — waiting for confirmation...");

      // Poll for the receipt rather than assume instant finality — BNB Chain blocks are ~3s, this usually resolves in a few polls.
      let blockNumber: string | null = null;
      for (let attempt = 0; attempt < 30; attempt++) {
        const receipt = (await window.ethereum.request({ method: "eth_getTransactionReceipt", params: [txHash] })) as { blockNumber?: string; status?: string } | null;
        if (receipt?.blockNumber) {
          if (receipt.status !== "0x1") throw new Error("Transaction was mined but reverted");
          blockNumber = receipt.blockNumber;
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!blockNumber) throw new Error("Transaction did not confirm in time — check the explorer link manually");

      setResultTxHash(txHash);
      setResultTokenAddress(txJson.predictedTokenAddress);
      setStatus("done");
      setStatusMessage(null);

      try {
        const recordRes = await fetch("/api/flap/record-launch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tokenAddress: txJson.predictedTokenAddress,
            name,
            symbol,
            creatorAddress: wallet.address,
            launchTxHash: txHash,
            blockNumber: parseInt(blockNumber, 16),
            launchTimestamp: Math.floor(Date.now() / 1000),
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
        MAINNET ONLY — no testnet path exists for Flap in this app. This spends real BNB and cannot be undone. The
        transaction logic has been verified via a real on-chain simulation, but no real signed Flap launch has been
        completed through this app yet — you would be the first.
      </p>

      <div style={{ marginBottom: 16 }}>
        {!wallet.connected ? (
          <button onClick={wallet.connect} disabled={wallet.connecting} style={connectButtonStyle}>
            {wallet.connecting ? "Connecting..." : "Connect Wallet"}
          </button>
        ) : (
          <div style={{ fontSize: 13, color: "#8b93a7" }}>
            Connected: {wallet.address}
            {!wallet.correctChain && (
              <div style={{ marginTop: 6 }}>
                <span style={{ color: "#ff9090" }}>Wrong network. </span>
                <button onClick={wallet.switchToBnbChain} style={{ color: "#9db4ff", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>
                  Switch to BNB Chain
                </button>
              </div>
            )}
          </div>
        )}
        {wallet.error && <p style={{ color: "#ff8080", fontSize: 12, marginTop: 6 }}>{wallet.error}</p>}
      </div>

      <Field label="Name (max 64 chars)">
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} style={inputStyle} placeholder="My Coin" />
      </Field>
      <Field label="Symbol (max 16 chars)">
        <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} maxLength={16} style={inputStyle} placeholder="MYCOIN" />
      </Field>
      <Field label="Description">
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} style={{ ...inputStyle, minHeight: 60 }} />
      </Field>
      <Field label="Image">
        <input type="file" accept="image/*" onChange={(e) => setImageFile(e.target.files?.[0] ?? null)} />
      </Field>
      <Field label="Initial buy (BNB, max 0.5)">
        <input value={bnbAmount} onChange={(e) => setBnbAmount(e.target.value)} style={inputStyle} />
      </Field>

      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, color: "#e0b0b0", marginBottom: 12 }}>
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} style={{ marginTop: 2 }} />
        <span>I understand this launches a real coin on BNB Chain mainnet using real BNB, that this cannot be undone, and that no real launch has been completed through this app before.</span>
      </label>

      <button
        onClick={handleLaunch}
        disabled={!canSubmit}
        style={{
          padding: "10px 20px",
          borderRadius: 8,
          border: "none",
          background: canSubmit ? "#ff9090" : "#23262f",
          color: canSubmit ? "#0b0d12" : "#5b6273",
          cursor: canSubmit ? "pointer" : "not-allowed",
          fontWeight: 600,
        }}
      >
        {status === "idle" ? "Launch on Flap (Mainnet)" : "Working..."}
      </button>

      {statusMessage && <p style={{ color: "#8b93a7", fontSize: 13, marginTop: 12 }}>{statusMessage}</p>}
      {status === "error" && <p style={{ color: "#ff8080", fontSize: 13, marginTop: 12 }}>Failed: {statusMessage}</p>}

      {status === "done" && resultTxHash && resultTokenAddress && (
        <div style={{ marginTop: 16, padding: 12, border: "1px solid #23262f", borderRadius: 8 }}>
          <p style={{ margin: 0, color: "#8fd19e" }}>Launched — confirmed on BNB Chain.</p>
          <p style={{ margin: "6px 0 0", fontSize: 13, wordBreak: "break-all" }}>Token: {resultTokenAddress}</p>
          <p style={{ margin: "6px 0 0", fontSize: 13 }}>
            <a href={`https://bscscan.com/tx/${resultTxHash}`} target="_blank" rel="noreferrer" style={{ color: "#9db4ff" }}>
              View transaction on BscScan
            </a>
          </p>
          {recordedInApp === null && <p style={{ margin: "6px 0 0", fontSize: 13, color: "#8b93a7" }}>Recording this launch in the app...</p>}
          {recordedInApp === true && (
            <p style={{ margin: "6px 0 0", fontSize: 13 }}>
              <a href={`/token/bnb/${resultTokenAddress}`} style={{ color: "#9db4ff" }}>
                View on this app's Token page
              </a>
            </p>
          )}
          {recordedInApp === false && (
            <p style={{ margin: "6px 0 0", fontSize: 13, color: "#8b93a7" }}>
              The launch itself succeeded on-chain, but recording it in this app's database failed — the scheduled
              indexer will still pick it up within ~20 minutes.
            </p>
          )}
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

const connectButtonStyle: React.CSSProperties = {
  padding: "8px 16px",
  borderRadius: 6,
  border: "1px solid #23262f",
  background: "#12141b",
  color: "#e6e8ec",
  cursor: "pointer",
};
