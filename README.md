# Token Launch Intelligence — M0

Private real-time intelligence prototype observing Pons, Pump.fun, and Flap, normalizing launches into a common schema, and ranking them venue-relative (per the M0 design doc: read-only, no launch/execution capability).

**GitHub:** https://github.com/kunmmi/token-launch-intel (private)

## What's real vs. stubbed — read this before demoing anything

**Two of three venues have real, verified adapters — not simulated:**
- **Pump.fun** (`packages/adapters/src/pump/real-adapter.ts`) — real implementation against the official `@pump-fun/pump-sdk`: subscribes to live program logs, decodes real `CreateEvent`/`TradeEvent`/`CompleteEvent` via Anchor's `EventParser`/`BorshCoder` against the SDK's own IDL, reads real `BondingCurve`/`Global` accounts for graduation state.
- **Pons** (`packages/adapters/src/pons/real-adapter.ts`) — real implementation against both live factory contracts (V1: Uniswap V3 CREATE2 factory; V2: bonding curve → Uniswap V4), built against event signatures and struct layouts pulled directly from the verified Solidity source at `ponsdotdev/ponsfamily` (not a summary — the exact ABI fragments are cited against source line numbers in `abi.ts`). Confirmed empirically that V1 is dormant (zero `TokenDeployed` events in the last 50,000 blocks) while V2 is highly active.
- **Flap** — still a stub. Needs its VaultPortal ABI per vault version (V6/V7 differ).

**The full pipeline — both real venues, trades, and venue-relative percentiles — has been run against live mainnet data simultaneously and observed working in the actual Next.js app.** Real Pump.fun and Pons launches were decoded concurrently, normalized, persisted to a real Postgres-compatible schema, and rendered correctly on Market/Token/Creator pages — including a live example of exactly what PRD Section 13 describes: one Pons wallet's full evidence trail (12 tokens launched in ~13 minutes, all copies of a trending meme) surfaced with zero synthetic data. This is not a claim from reading the code — it was watched happening. See "Running it for real" below to reproduce.

`@tli/analytics`' cohort percentile engine has passing unit tests proving the core IP claim (PRD Section 9): the same raw value ranks differently across venue distributions — verified with a real example too: a Pump token with 90 real buyers correctly surfaced at the 97th percentile against comparable launches.

Dependency versions were checked against `npm audit` and bumped off a critical Next.js RCE, a high-severity Drizzle SQL-injection advisory, and a broken `@pump-fun/pump-sdk` ESM build (worked around via `createRequire`) — none of that was shipped silently.

**Two real bugs this process caught (worth reading, not just the fixes):**
1. `eventKindFor()` for Pump originally checked for camelCase event names (`"createEvent"`). Anchor's `EventParser` actually returns PascalCase (`"CreateEvent"`, exactly as declared in the IDL). Every real event was silently classified as `"unknown"` and dropped — the adapter would have run without errors while doing nothing. Caught by listening to live mainnet logs and inspecting actual decoded names, not by the original (self-consistently-wrong) unit tests. `packages/adapters/src/pump/__fixtures__/real-create-events.json` holds two genuine captured mainnet transactions used as a regression fixture.
2. Pons's decoded event args came through as `undefined` for every field. ethers' `Result` object only exposes numeric positional indices via `Object.keys()`/`Object.entries()` — named fields exist only via direct property access, a non-obvious quirk that a naive `Object.entries()` walk silently produces an empty object for. Fixed by reading each field explicitly via the event fragment's own parameter list. `packages/adapters/src/pons/__fixtures__/real-v2-token-launched.json` holds two genuine captured Robinhood Chain transactions used as a regression fixture.

**A real, documented architectural compromise (not silently accepted as final):**
The M0 design doc calls for trades and percentile-engine state to live in a time-series store (ClickHouse), not Postgres. No ClickHouse client/schema work has been done yet, so `trades` and `percentile_engine_state` currently live in the same Postgres/PGlite database as everything else — a deliberate tradeoff to get a genuinely working end-to-end pipeline now rather than block on infra that doesn't exist. Both tables carry "migrate before real volume" comments, not an unstated shortcut.

**A real, documented protocol-discovery finding:**
Robinhood's own docs advertise `wss://feed.mainnet.chain.robinhood.com` as "the WebSocket endpoint." Connecting to it and inspecting the raw frames in this session showed it is **not** a standard `eth_subscribe` JSON-RPC feed — it streams Arbitrum Orbit's proprietary sequencer-feed protocol (raw L2 batch data), undocumented for third-party consumption and unparseable by ethers. `PonsAdapter.discover()` polls `eth_getLogs` on the standard HTTP RPC instead — verified working, at the cost of poll-interval latency rather than push latency.

**Not real — explicitly stubbed, not faked:**
- `packages/adapters/src/flap/real-adapter.ts` still throws on use.
- `PonsAdapter.normalizeTrade()` throws — Pons trades happen on per-launch pool/curve contracts, not the factories this adapter watches; not wired up in this pass.
- No holder/concentration tracking (Distribution section of the Token page), Launch Quality, Launch Passport, Creator signature verification, Venue Fit, or any execution capability — all explicitly out of M0 scope per the design doc, or the next concrete slice of work.
- The percentile shown is computed live against a token's *current* age at render time, using whatever cohort data has been recorded for that exact age bucket — a token that ages into a bucket with no recorded data yet correctly shows "—" rather than fabricating a number. Observed directly in this session, not a bug.
- The Solana/Pons ingestion latency spikes from the M0 design doc (Geyser/Yellowstone vs plain RPC for Pump; poll-interval tuning for Pons) have not been run.
- Reconciliation (`reconcile()`) works for Pump but is empirically too slow against free public RPC (~1 `getTransaction` call/sec before 429s) to meet the P95<5s gap-recovery target. Pons's `reconcile()` is real (uses `eth_getLogs` directly, no per-transaction fetching) but untested against real rate limits in this session.
- Pons's V2 graduation progress is a coarse 3-value proxy (0 / 0.5 / 1) derived from the `GraduationPhase` enum, not the bonding curve's actual fill percentage — reading that needs the `PonsV2BondingCurve` contract's own ABI, not fetched in this pass.

## Architecture

```
indexer (per venue, VENUE=pump|pons|flap) --publish--> Redis Streams
                                                             |
                                                        normalizer (consumer group)
                                                             |
                                          Postgres (entities + trades) + percentile engine
                                          (persisted to Postgres every 5s — see "compromise" note above)
                                                             |
                                                        apps/web (Next.js, reads Postgres directly,
                                                        computes percentiles from persisted engine state)
```

- `packages/core` — normalization spec constants (age buckets, cohort keys), Zod schemas, the `VenueAdapter` interface, the Redis Streams event bus.
- `packages/db` — Drizzle ORM schema + migrations for relational entities (Venue, Chain, Token, Launch, Creator, CreatorAddress, VenueSystemAddress, Trade, percentile engine state). Supports two drivers: real Postgres (production/Docker) or embedded PGlite (local dev/demo, no Docker — see below).
- `packages/analytics` — the streaming venue×age-bucket percentile engine (t-digest based).
- `packages/adapters` — real Pump.fun + Pons adapters; Flap stub; a synthetic adapter for pipeline load-testing; the registry that picks between them.
- `services/indexer` — persistent worker, one process per venue (`VENUE` env var), not serverless.
- `services/normalizer` — consumes all three venue streams, writes to Postgres, feeds the percentile engine.
- `apps/web` — Next.js app: Market / Token / Creator pages.
- `scripts/` — verification/demo harnesses that run the real pipeline without needing Docker (see below).

## Running it for real (no Docker required)

The fastest way to see genuine live cross-venue data in the actual app:

```bash
npm install
npm run build --workspace=@tli/core --workspace=@tli/db --workspace=@tli/adapters --workspace=@tli/analytics

# Listens to live Pump.fun (Solana) and Pons (Robinhood Chain) simultaneously
# for N seconds and writes real decoded launches (+ Pump trades/percentiles)
# into a persistent embedded Postgres (PGlite) at ./local-data/pglite.
# No Docker, no service, no admin rights.
node scripts/seed-live-data.mjs 90

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

# 3. Run indexer workers — one per venue. Pump and Pons can run in real
#    `live` mode; Flap only has synthetic mode until its adapter is built.
cross-env VENUE=pump ADAPTER_MODE=live npm run dev --workspace=services/indexer
cross-env VENUE=pons ADAPTER_MODE=live npm run dev --workspace=services/indexer
npm run dev:indexer:flap   # synthetic only for now

# 4. Run the normalizer
npm run dev:normalizer

# 5. Run the web app against real Postgres
npm run dev:web
```

Set `DATABASE_URL` / `REDIS_URL` env vars to point at non-default hosts; defaults match `infra/docker-compose.yml`.

## Next concrete steps

1. Pull Flap's VaultPortal ABI (handle V6/V7 vault versioning) and build its real adapter — the last of the three venues.
2. Wire Pons trade ingestion (needs per-launch pool/curve contract subscriptions, not just the factories).
3. Move `trades` and `percentile_engine_state` to ClickHouse per the original design doc, before real launch volume.
4. Add holder/concentration tracking (Distribution section) and a real Launch Quality score built on top of the now-working percentile engine.
5. Run the latency spikes: Geyser/Yellowstone vs `onLogs` for Pump; poll-interval tuning for Pons.
6. Solve reconciliation-at-scale for Pump: free public RPC cannot sustain the gap-recovery throughput needed — needs a dedicated RPC provider or batched calls. Load-test Pons's `reconcile()` similarly (untested against real rate limits).
