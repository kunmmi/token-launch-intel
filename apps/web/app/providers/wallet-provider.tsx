"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { clusterApiUrl } from "@solana/web3.js";
import "@solana/wallet-adapter-react-ui/styles.css";

export type SolanaNetwork = "devnet" | "mainnet-beta";

interface NetworkContextValue {
  network: SolanaNetwork;
  setNetwork: (network: SolanaNetwork) => void;
}

const NetworkContext = createContext<NetworkContextValue | null>(null);

/** Which network the launch UI is currently pointed at. Resets to devnet on every page load — deliberately: never silently "stay" on mainnet across sessions. */
export function useSolanaNetwork(): NetworkContextValue {
  const ctx = useContext(NetworkContext);
  if (!ctx) throw new Error("useSolanaNetwork must be used within SolanaWalletProvider");
  return ctx;
}

/**
 * Client-side Solana wallet connection. Defaults to devnet on every page
 * load, every time — mainnet requires an explicit, conscious switch (see
 * app/launch/network-switch.tsx), not a persisted preference, so a user
 * can never end up on mainnet without deciding to be there in THIS
 * session. Real mainnet support was added after this app's devnet launch
 * flow was verified end-to-end by a real user with a real wallet.
 *
 * Wallet detection is automatic via the Wallet Standard (Phantom,
 * Solflare, Backpack, etc. all register themselves) — no need to list
 * adapters explicitly, unlike older wallet-adapter usage patterns.
 *
 * The public RPC (devnet or mainnet) is fine here: this Connection is
 * only ever used client-side to fetch a blockhash context and broadcast
 * an already-signed transaction (sendRawTransaction) — not to call any of
 * the RPC methods this project found are blocked on free/public tiers
 * (getTokenLargestAccounts, getProgramAccounts, etc.). Building the
 * transaction itself happens server-side (see app/api/pump/launch-transaction).
 */
export function SolanaWalletProvider({ children }: { children: ReactNode }) {
  const [network, setNetwork] = useState<SolanaNetwork>("devnet");
  const endpoint = useMemo(() => clusterApiUrl(network), [network]);

  return (
    <NetworkContext.Provider value={{ network, setNetwork }}>
      {/* key=network forces a full remount of the wallet-adapter tree on switch, so a stale connection from the old network can never linger */}
      <ConnectionProvider endpoint={endpoint} key={network}>
        <WalletProvider wallets={[]} autoConnect={false}>
          <WalletModalProvider>{children}</WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </NetworkContext.Provider>
  );
}
