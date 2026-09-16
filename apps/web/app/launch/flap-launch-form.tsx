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
      <div className="warn-banner" style={{ marginBottom: 16, fontWeight: 600 }}>
        MAINNET ONLY — no testnet path exists for Flap in this app. This spends real BNB and cannot be undone. The
        transaction logic has been verified via a real on-chain simulation, but no real signed Flap launch has been
        completed through this app yet — you would be the first.
      </div>

      <div style={{ marginBottom: 16 }}>
        {!wallet.connected ? (
          <button onClick={wallet.connect} disabled={wallet.connecting} className="btn btn-ghost">
            {wallet.connecting ? "Connecting…" : "Connect Wallet"}
          </button>
        ) : (
          <div style={{ fontSize: 13, color: "var(--paper-2)" }}>
            Connected: <span className="num" style={{ color: "var(--paper-1)" }}>{wallet.address}</span>
            {!wallet.correctChain && (
              <div style={{ marginTop: 6 }}>
                <span style={{ color: "var(--red-0)" }}>Wrong network. </span>
                <button onClick={wallet.switchToBnbChain} className="addr-link" style={{ background: "none", border: "none", cursor: "pointer", textDecoration: "underline", padding: 0 }}>
                  Switch to BNB Chain
                </button>
              </div>
            )}
          </div>
        )}
        {wallet.error && <p style={{ color: "var(--red-0)", fontSize: 12, marginTop: 6 }}>{wallet.error}</p>}
      </div>

      <div className="field">
        <label className="field-label">Name (max 64 chars)</label>
        <input className="field-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} placeholder="My Coin" />
      </div>
      <div className="field">
        <label className="field-label">Symbol (max 16 chars)</label>
        <input className="field-input" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} maxLength={16} placeholder="MYCOIN" />
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
        <label className="field-label">Initial buy (BNB, max 0.5)</label>
        <input className="field-input num" value={bnbAmount} onChange={(e) => setBnbAmount(e.target.value)} />
      </div>

      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12, color: "var(--red-0)", marginBottom: 14, lineHeight: 1.5 }}>
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} style={{ marginTop: 2 }} />
        <span>
          I understand this launches a real coin on BNB Chain mainnet using real BNB, that this cannot be undone, and
          that no real launch has been completed through this app before.
        </span>
      </label>

      <button onClick={handleLaunch} disabled={!canSubmit} className="btn btn-danger" style={{ width: "100%" }}>
        {status === "idle" ? "Launch on Flap (Mainnet)" : "Working…"}
      </button>

      {statusMessage && <p style={{ color: "var(--paper-2)", fontSize: 13, marginTop: 14 }}>{statusMessage}</p>}
      {status === "error" && <p style={{ color: "var(--red-0)", fontSize: 13, marginTop: 14 }}>Failed: {statusMessage}</p>}

      {status === "done" && resultTxHash && resultTokenAddress && (
        <div className="panel fade-up" style={{ marginTop: 16 }}>
          <div className="panel-body">
            <p style={{ margin: 0, color: "var(--green-0)", fontWeight: 700 }}>Launched — confirmed on BNB Chain.</p>
            <p style={{ margin: "8px 0 0", fontSize: 12, wordBreak: "break-all", color: "var(--paper-1)" }}>Token: {resultTokenAddress}</p>
            <p style={{ margin: "8px 0 0", fontSize: 13 }}>
              <a href={`https://bscscan.com/tx/${resultTxHash}`} target="_blank" rel="noreferrer" className="addr-link">
                View transaction on BscScan →
              </a>
            </p>
            {recordedInApp === null && <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--paper-3)" }}>Recording this launch in the app…</p>}
            {recordedInApp === true && (
              <p style={{ margin: "8px 0 0", fontSize: 13 }}>
                <a href={`/token/bnb/${resultTokenAddress}`} className="addr-link">
                  View on this app&apos;s Token page →
                </a>
              </p>
            )}
            {recordedInApp === false && (
              <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--paper-3)" }}>
                The launch itself succeeded on-chain, but recording it in this app&apos;s database failed — the
                scheduled indexer will still pick it up within ~20 minutes.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
