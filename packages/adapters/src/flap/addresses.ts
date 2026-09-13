/**
 * Confirmed in this session against primary sources, not guessed:
 *   - Portal address: docs.flap.sh/flap/developers/deployed-contract-addresses
 *     (fetched raw HTML directly and grepped for the BNB Chain Mainnet
 *     table, after WebFetch's summarized read garbled several hex digits —
 *     see the extra care taken here vs. trusting a paraphrase).
 *   - Chain ID: BNB Smart Chain mainnet, well-known public value (56).
 *   - WS endpoint: verified live in this session — connected, subscribed
 *     to the Portal address, and observed real TokenCreated/TokenBought/
 *     TokenSold logs streaming within seconds (115 logs in 15s).
 */
export const FLAP_PORTAL_ADDRESS = "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0";
/**
 * Confirmed live in this session to appear as the `creator` field on at
 * least one real TokenCreated event — VaultPortal is the on-chain caller
 * of Portal.newToken for vault-routed launches, so Portal attributes the
 * launch to it rather than the real human behind the launch. Exported so
 * downstream code (e.g. a future VenueSystemAddress registry entry, or
 * Creator History filtering) can recognize and handle this misattribution
 * rather than silently treating VaultPortal as a prolific creator.
 */
export const FLAP_VAULT_PORTAL_ADDRESS = "0x90497450f2a706f1951b5bdda52B4E5d16f34C06";

export const BNB_CHAIN_ID = 56;
export const BNB_CHAIN_RPC_HTTP = "https://bsc-rpc.publicnode.com";
export const BNB_CHAIN_RPC_WS = "wss://bsc-rpc.publicnode.com";
