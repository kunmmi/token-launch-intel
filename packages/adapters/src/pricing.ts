/**
 * Free, no-auth USD price feed for native chain assets (SOL, BNB), via
 * CoinGecko's public `simple/price` endpoint — verified live in this
 * session to work with no API key. This is the missing piece that was
 * blocking every `normalizeTrade`'s `priceUsd` (previously hardcoded null
 * across all three venues, documented as "Level 3 enrichment... not wired
 * up").
 *
 * Cached with a short TTL rather than fetched per trade: CoinGecko's
 * anonymous tier is rate-limited, and a live trade firehose (Pump alone
 * was observed at ~900+ trades/90s earlier in this project) would exhaust
 * it in seconds otherwise. A stale cached price is used on a fetch failure
 * rather than flipping priceUsd to null on a transient network error —
 * "slightly stale" is a better failure mode here than "flickers to
 * unavailable every time CoinGecko has a bad second."
 */

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { price: number; fetchedAt: number }>();

async function fetchUsdPrice(coingeckoId: string): Promise<number | null> {
  const cached = cache.get(coingeckoId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.price;

  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=usd`);
    if (!res.ok) return cached?.price ?? null;
    const json = (await res.json()) as Record<string, { usd?: number }>;
    const price = json[coingeckoId]?.usd;
    if (typeof price !== "number") return cached?.price ?? null;
    cache.set(coingeckoId, { price, fetchedAt: Date.now() });
    return price;
  } catch {
    return cached?.price ?? null; // network error — fall back to last known price rather than null
  }
}

/** SOL/USD, for pricing Pump trades quoted in native SOL. */
export function getSolUsdPrice(): Promise<number | null> {
  return fetchUsdPrice("solana");
}

/** BNB/USD, for pricing Flap trades (quoted in native BNB despite the ABI's "eth"-named field — see flap/real-adapter.ts). */
export function getBnbUsdPrice(): Promise<number | null> {
  return fetchUsdPrice("binancecoin");
}
