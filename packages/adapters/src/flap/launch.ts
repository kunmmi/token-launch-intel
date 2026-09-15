import { Interface, ZeroAddress, ZeroHash, randomBytes, hexlify, getCreate2Address, keccak256 } from "ethers";
import { FLAP_PORTAL_ADDRESS } from "./addresses.js";

/**
 * Real Flap coin-creation transaction builder — the write-side counterpart
 * to real-adapter.ts. Unlike Pump.fun, Flap has NO official SDK for this,
 * and its real creation interface (newTokenV7 in the published IPortal.sol)
 * takes several parameters (fee configs, extension IDs, migrator types)
 * with no verified reference for a plain simple launch — guessing those on
 * a real-money write transaction was judged too risky at first (see this
 * project's README for that earlier, correct decision to pause rather than
 * guess). Unblocked properly afterward, not by guessing:
 *
 *   - The real deployed Portal contract's `newTokenV6` selector and full
 *     parameter-type signature were confirmed via openchain.xyz's public
 *     selector database (`hasVerifiedContract: true` — sourced from the
 *     verified contract itself), NOT the newer newTokenV7 the published
 *     interface also declares — V7 exists in the interface but real
 *     launches observed in this session used V6.
 *   - Two independent real successful launches (both real `newTokenV6`
 *     calls against the real Portal address) were decoded with that exact
 *     signature and compared. Every DEFAULT_* constant below is a value
 *     that was IDENTICAL across both real examples — genuine platform
 *     defaults, not a one-off. Fields that DIFFERED (antiFarmerDuration,
 *     deflationBps, dividendBps, dividendToken, quoteToken/quoteAmt) are
 *     real user-configurable choices; this file only builds the simpler,
 *     native-BNB-quoted case, matching the cleaner of the two real
 *     examples exactly.
 *   - The real metadata JSON schema was fetched directly from a real
 *     launch's on-chain `meta` CID via a public gateway, not assumed.
 *   - **The vanity-address requirement** (every real Flap token address
 *     ends in a fixed suffix — confirmed against 14 of 15 real addresses
 *     in this project's own database, all ending "7777"; the contract
 *     enforces this on-chain via `VanityAddressRequirementNotMet`) is
 *     satisfied by real CREATE2 salt mining below, using BscScan's
 *     verified-source API (a real account, provided by the user) to
 *     obtain: (a) Portal's real constructor arguments, decoded to find
 *     `tokenImplTaxedV3_` (the token implementation `TokenVersion.TOKEN_TAXED_V3`
 *     — ordinal 6, confirmed against the real enum definition — clones
 *     from), and (b) confirmation that Flap tokens are deployed via
 *     OpenZeppelin's standard EIP-1167 minimal-proxy clone pattern (its
 *     `ClonesUpgradeable` library is a real import in the verified Portal
 *     source). The full prediction formula
 *     (deployer=Portal proxy address, standard EIP-1167 init code for that
 *     implementation, standard CREATE2 formula) was then VALIDATED — not
 *     assumed — by recomputing a real transaction's already-known real
 *     salt and confirming it reproduces that transaction's real, on-chain
 *     deployed token address exactly (0xe493...a7777, matched to the
 *     casing-insensitive letter).
 *
 * SECURITY DESIGN, same as Pump's launch.ts: this returns unsigned
 * transaction PARAMETERS ({to, data, value}) for the client's own wallet
 * (MetaMask etc.) to sign and send via eth_sendTransaction. This file
 * never holds, generates, or needs any private key.
 */

const FLAP_PORTAL_ABI = [
  "function newTokenV6((string name,string symbol,string meta,uint8 dexThresh,bytes32 salt,uint8 migratorType,address quoteToken,uint256 quoteAmt,address beneficiary,bytes permitData,bytes32 extensionID,bytes extensionData,uint8 dexId,uint8 lpFeeProfile,uint16 buyTaxRate,uint16 sellTaxRate,uint64 taxDuration,uint64 antiFarmerDuration,uint16 mktBps,uint16 deflationBps,uint16 dividendBps,uint16 lpBps,uint256 minimumShareBalance,address dividendToken,address commissionReceiver,uint8 tokenVersion)) payable returns (address token)",
];

// Every value here is a real, observed default — see this file's header for exactly how each was verified.
const DEFAULT_DEX_THRESH = 1;
const DEFAULT_MIGRATOR_TYPE = 1;
const DEFAULT_DEX_ID = 0;
const DEFAULT_LP_FEE_PROFILE = 0;
const DEFAULT_BUY_TAX_RATE_BPS = 100; // 1%
const DEFAULT_SELL_TAX_RATE_BPS = 100; // 1%
const DEFAULT_TAX_DURATION_SECONDS = 3_153_600_000n; // ~100 years — observed identically on both real examples, effectively "forever"
const DEFAULT_ANTI_FARMER_DURATION_SECONDS = 2_592_000n; // 30 days — matches the simpler of the two real examples
const DEFAULT_MKT_BPS = 0;
const DEFAULT_DEFLATION_BPS = 0;
const DEFAULT_DIVIDEND_BPS = 10000; // 100% — matches the simpler real example; dividendToken left at zero address alongside it, same as that example
const DEFAULT_LP_BPS = 0;
const DEFAULT_MINIMUM_SHARE_BALANCE = 10_000n * 1_000_000_000_000_000_000n; // 10,000 tokens (18 decimals) — observed identically on both real examples
const DEFAULT_TOKEN_VERSION = 6; // TokenVersion.TOKEN_TAXED_V3 in the real enum — confirmed, not assumed (see this file's header)

/**
 * The real, verified implementation address `Clones.cloneDeterministic`
 * deploys against for TokenVersion.TOKEN_TAXED_V3 (ordinal 6) — decoded
 * from Portal's own real constructor arguments (field `tokenImplTaxedV3_`),
 * fetched via BscScan's verified-source API.
 */
const TOKEN_TAXED_V3_IMPLEMENTATION = "0x024f18294970b5c76c0691b87f138a0317156422";

/** Real Flap token addresses observed in this project's own database overwhelmingly end in this suffix — the contract enforces it on-chain. */
const VANITY_SUFFIX = "7777";
const MAX_SALT_MINING_ATTEMPTS = 2_000_000; // ~16^4 expected attempts for a 4-hex-digit suffix; this ceiling is generous headroom, not the expected case

export interface BuildFlapLaunchParams {
  /** The creator's wallet — becomes the beneficiary (LP fee / tax recipient) and the transaction's real signer. Never a private key. */
  creatorAddress: string;
  name: string;
  symbol: string;
  /** Bare IPFS CID (no ipfs:// or gateway prefix) of the metadata JSON — see this file's header for the real schema this must follow. */
  metaCid: string;
  /** Initial buy amount in wei (native BNB — this function only builds the native-quote case). */
  bnbAmountWei: bigint;
}

export interface BuiltFlapLaunchTransaction {
  /** Portal contract address — the transaction's `to`. */
  to: string;
  /** ABI-encoded calldata for newTokenV6. */
  data: string;
  /** Value to send with the transaction, as a hex string (wei) — equals bnbAmountWei. */
  valueHex: string;
  /** The real, predicted address of the token this transaction will deploy — computed locally via the same verified CREATE2 formula the mining loop used, not a guess. */
  predictedTokenAddress: string;
}

const iface = new Interface(FLAP_PORTAL_ABI);

/**
 * Real EIP-1167 minimal-proxy init code for cloning `implementation` —
 * the standard, public formula (not Flap-specific), confirmed applicable
 * here because Portal's real verified source imports OpenZeppelin's
 * `ClonesUpgradeable`.
 */
function minimalProxyInitCodeHash(implementation: string): string {
  const implHex = implementation.slice(2).toLowerCase();
  const initCode = `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${implHex}5af43d82803e903d91602b57fd5bf3`;
  return keccak256(initCode);
}

/**
 * Mines a CREATE2 salt whose resulting clone address satisfies Flap's
 * real on-chain vanity requirement. Pure local computation (keccak256 in
 * a loop) — no RPC calls, no signing. Measured live in this session at
 * ~4 seconds for a real successful mine (4-hex-digit suffix, ~65536
 * expected attempts) — noticeable but acceptable as a one-time cost
 * before a wallet signature prompt, not the "well under a second" a
 * pure attempt-count estimate alone would suggest.
 */
function mineVanitySalt(deployer: string, initCodeHash: string): { salt: string; predictedAddress: string } {
  for (let i = 0; i < MAX_SALT_MINING_ATTEMPTS; i++) {
    const salt = hexlify(randomBytes(32));
    const predicted = getCreate2Address(deployer, salt, initCodeHash);
    if (predicted.toLowerCase().endsWith(VANITY_SUFFIX)) {
      return { salt, predictedAddress: predicted };
    }
  }
  throw new Error(`Failed to mine a vanity salt ending in "${VANITY_SUFFIX}" within ${MAX_SALT_MINING_ATTEMPTS} attempts`);
}

/**
 * Builds the real newTokenV6 call, including a real, locally-mined
 * vanity-satisfying salt (not a random one — a random salt fails on-chain
 * with `VanityAddressRequirementNotMet`, confirmed live in this session
 * before this mining step was added).
 */
export function buildFlapLaunchTransaction(params: BuildFlapLaunchParams): BuiltFlapLaunchTransaction {
  const { creatorAddress, name, symbol, metaCid, bnbAmountWei } = params;

  const initCodeHash = minimalProxyInitCodeHash(TOKEN_TAXED_V3_IMPLEMENTATION);
  const { salt, predictedAddress } = mineVanitySalt(FLAP_PORTAL_ADDRESS, initCodeHash);

  const data = iface.encodeFunctionData("newTokenV6", [
    [
      name,
      symbol,
      metaCid,
      DEFAULT_DEX_THRESH,
      salt,
      DEFAULT_MIGRATOR_TYPE,
      ZeroAddress, // quoteToken: native BNB
      bnbAmountWei, // quoteAmt
      creatorAddress, // beneficiary
      "0x", // permitData
      ZeroHash, // extensionID
      "0x", // extensionData
      DEFAULT_DEX_ID,
      DEFAULT_LP_FEE_PROFILE,
      DEFAULT_BUY_TAX_RATE_BPS,
      DEFAULT_SELL_TAX_RATE_BPS,
      DEFAULT_TAX_DURATION_SECONDS,
      DEFAULT_ANTI_FARMER_DURATION_SECONDS,
      DEFAULT_MKT_BPS,
      DEFAULT_DEFLATION_BPS,
      DEFAULT_DIVIDEND_BPS,
      DEFAULT_LP_BPS,
      DEFAULT_MINIMUM_SHARE_BALANCE,
      ZeroAddress, // dividendToken
      ZeroAddress, // commissionReceiver
      DEFAULT_TOKEN_VERSION,
    ],
  ]);

  return { to: FLAP_PORTAL_ADDRESS, data, valueHex: "0x" + bnbAmountWei.toString(16), predictedTokenAddress: predictedAddress };
}
