"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Minimal EVM wallet connection via the injected `window.ethereum`
 * provider (MetaMask, and anything else that injects the same standard
 * EIP-1193 interface) — no new dependency needed (unlike Solana's
 * wallet-adapter ecosystem, EVM wallets have converged on one standard
 * injected-provider interface for years, so a small hook is enough here).
 *
 * Parameterized by target chain so the same hook serves both Flap (BNB
 * Chain mainnet, a wallet's built-in chain almost every EVM wallet already
 * knows) and Pons (Robinhood Chain mainnet, obscure enough that most
 * wallets need `wallet_addEthereumChain` before they can switch to it —
 * see `switchChain`'s fallback below).
 */

export const BNB_CHAIN_ID_HEX = "0x38"; // 56 decimal, confirmed against BNB_CHAIN_ID in packages/adapters/src/flap/addresses.ts

/** 4663 decimal, confirmed against ROBINHOOD_CHAIN_ID in packages/adapters/src/pons/addresses.ts. */
export const ROBINHOOD_CHAIN_ID_HEX = "0x1237";

/** Passed to wallet_addEthereumChain when a wallet doesn't already know Robinhood Chain — values confirmed against docs.robinhood.com/chain/connecting (see packages/adapters/src/pons/addresses.ts's header). */
export const ROBINHOOD_ADD_CHAIN_PARAMS: AddEthereumChainParams = {
  chainId: ROBINHOOD_CHAIN_ID_HEX,
  chainName: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
  blockExplorerUrls: ["https://robinhoodchain.blockscout.com"],
};

export interface AddEthereumChainParams {
  chainId: string;
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  blockExplorerUrls?: string[];
}

interface EthereumProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  removeListener(event: string, handler: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

export interface EvmWalletState {
  address: string | null;
  connected: boolean;
  correctChain: boolean;
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  switchChain: () => Promise<void>;
}

export function useEvmWallet(targetChainHex: string, addChainParams?: AddEthereumChainParams): EvmWalletState {
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const eth = window.ethereum;
    if (!eth) return;

    const handleAccountsChanged = (...args: unknown[]) => {
      const accounts = args[0] as string[];
      setAddress(accounts[0] ?? null);
    };
    const handleChainChanged = (...args: unknown[]) => {
      setChainId(args[0] as string);
    };
    eth.on("accountsChanged", handleAccountsChanged);
    eth.on("chainChanged", handleChainChanged);
    return () => {
      eth.removeListener("accountsChanged", handleAccountsChanged);
      eth.removeListener("chainChanged", handleChainChanged);
    };
  }, []);

  const connect = useCallback(async () => {
    const eth = window.ethereum;
    if (!eth) {
      setError("No EVM wallet found — install MetaMask or a compatible wallet extension.");
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      setAddress(accounts[0] ?? null);
      const currentChainId = (await eth.request({ method: "eth_chainId" })) as string;
      setChainId(currentChainId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect wallet");
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    setAddress(null);
    setChainId(null);
  }, []);

  const switchChain = useCallback(async () => {
    const eth = window.ethereum;
    if (!eth) return;
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: targetChainHex }] });
    } catch (err) {
      // 4902 = chain unrecognized by the wallet — real MetaMask behavior for
      // any chain the user hasn't added before, expected for Robinhood
      // Chain far more often than for BNB Chain. Falls back to
      // wallet_addEthereumChain (which itself prompts the wallet's own
      // "Add network" UI) rather than surfacing a dead-end error.
      const code = (err as { code?: number } | null)?.code;
      if (code === 4902 && addChainParams) {
        try {
          await eth.request({ method: "wallet_addEthereumChain", params: [addChainParams] });
          return;
        } catch (addErr) {
          setError(addErr instanceof Error ? addErr.message : "Failed to add network");
          return;
        }
      }
      setError(err instanceof Error ? err.message : "Failed to switch network");
    }
  }, [targetChainHex, addChainParams]);

  return {
    address,
    connected: address !== null,
    correctChain: chainId === targetChainHex,
    connecting,
    error,
    connect,
    disconnect,
    switchChain,
  };
}
