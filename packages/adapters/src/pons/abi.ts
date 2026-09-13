/**
 * Minimal ABI fragments — only what this adapter actually decodes/calls —
 * copied verbatim (field names, types, indexed flags) from the real
 * artifacts fetched in this session:
 *   - V1: raw.githubusercontent.com/ponsdotdev/ponsfamily/main/abi.json
 *   - V2: raw.githubusercontent.com/ponsdotdev/ponsfamily/main/contractsV2/src/v2/PonsV2LaunchFactory.sol
 *         and .../interfaces/ILaunchpadV2.sol (for the LaunchedToken struct
 *         and GraduationPhase enum V2's getLaunchedToken() returns)
 *
 * Using ethers' human-readable ABI format (array of function/event
 * signature strings) rather than full JSON fragments — easier to eyeball
 * against the source above during review.
 */

export const PONS_V1_FACTORY_ABI = [
  "event TokenDeployed(address indexed token, address indexed deployer, address indexed dexFactory, address pairToken, uint256 dexId, uint256 launchConfigId)",
  "event TokenLaunched(address indexed token, address indexed deployer, address indexed dexFactory, address pairToken, address pool, uint256 dexId, uint256 launchConfigId, uint256 positionId, uint256 restrictionsEndBlock, uint256 initialBuyAmount)",
  "function graduationStatus(address token) view returns (uint256 pairedPrincipal, uint256 threshold, bool graduated)",
];

export const PONS_V2_FACTORY_ABI = [
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
  "event PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount)",
  // GraduationPhase enum ordinal: 0=NotGraduated, 1=Swept, 2=PoolCreated, 3=Rescued
  "function getLaunchedToken(address token) view returns (tuple(address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))",
];

/** Standard ERC-20 read functions — both V1 and V2 launch events omit name/symbol (only the launch tx's calldata has them), so this adapter reads them directly from the deployed token instead of parsing per-version calldata layouts. */
export const ERC20_MINIMAL_ABI = ["function name() view returns (string)", "function symbol() view returns (string)"];

export const GRADUATION_PHASE = {
  NotGraduated: 0,
  Swept: 1,
  PoolCreated: 2,
  Rescued: 3,
} as const;
