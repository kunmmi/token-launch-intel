"use client";

import type { ReactNode } from "react";
import { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { clusterApiUrl } from "@solana/web3.js";
import "@solana/wallet-adapter-react-ui/styles.css";

/**
 * Client-side Solana wallet connection — devnet only, deliberately, for
 * now. This is the first write-capable surface in the app (M1: real coin
 * launches, not just watching them happen), and the user explicitly chose
 * to prove this out on devnet before ever touching mainnet with real
 * funds. There is no UI toggle to mainnet here; adding one is a separate,
 * deliberate decision for later, not an oversight.
 *
 * Wallet detection is automatic via the Wallet Standard (Phantom,
 * Solflare, Backpack, etc. all register themselves) — no need to list
 * adapters explicitly, unlike older wallet-adapter usage patterns.
 *
 * The public devnet RPC is fine here: this Connection is only ever used
 * client-side to fetch a blockhash context and broadcast an
 * already-signed transaction (sendRawTransaction) — not to call any of
 * the RPC methods this project found are blocked on free/public tiers
 * (getTokenLargestAccounts, getProgramAccounts, etc.). Building the
 * transaction itself happens server-side (see app/api/pump/launch-transaction).
 */
export function SolanaWalletProvider({ children }: { children: ReactNode }) {
  const endpoint = useMemo(() => clusterApiUrl("devnet"), []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
