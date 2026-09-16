import { JsonRpcProvider, Contract, Interface, ZeroAddress, ZeroHash, randomBytes, hexlify } from "ethers";
import { PONS_V2_LAUNCH_AND_BUY_ABI, PONS_V2_FACTORY_LAUNCH_FEE_ABI } from "./abi.js";
import { PONS_V2_FACTORY_ADDRESS, PONS_V2_LAUNCH_AND_BUY_ADDRESS, ROBINHOOD_CHAIN_RPC_HTTP } from "./addresses.js";

/**
 * Real Pons coin-creation transaction builder — the write-side counterpart
 * to real-adapter.ts. Unlike Flap, Pons's launch contracts are open source
 * (github.com/ponsdotdev/ponsfamily), which made this genuinely easier to
 * get right: the exact `launchToken`/`launchAndBuy` signatures, the
 * `TokenParams`/`LaunchConfig` structs, and every validation rule below
 * were read directly from verified source, not reverse-engineered from
 * calldata the way Flap's were. Still independently confirmed against real
 * on-chain state and a real transaction before being trusted:
 *
 *   - `launchConfigCount()` on the real factory (0x7eD598...01EC7e) returns
 *     1, and `getLaunchConfig(0)` returns `enabled: true` — the only real
 *     launch config, used here as LAUNCH_CONFIG_ID.
 *   - `launchFee()` was read live (0.0005 native ETH at the time of
 *     writing) rather than hardcoded, since it's an owner-adjustable state
 *     variable (`setLaunchFee`) — a stale hardcoded value would make every
 *     launch revert with `LaunchFeeNotPaid` the moment it changed.
 *   - `canLaunch(<arbitrary address>)` returns true — the public launch
 *     gate is open, no allowlist blocks a normal creator.
 *
 * WHY PonsV2LaunchAndBuy, not the factory's own `launchToken` directly:
 * confirmed via a real, decoded `launchAndBuy` transaction
 * (0xc640fe3f...87522c) that this is the path real Pons launches actually
 * use, and PonsV2LaunchAndBuy.sol's own doc comment explains why — the
 * factory can't fold a creator's first buy into `launchToken`, so a bare
 * launch leaves the curve live and public with the creator's own buy as a
 * separate follow-up transaction. The contract's comment cites a real
 * incident: a launch's entire sellable allocation bought out by 22
 * addresses in the two blocks after it opened, before the creator's buy
 * landed. This project launches through the same atomic path real users
 * do, not the riskier bare path just because it has fewer parameters.
 *
 * Simplifications made deliberately, not by oversight:
 *   - `expectedEconomics` is set to bytes32(0), which both contracts treat
 *     as "skip the economics-pinning check" (confirmed in
 *     PonsV2LaunchFactory's real source: `if (params.expectedEconomics !=
 *     bytes32(0) && params.expectedEconomics != economics) revert(...)`)
 *     rather than calling `previewLaunchEconomics` first — real launches
 *     do sometimes pin it, but skipping is an explicit, intended code path
 *     in the contract itself, not a hack.
 *   - `minTokensOut` is 0. Unlike a buy against an existing curve, this is
 *     safe here specifically because the buy is atomic with the curve's
 *     own creation in the same transaction — the curve has no prior state
 *     and no other transaction can execute between creation and this buy,
 *     so there's nothing to sandwich.
 *   - `salt` is a fresh random bytes32 per launch. Unlike Flap, Pons has no
 *     vanity-address requirement (confirmed in PonsV2LaunchDeployer.sol's
 *     source — CREATE2 salt is caller-chosen with no suffix check), so no
 *     mining loop is needed; the only real constraint is not reusing an
 *     exact (salt, config) pair the factory has already deployed, which a
 *     fresh random 32 bytes avoids with overwhelming probability.
 *   - `snipeTaxExemptions` is empty — this app only builds a single
 *     creator's own launch+buy, not a multi-wallet bundle.
 *   - `pairToken` is always the zero address (native ETH quote) — the only
 *     case this file builds, matching Pump's and Flap's SOL/BNB-quoted
 *     scope.
 *
 * SECURITY DESIGN, same as Pump's and Flap's launch.ts: this returns
 * unsigned transaction PARAMETERS ({to, data, value}) for the client's own
 * wallet to sign and send via eth_sendTransaction. This file never holds,
 * generates, or needs any private key.
 */

const LAUNCH_CONFIG_ID = 0n;

export interface BuildPonsLaunchParams {
  /** The creator's wallet — becomes creatorFeeRecipient, the token recipient, and the transaction's real signer. Never a private key. */
  creatorAddress: string;
  name: string;
  symbol: string;
  /** A real, hosted https URL — Pons's TokenParams.logo takes a plain URL directly (confirmed against a real launch's decoded calldata), unlike Flap's bare-CID convention. */
  logoUrl: string;
  description: string;
  /** Optional social link; every real launch observed left the other four Socials fields ("telegram","discord","website","farcaster") empty, so this is the only one exposed here. */
  twitterUrl: string;
  /** Basis points, 0-1000 (factory's real maxCreatorTaxBps ceiling). */
  creatorTaxBps: number;
  /** Initial buy size, in wei of native ETH — separate from the launch fee, which this function adds on top automatically (see PonsV2LaunchAndBuy's real `NativeValueMismatch` check: msg.value must equal launchFee + quoteIn exactly). */
  quoteInWei: bigint;
}

export interface BuiltPonsLaunchTransaction {
  to: string;
  data: string;
  valueHex: string;
  launchFeeWei: string;
}

export async function buildPonsLaunchTransaction(params: BuildPonsLaunchParams): Promise<BuiltPonsLaunchTransaction> {
  const provider = new JsonRpcProvider(ROBINHOOD_CHAIN_RPC_HTTP);
  const factory = new Contract(PONS_V2_FACTORY_ADDRESS, PONS_V2_FACTORY_LAUNCH_FEE_ABI, provider);
  const launchFee = (await factory.launchFee!()) as bigint;

  const salt = hexlify(randomBytes(32));
  const iface = new Interface(PONS_V2_LAUNCH_AND_BUY_ABI);

  const data = iface.encodeFunctionData("launchAndBuy", [
    [
      params.name,
      params.symbol,
      params.logoUrl,
      params.description,
      [params.twitterUrl, "", "", "", ""], // socials: twitter, telegram, discord, website, farcaster
      params.creatorAddress, // creatorFeeRecipient
      params.creatorTaxBps,
      false, // buybackEnabled
      ZeroHash, // expectedEconomics — bytes32(0) skips the economics-pinning check, a real supported path
      salt,
    ],
    LAUNCH_CONFIG_ID,
    ZeroAddress, // pairToken — native ETH quote
    params.quoteInWei,
    0n, // minTokensOut — safe here; see this file's header
    params.creatorAddress, // recipient
    [], // snipeTaxExemptions
  ]);

  const value = launchFee + params.quoteInWei;
  return { to: PONS_V2_LAUNCH_AND_BUY_ADDRESS, data, valueHex: "0x" + value.toString(16), launchFeeWei: launchFee.toString() };
}
