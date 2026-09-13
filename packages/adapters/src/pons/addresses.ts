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

export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_CHAIN_RPC_HTTP = "https://rpc.mainnet.chain.robinhood.com";
export const ROBINHOOD_CHAIN_RPC_WS = "wss://feed.mainnet.chain.robinhood.com";
