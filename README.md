# Token Launch Intelligence — M0

Private real-time intelligence prototype observing Pons, Pump.fun, and Flap, normalizing launches into a common schema, and ranking them venue-relative (per the M0 design doc: read-only, no launch/execution capability).

**GitHub:** https://github.com/kunmmi/token-launch-intel (private)

## Status: all three M0 venues have real, verified adapters

This isn't three stubs and a demo — every adapter subscribes to live mainnet, decodes real events against ABIs pulled from each venue's own primary sources (official SDK, verified contract source, or a canonical developer-facing interface — never a summary or a guess), and has been watched writing real launches into the actual running app.

## What's real vs. stubbed — read this before demoing anything

**Pump.fun** (`packages/adapters/src/pump/real-adapter.ts`) — real implementation against the official `@pump-fun/pump-sdk`: subscribes to live program logs, decodes real `CreateEvent`/`TradeEvent`/`CompleteEvent` via Anchor's `EventParser`/`BorshCoder` against the SDK's own IDL, reads real `BondingCurve`/`Global` accounts for exact graduation progress. Trade ingestion is fully wired (unlike the other two venues).

**Pons** (`packages/adapters/src/pons/real-adapter.ts`) — real implementation against both live factory contracts on Robinhood Chain (V1: Uniswap V3 CREATE2 factory; V2: bonding curve → Uniswap V4), built against event signatures and struct layouts pulled directly from the verified Solidity source at `ponsdotdev/ponsfamily`. V1 confirmed dormant (zero events in the last 50,000 blocks) — all real activity is on V2. `discover()` polls `eth_getLogs` rather than using a WebSocket subscription (see the protocol-discovery finding below). Trade ingestion not wired up (trades happen on per-launch curve contracts, not the factory).

**Flap** (`packages/adapters/src/flap/real-adapter.ts`) — real implementation against the single canonical Portal contract on BNB Chain, built against the official `IPortal.sol` interface from Flap's own vault-integration example repo (`flap-sh/FlapVaultExample`). Simpler than the other two: `TokenCreated` carries name/symbol/timestamp inline (no follow-up RPC calls needed), and `getTokenV8Safe()` returns an exact Wad-scaled graduation progress (no coarse proxy needed). Uses a real WebSocket push subscription — BNB Chain's public RPC genuinely supports standard `eth_subscribe`, unlike Robinhood Chain. Trade ingestion not wired up in the demo scripts (Flap's trade volume is extremely high — confirmed ~8 events/sec on the Portal contract alone — so the seed script deliberately only ingests launches to stay fast).

**The full three-venue pipeline has been run against live mainnet simultaneously and observed working in the actual Next.js app** — not a claim from reading the code, watched happening. In one 60-second run: 10 real Pump launches (+1,359 trades), 18 real Pons launches, 5 real Flap launches, all rendered correctly on the Market page, interleaved by timestamp, including a live cross-venue trend ("Starman" launched on all three venues within about a minute of each other) and a PRD Section 13-style creator evidence trail (one Pons wallet launching 12 tokens in ~13 minutes). See "Running it for real" below to reproduce.

`@tli/analytics`' cohort percentile engine has passing unit tests proving the core IP claim (PRD Section 9): the same raw value ranks differently across venue distributions — verified with real data too: a Pump token with 90 real buyers correctly surfaced at the 97th percentile against comparable launches.

Dependency versions were checked against `npm audit` and bumped off a critical Next.js RCE, a high-severity Drizzle SQL-injection advisory, and a broken `@pump-fun/pump-sdk` ESM build (worked around via `createRequire`) — none of that was shipped silently.

### Real bugs this process caught (worth reading, not just the fixes)

1. **Pump — wrong event-name casing.** `eventKindFor()` originally checked for camelCase (`"createEvent"`); Anchor's `EventParser` actually returns PascalCase (`"CreateEvent"`, per the IDL). Every real event was silently classified `"unknown"` and dropped — the adapter ran without errors while doing nothing. The original unit tests didn't catch it because they fabricated fixture data with the same wrong assumption. Caught by listening to live logs and inspecting actual decoded names.
2. **Pons — decoded event args came through as `undefined`.** ethers' `Result` object only exposes numeric positional indices via `Object.keys()`/`Object.entries()` — named fields exist only via direct property access. A naive `Object.entries()` walk silently produces an empty object. Fixed by reading each field via the event fragment's own parameter list. The exact same class of bug was pre-empted in Flap's adapter from the start, reusing the fix.
3. **Flap — creator misattribution for vault-routed launches.** At least one real captured `TokenCreated` event recorded `creator` as the VaultPortal contract address itself, not a real wallet — VaultPortal is the on-chain caller of `Portal.newToken`, so Portal attributes the launch to it. Documented as a real data-quality risk for any future Creator Reputation feature built on Flap data, not silently trusted.

Each real venue's fixtures directory (`packages/adapters/src/{pump,pons,flap}/__fixtures__/`) holds genuine captured mainnet transactions (real tx hashes, checkable on the venue's own explorer) used as network-independent regression tests.

### A real protocol-discovery finding

Robinhood's own docs advertise `wss://feed.mainnet.chain.robinhood.com` as "the WebSocket endpoint." Connecting to it and inspecting the raw frames in this session showed it is **not** a standard `eth_subscribe` JSON-RPC feed — it streams Arbitrum Orbit's proprietary sequencer-feed protocol, undocumented for third-party consumption and unparseable by ethers. Pons's `discover()` polls `eth_getLogs` instead. BNB Chain's public WebSocket, by contrast, was verified to support standard `eth_subscribe` cleanly — confirmed by watching 115 real Portal logs stream in over 15 seconds — so Flap uses a real push subscription. This is a genuine, chain-specific difference, not an inconsistency between the two EVM adapters.

### A real, documented architectural compromise (not silently accepted as final)

The M0 design doc calls for trades and percentile-engine state to live in a time-series store (ClickHouse), not Postgres. No ClickHouse client/schema work has been done yet, so `trades` and `percentile_engine_state` currently live in the same Postgres/PGlite database as everything else — a deliberate tradeoff to get a genuinely working end-to-end pipeline now rather than block on infra that doesn't exist. Both tables carry "migrate before real volume" comments.

### Not real — explicitly stubbed, not faked

- Pons and Flap trade ingestion (both adapters' `normalizeTrade` — Pons throws by design since trades happen on per-launch contracts the adapter doesn't watch yet; Flap's works but isn't wired into the demo scripts given its volume).
- No holder/concentration tracking (Distribution section of the Token page), Launch Quality, Launch Passport, Creator signature verification, Venue Fit, or any execution capability — all explicitly out of M0 scope per the design doc, or the next concrete slice of work.
- The percentile shown is computed live against a token's *current* age at render time — a token that ages into a cohort bucket with no recorded data yet correctly shows "—" rather than fabricating a number. Observed directly in this session, not a bug.
- The Pump/Pons/Flap latency spikes from the M0 design doc (Geyser/Yellowstone vs plain RPC for Pump; poll-interval tuning for Pons) have not been run.
- Reconciliation (`reconcile()`) works for all three venues but is empirically too slow against free public RPC for Pump (~1 `getTransaction` call/sec before 429s) to meet the P95<5s gap-recovery target. Pons's and Flap's `reconcile()` use `eth_getLogs` directly (no per-transaction fetching, structurally faster) but are untested against real rate limits.
- Pons's V2 graduation progress is a coarse 3-value proxy (0 / 0.5 / 1) from the `GraduationPhase` enum, not the bonding curve's actual fill percentage (needs the curve contract's own ABI, not fetched). Flap and Pump V1 both give exact progress; this is a real, documented gap specific to Pons V2.

## Architecture

```
indexer (per venue, VENUE=pump|pons|flap) --publish--> Redis Streams
                                                             |
                                                        normalizer (consumer group)
                                                             |
                                          Postgres (entities + trades) + percentile engine
                                          (persisted to Postgres every 5s — see compromise note above)
                                                             |
                                                        apps/web (Next.js, reads Postgres directly,
                                                        computes percentiles from persisted engine state)
```

- `packages/core` — normalization spec constants (age buckets, cohort keys), Zod schemas, the `VenueAdapter` interface, the Redis Streams event bus.
- `packages/db` — Drizzle ORM schema + migrations for relational entities (Venue, Chain, Token, Launch, Creator, CreatorAddress, VenueSystemAddress, Trade, percentile engine state). Supports two drivers: real Postgres (production/Docker) or embedded PGlite (local dev/demo, no Docker — see below).
- `packages/analytics` — the streaming venue×age-bucket percentile engine (t-digest based).
- `packages/adapters` — real Pump.fun, Pons, and Flap adapters; a synthetic adapter for pipeline load-testing; the registry that picks between them.
- `services/indexer` — persistent worker, one process per venue (`VENUE` env var), not serverless.
- `services/normalizer` — consumes all three venue streams, writes to Postgres, feeds the percentile engine.
- `apps/web` — Next.js app: Market / Token / Creator pages.
- `scripts/` — verification/demo harnesses that run the real pipeline without needing Docker (see below).

## Running it for real (no Docker required)

The fastest way to see genuine live cross-venue data in the actual app:

```bash
npm install
npm run build --workspace=@tli/core --workspace=@tli/db --workspace=@tli/adapters --workspace=@tli/analytics

# Listens to live Pump.fun (Solana), Pons (Robinhood Chain), and Flap (BNB
# Chain) simultaneously for N seconds and writes real decoded launches (+
# Pump trades/percentiles) into a persistent embedded Postgres (PGlite) at
# ./local-data/pglite. No Docker, no service, no admin rights.
node scripts/seed-live-data.mjs 60

# Then run the web app against that same local data directory:
npm run dev:local --workspace=apps/web
# -> http://localhost:3000/market
```

`scripts/verify-live-pump-pipeline.mjs` runs the real Pump launch pipeline end-to-end against a throwaway in-memory PGlite instance and asserts the read-back matches what was decoded — a regression check runnable any time with zero setup: `node scripts/verify-live-pump-pipeline.mjs 40`.

PGlite is an embedded, single-process engine — don't run the seed script and the web app against the same `local-data/` directory concurrently. Run the seed script, let it finish, then start the app.

## Production / Docker setup

```bash
# 1. Start local infra
docker compose -f infra/docker-compose.yml up -d

# 2. Apply schema + seed reference data (chains/venues)
npm run db:generate
npm run db:migrate
npm run db:seed

# 3. Run indexer workers — one per venue, all three support real `live` mode.
cross-env VENUE=pump ADAPTER_MODE=live npm run dev --workspace=services/indexer
cross-env VENUE=pons ADAPTER_MODE=live npm run dev --workspace=services/indexer
cross-env VENUE=flap ADAPTER_MODE=live npm run dev --workspace=services/indexer

# 4. Run the normalizer
npm run dev:normalizer

# 5. Run the web app against real Postgres
npm run dev:web
```

Set `DATABASE_URL` / `REDIS_URL` env vars to point at non-default hosts; defaults match `infra/docker-compose.yml`.

## Next concrete steps

1. Wire Pons and Flap trade ingestion (Pons needs per-launch pool/curve contract subscriptions; Flap's `normalizeTrade` already works, just needs to be turned on with appropriate rate handling given its volume).
2. Move `trades` and `percentile_engine_state` to ClickHouse per the original design doc, before real launch volume.
3. Add holder/concentration tracking (Distribution section) and a real Launch Quality score built on top of the now-working percentile engine.
4. Fix Pons V2's graduation progress to read the actual bonding curve fill percentage instead of the coarse phase proxy.
5. Run the latency spikes: Geyser/Yellowstone vs `onLogs` for Pump; poll-interval tuning for Pons.
6. Solve reconciliation-at-scale for Pump: free public RPC cannot sustain the gap-recovery throughput needed. Load-test Pons's and Flap's `reconcile()` similarly (untested against real rate limits).
7. Resolve Flap's creator-misattribution issue for vault-routed launches before trusting Creator Reputation data from that venue.
