"use client";

import { useEffect, useState } from "react";
import { Interface } from "ethers";
import { useEvmWallet, ROBINHOOD_CHAIN_ID_HEX, ROBINHOOD_ADD_CHAIN_PARAMS } from "../providers/evm-wallet";

const MAX_ETH_AMOUNT = 0.5; // mirrors the server-side ceiling in app/api/pons/launch-transaction/route.ts — client-side copy is UX-only, the server enforces the real limit

// Only the `Launched` event is needed here (to recover the new token
// address from the receipt — launchAndBuy's return value isn't visible to
// a plain eth_sendTransaction caller, only to another contract calling it
// synchronously) — see packages/adapters/src/pons/abi.ts for where this
// signature was confirmed against the real verified PonsV2LaunchAndBuy
// source.
const LAUNCHED_EVENT_IFACE = new Interface([
  "event Launched(address indexed token, address indexed curve, address indexed recipient, address launcher, uint256 quoteSpent, uint256 tokensReceived)",
]);
const LAUNCH_AND_BUY_ADDRESS = "0xe33e9e479dF8802cb0866d5d05258bEc4cF62948";

/**
 * Real Pons coin launch — Robinhood Chain mainnet only, via the same
 * atomic launch+buy path real Pons launches use (PonsV2LaunchAndBuy, see
 * packages/adapters/src/pons/launch.ts's header for the full story of why
 * this isn't the factory's bare, riskier launchToken).
 *
 * No devnet/testnet path exists for Pons in this app — same situation as
 * Flap, no separate testnet deployment was found for either.
 */
export function PonsLaunchForm() {
  const wallet = useEvmWallet(ROBINHOOD_CHAIN_ID_HEX, ROBINHOOD_ADD_CHAIN_PARAMS);

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [twitterUrl, setTwitterUrl] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [ethAmount, setEthAmount] = useState("0.01");
  const [confirmed, setConfirmed] = useState(false);

  const [status, setStatus] = useState<"idle" | "uploading-image" | "building-transaction" | "awaiting-signature" | "submitting" | "done" | "error">("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [resultTxHash, setResultTxHash] = useState<string | null>(null);
  const [resultTokenAddress, setResultTokenAddress] = useState<string | null>(null);
  const [recordedInApp, setRecordedInApp] = useState<boolean | null>(null);

  useEffect(() => {
    setConfirmed(false);
  }, [wallet.address]);

  const quoteInWei = (() => {
    const parsed = Number(ethAmount);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_ETH_AMOUNT) return null;
    return BigInt(Math.round(parsed * 1e18));
  })();

  const canSubmit =
    wallet.connected &&
    wallet.correctChain &&
    name.trim().length > 0 &&
    symbol.trim().length > 0 &&
    imageFile !== null &&
    quoteInWei !== null &&
    confirmed &&
    status === "idle";

  async function handleLaunch() {
    if (!wallet.address || !imageFile || quoteInWei === null || !window.ethereum) return;

    try {
      setStatus("uploading-image");
      setStatusMessage("Uploading image (pinned via a real IPFS service)...");
      const imageForm = new FormData();
      imageForm.append("file", imageFile);
      const imageRes = await fetch("/api/pons/metadata", { method: "POST", body: imageForm });
      const imageJson = await imageRes.json();
      if (!imageRes.ok) throw new Error(imageJson.error ?? "Image upload failed");
      const logoUrl: string = imageJson.logoUrl;

      setStatus("building-transaction");
      setStatusMessage("Building the real launch+buy transaction...");
      const txRes = await fetch("/api/pons/launch-transaction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          creatorAddress: wallet.address,
          name,
          symbol,
          logoUrl,
          description,
          twitterUrl,
          creatorTaxBps: 0,
          quoteInWei: quoteInWei.toString(),
        }),
      });
      const txJson = await txRes.json();
      if (!txRes.ok) throw new Error(txJson.error ?? "Failed to build launch transaction");

      setStatus("awaiting-signature");
      setStatusMessage(
        `Approve in your wallet — this will spend ${ethAmount} ETH plus a small launch fee (MAINNET, real money) and create ${name} (${symbol}).`,
      );

      setStatus("submitting");
      const txHash = (await window.ethereum.request({
        method: "eth_sendTransaction",
        params: [{ from: wallet.address, to: txJson.to, data: txJson.data, value: txJson.valueHex }],
      })) as string;
      setStatusMessage("Submitted — waiting for confirmation...");

      let tokenAddress: string | null = null;
      let blockNumber: string | null = null;
      for (let attempt = 0; attempt < 30; attempt++) {
        const receipt = (await window.ethereum.request({ method: "eth_getTransactionReceipt", params: [txHash] })) as
          | { blockNumber?: string; status?: string; logs?: { address: string; topics: string[]; data: string }[] }
          | null;
        if (receipt?.blockNumber) {
          if (receipt.status !== "0x1") throw new Error("Transaction was mined but reverted");
          blockNumber = receipt.blockNumber;
          const launchedLog = receipt.logs?.find((log) => log.address.toLowerCase() === LAUNCH_AND_BUY_ADDRESS.toLowerCase());
          if (launchedLog) {
            const parsed = LAUNCHED_EVENT_IFACE.parseLog({ topics: launchedLog.topics, data: launchedLog.data });
            tokenAddress = parsed?.args.getValue("token") ?? null;
          }
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!blockNumber || !tokenAddress) throw new Error("Transaction did not confirm in time, or the token address couldn't be read from its logs — check the explorer link manually");

      setResultTxHash(txHash);
      setResultTokenAddress(tokenAddress);
      setStatus("done");
      setStatusMessage(null);

      try {
        const recordRes = await fetch("/api/pons/record-launch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tokenAddress,
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
        MAINNET ONLY — no testnet path exists for Pons in this app. This spends real ETH on Robinhood Chain and
        cannot be undone. Launches route through Pons&apos;s own real atomic launch+buy contract (PonsV2LaunchAndBuy)
        — the same path Pons&apos;s own frontend uses — so your initial buy settles in the same transaction as the
        launch itself, with nothing able to trade against it in between.
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
                <button onClick={wallet.switchChain} className="addr-link" style={{ background: "none", border: "none", cursor: "pointer", textDecoration: "underline", padding: 0 }}>
                  Switch to Robinhood Chain
                </button>
              </div>
            )}
          </div>
        )}
        {wallet.error && <p style={{ color: "var(--red-0)", fontSize: 12, marginTop: 6 }}>{wallet.error}</p>}
      </div>

      <div className="field">
        <label className="field-label">Name</label>
        <input className="field-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="My Coin" />
      </div>
      <div className="field">
        <label className="field-label">Symbol</label>
        <input className="field-input" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="MYCOIN" />
      </div>
      <div className="field">
        <label className="field-label">Description</label>
        <textarea className="field-input" value={description} onChange={(e) => setDescription(e.target.value)} style={{ minHeight: 64, resize: "vertical" }} />
      </div>
      <div className="field">
        <label className="field-label">Twitter/X link (optional)</label>
        <input className="field-input" value={twitterUrl} onChange={(e) => setTwitterUrl(e.target.value)} placeholder="https://x.com/..." />
      </div>
      <div className="field">
        <label className="field-label">Image</label>
        <input type="file" accept="image/*" onChange={(e) => setImageFile(e.target.files?.[0] ?? null)} />
      </div>
      <div className="field">
        <label className="field-label">Initial buy (ETH, max {MAX_ETH_AMOUNT}, plus a small launch fee)</label>
        <input className="field-input num" value={ethAmount} onChange={(e) => setEthAmount(e.target.value)} />
      </div>

      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12, color: "var(--red-0)", marginBottom: 14, lineHeight: 1.5 }}>
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} style={{ marginTop: 2 }} />
        <span>I understand this launches a real coin on Robinhood Chain mainnet using real ETH, and that this cannot be undone.</span>
      </label>

      <button onClick={handleLaunch} disabled={!canSubmit} className="btn btn-danger" style={{ width: "100%" }}>
        {status === "idle" ? "Launch on Pons (Mainnet)" : "Working…"}
      </button>

      {statusMessage && <p style={{ color: "var(--paper-2)", fontSize: 13, marginTop: 14 }}>{statusMessage}</p>}
      {status === "error" && <p style={{ color: "var(--red-0)", fontSize: 13, marginTop: 14 }}>Failed: {statusMessage}</p>}

      {status === "done" && resultTxHash && resultTokenAddress && (
        <div className="panel fade-up" style={{ marginTop: 16 }}>
          <div className="panel-body">
            <p style={{ margin: 0, color: "var(--green-0)", fontWeight: 700 }}>Launched — confirmed on Robinhood Chain.</p>
            <p style={{ margin: "8px 0 0", fontSize: 12, wordBreak: "break-all", color: "var(--paper-1)" }}>Token: {resultTokenAddress}</p>
            <p style={{ margin: "8px 0 0", fontSize: 13 }}>
              <a href={`https://robinhoodchain.blockscout.com/tx/${resultTxHash}`} target="_blank" rel="noreferrer" className="addr-link">
                View transaction on Blockscout →
              </a>
            </p>
            {recordedInApp === null && <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--paper-3)" }}>Recording this launch in the app…</p>}
            {recordedInApp === true && (
              <p style={{ margin: "8px 0 0", fontSize: 13 }}>
                <a href={`/token/robinhood/${resultTokenAddress}`} className="addr-link">
                  View on this app&apos;s Token page →
                </a>
              </p>
            )}
            {recordedInApp === false && (
              <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--paper-3)" }}>
                The launch itself succeeded on-chain, but recording it in this app&apos;s database failed — the
                scheduled indexer will still pick it up on its own.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
