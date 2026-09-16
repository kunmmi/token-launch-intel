"use client";

import { useMemo, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { clusterApiUrl } from "@solana/web3.js";
import "@solana/wallet-adapter-react-ui/styles.css";

/**
 * Client-side Solana wallet connection — Mainnet only, at the user's
 * explicit request (the earlier Devnet/Mainnet toggle was removed
 * entirely, not just defaulted differently). Real mainnet support was
 * added after this app's launch flow was verified end-to-end on Devnet by
 * a real user with a real wallet; that verification history lives in
 * README/git history now, not in the UI.
 *
 * Wallet detection is automatic via the Wallet Standard (Phantom,
 * Solflare, Backpack, etc. all register themselves) — no need to list
 * adapters explicitly, unlike older wallet-adapter usage patterns.
 *
 * The public RPC is fine here: this Connection is only ever used
 * client-side to fetch a blockhash context and broadcast an
 * already-signed transaction (sendRawTransaction) — not to call any of
 * the RPC methods this project found are blocked on free/public tiers
 * (getTokenLargestAccounts, getProgramAccounts, etc.). Building the
 * transaction itself happens server-side (see app/api/pump/launch-transaction).
 */
export function SolanaWalletProvider({ children }: { children: ReactNode }) {
  const endpoint = useMemo(() => clusterApiUrl("mainnet-beta"), []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={[]} autoConnect={false}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
