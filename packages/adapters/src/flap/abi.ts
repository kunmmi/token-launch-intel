/**
 * Minimal ABI fragments — only what this adapter actually decodes/calls —
 * copied verbatim (field names, types, order) from the real IPortal.sol
 * interface fetched in this session:
 * raw.githubusercontent.com/flap-sh/FlapVaultExample/main/src/flap/IPortal.sol
 *
 * This is the canonical Flap Portal interface, published in Flap's own
 * official vault-integration example repo for third-party developers —
 * not reconstructed from docs or memory. The Portal contract itself (not
 * VaultPortal) emits these events regardless of whether a launch went
 * through VaultPortal or a direct Portal call — VaultPortal forwards into
 * Portal internally (confirmed in an earlier research pass on this
 * codebase), so watching Portal alone captures every launch.
 */

export const FLAP_PORTAL_ABI = [
  "event TokenCreated(uint256 ts, address creator, uint256 nonce, address token, string name, string symbol, string meta)",
  "event TokenBought(uint256 ts, address token, address buyer, uint256 amount, uint256 eth, uint256 fee, uint256 postPrice)",
  "event TokenSold(uint256 ts, address token, address seller, uint256 amount, uint256 eth, uint256 fee, uint256 postPrice)",
  "event LaunchedToDEX(address token, address pool, uint256 amount, uint256 eth)",
  // getTokenV8Safe: enum fields returned as uint8 specifically so external
  // integrators (us) don't get ABI-decode reverts when Flap adds new enum
  // variants — per the interface's own doc comment. progress is 0..1e18 (Wad).
  "function getTokenV8Safe(address token) view returns (tuple(uint8 status, uint256 reserve, uint256 circulatingSupply, uint256 price, uint8 tokenVersion, uint256 r, uint256 h, uint256 k, uint256 dexSupplyThresh, address quoteTokenAddress, bool nativeToQuoteSwapEnabled, bytes32 extensionID, uint256 buyTaxRate, uint256 sellTaxRate, address pool, uint256 progress, uint8 lpFeeProfile, uint8 dexId))",
];

/** IPortalCommonTypes.TokenStatus enum ordinals, from IPortal.sol. */
export const TOKEN_STATUS = {
  Invalid: 0,
  Tradable: 1,
  InDuel: 2, // obsolete
  Killed: 3, // obsolete
  DEX: 4,
  Staged: 5,
} as const;

const WAD = 1_000_000_000_000_000_000n; // 1e18 — Flap's fixed-point scale for `progress`
export function progressFromWad(progressWad: bigint): number {
  return Number(progressWad) / Number(WAD);
}
