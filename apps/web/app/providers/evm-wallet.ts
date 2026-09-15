"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Minimal EVM wallet connection via the injected `window.ethereum`
 * provider (MetaMask, and anything else that injects the same standard
 * EIP-1193 interface) — no new dependency needed (unlike Solana's
 * wallet-adapter ecosystem, EVM wallets have converged on one standard
 * injected-provider interface for years, so a small hook is enough here).
 *
 * BNB Chain mainnet only, matching packages/adapters/src/flap/launch.ts's
 * scope (everything about the real Flap launch mechanics was verified
 * against BNB mainnet specifically, not testnet).
 */

const BNB_CHAIN_ID_HEX = "0x38"; // 56 decimal, confirmed against BNB_CHAIN_ID in packages/adapters/src/flap/addresses.ts

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
  switchToBnbChain: () => Promise<void>;
}

export function useEvmWallet(): EvmWalletState {
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

  const switchToBnbChain = useCallback(async () => {
    const eth = window.ethereum;
    if (!eth) return;
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: BNB_CHAIN_ID_HEX }] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to switch network");
    }
  }, []);

  return {
    address,
    connected: address !== null,
    correctChain: chainId === BNB_CHAIN_ID_HEX,
    connecting,
    error,
    connect,
    disconnect,
    switchToBnbChain,
  };
}
