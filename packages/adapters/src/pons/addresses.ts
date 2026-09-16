/**
 * Confirmed in this session against the primary sources, not guessed:
 *   - Factory addresses + ABI: raw.githubusercontent.com/ponsdotdev/ponsfamily
 *     (the repo's own README states "Always verify deployed bytecode against
 *     the verified sources before trusting an address" — these are copied
 *     verbatim from contract-meta.json / the README's "Deployed factories"
 *     table, not retyped from a summary).
 *   - Chain ID / RPC / WS endpoints: docs.robinhood.com/chain/connecting.
 */
export const PONS_V1_FACTORY_ADDRESS = "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB";
export const PONS_V2_FACTORY_ADDRESS = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";

/**
 * PonsV2LaunchAndBuy — a separate, verified helper contract (source
 * confirmed on robinhoodchain.blockscout.com, constructor arg 0 matches
 * PONS_V2_FACTORY_ADDRESS exactly) that real Pons launches route through
 * instead of calling the factory's launchToken directly. Its own doc
 * comment explains why: the factory can't fold a creator's first buy into
 * launchToken, so a bare launch leaves the curve live and public with the
 * creator's buy as a separate follow-up transaction — a real, documented
 * incident is cited (a launch's entire sellable allocation bought out by
 * 22 addresses in the two blocks after it opened, before the creator's own
 * buy landed). This contract closes that gap by launching and buying in
 * one atomic transaction — see packages/adapters/src/pons/launch.ts.
 */
export const PONS_V2_LAUNCH_AND_BUY_ADDRESS = "0xe33e9e479dF8802cb0866d5d05258bEc4cF62948";

export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_CHAIN_RPC_HTTP = "https://rpc.mainnet.chain.robinhood.com";
export const ROBINHOOD_CHAIN_RPC_WS = "wss://feed.mainnet.chain.robinhood.com";
