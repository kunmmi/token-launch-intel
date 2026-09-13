# Token Launch Intelligence — M0

Private real-time intelligence prototype observing Pons, Pump.fun, and Flap, normalizing launches into a common schema, and ranking them venue-relative (per the M0 design doc: read-only, no launch/execution capability).

## What's real vs. stubbed — read this before demoing anything

**Real and verified, end to end, against live mainnet — not simulated:**
- The Pump.fun adapter (`packages/adapters/src/pump/real-adapter.ts`) is a real implementation against the official `@pump-fun/pump-sdk`: it subscribes to live program logs, decodes real `CreateEvent`/`TradeEvent`/`CompleteEvent` events via Anchor's `EventParser`/`BorshCoder` against the SDK's own IDL, and reads real `BondingCurve`/`Global` accounts for graduation state.
- **The full pipeline — including trades and venue-relative percentiles — has been run against live mainnet data and observed working in the actual Next.js app.** Real launches and real trades were decoded, normalized, persisted to a real Postgres-compatible schema, aggregated into real unique-buyer counts, ranked into real venue×age-cohort percentiles, and rendered correctly on the Market and Token pages in a browser — including a token with 90 real buyers correctly surfacing at the 97th percentile against comparable launches. This is not a claim from reading the code — it was watched happening. See "Running it for real" below to reproduce.
- `@tli/analytics`' cohort percentile engine has passing unit tests proving the core IP claim: the same raw value (150 "buyers") ranks differently across venue distributions (PRD Section 9) — and this claim now holds with real trade data too, not just synthetic distributions in a unit test.
- `@tli/db`'s Drizzle schema generates valid, foreign-key-correct PostgreSQL migrations.
- Dependency versions were checked against `npm audit` and bumped off a critical Next.js RCE, a high-severity Drizzle SQL-injection advisory, and a broken `@pump-fun/pump-sdk` ESM build (worked around via `createRequire`, documented in `real-adapter.ts`) — none of that was shipped silently.

**A real bug this process caught (worth reading, not just the fix):**
`eventKindFor()` originally checked for camelCase event names (`"createEvent"`). Anchor's `EventParser` actually returns PascalCase (`"CreateEvent"`, exactly as declared in the IDL). Every real event was silently classified as `"unknown"` and dropped — the adapter would have run without errors while doing nothing. The original unit tests didn't catch it because they fabricated fixture data using the same wrong assumption. Caught only by listening to live mainnet logs and inspecting actual decoded names. Fixed, covered by a regression test, and re-verified against live mainnet. `packages/adapters/src/pump/__fixtures__/real-create-events.json` holds two genuine captured mainnet transactions (real signatures/mints, checkable on any Solana explorer) used as a network-independent regression fixture.

**A real, documented architectural compromise (not silently accepted as final):**
The M0 design doc calls for trades and percentile-engine state to live in a time-series store (ClickHouse), not Postgres — Postgres write-amplification under a continuous trade firehose was flagged as a real scaling risk in the original critique of this project. No ClickHouse client/schema work has been done yet, so `trades` and `percentile_engine_state` currently live in the same Postgres/PGlite database as everything else. This was a deliberate tradeoff to get a genuinely working end-to-end pipeline now rather than block on infra that doesn't exist — both tables are commented in place with "migrate before real volume" notes, not left as an unstated shortcut.

**Not real — explicitly stubbed, not faked:**
- `packages/adapters/src/{pons,flap}/real-adapter.ts` still throw on use. Pons has no hosted API (confirmed) and needs its V1/V2 factory ABIs; Flap needs its VaultPortal ABI per vault version (V6/V7 differ).
- No holder/concentration tracking (Distribution section of the Token page), Launch Quality, Launch Passport, Creator signature verification, Venue Fit, or any execution capability — all explicitly out of M0 scope per the design doc, or the next concrete slice of work.
- The percentile shown is computed live against a token's *current* age at render time, using whatever cohort data has been recorded for that exact age bucket — a token that ages into a bucket with no recorded data yet correctly shows "—" rather than fabricating a number. Observed directly in this session (a token showed 97th percentile on the Market page, then "—" a minute later on its Token page after aging into an emptier cohort bucket) — this is correct behavior given sparse demo data, not a bug, but worth understanding before reading percentiles from a lightly-seeded local demo as meaningful.
- The Solana ingestion latency spike from the M0 design doc (Geyser/Yellowstone vs plain RPC `onLogs`, needed to validate the P50<1s target) has not been run.
- Reconciliation (`reconcile()`) works but is empirically too slow against free public RPC (~1 `getTransaction` call/sec before 429s) to meet the P95<5s gap-recovery target — needs a dedicated RPC provider.

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
- `packages/db` — Drizzle ORM schema + migrations for relational entities (Venue, Chain, Token, Launch, Creator, CreatorAddress, VenueSystemAddress). Supports two drivers: real Postgres (production/Docker) or embedded PGlite (local dev/demo, no Docker — see below).
- `packages/analytics` — the streaming venue×age-bucket percentile engine (t-digest based).
- `packages/adapters` — real Pump.fun adapter; Pons/Flap stubs; a synthetic adapter for pipeline load-testing; the registry that picks between them.
- `services/indexer` — persistent worker, one process per venue (`VENUE` env var), not serverless.
- `services/normalizer` — consumes all three venue streams, writes to Postgres, feeds the percentile engine.
- `apps/web` — Next.js app: Market / Token / Creator pages.
- `scripts/` — verification/demo harnesses that run the real pipeline without needing Docker (see below).

## Running it for real (no Docker required)

The fastest way to see genuine live Pump.fun data in the actual app:

```bash
npm install
npm run build --workspace=@tli/core --workspace=@tli/db --workspace=@tli/adapters

# Listens to live Pump.fun mainnet logs for N seconds and writes real
# decoded launches into a persistent embedded Postgres (PGlite) at
# ./local-data/pglite. No Docker, no service, no admin rights.
node scripts/seed-live-pump-data.mjs 90

# Then run the web app against that same local data directory:
npm run dev:local --workspace=apps/web
# -> http://localhost:3000/market
```

`scripts/verify-live-pump-pipeline.mjs` runs the same real launch pipeline end-to-end against a throwaway in-memory PGlite instance and asserts the read-back matches what was decoded — a regression check for "does the real adapter + real schema + real persistence still actually work," runnable any time with zero setup: `node scripts/verify-live-pump-pipeline.mjs 40`. (It covers launches only; `seed-live-pump-data.mjs` is the one that also exercises trades and percentiles.)

PGlite is an embedded, single-process engine — don't run the seed script and the web app against the same `local-data/` directory concurrently. Run the seed script, let it finish, then start the app.

## Production / Docker setup

```bash
# 1. Start local infra
docker compose -f infra/docker-compose.yml up -d

# 2. Apply schema + seed reference data (chains/venues)
npm run db:generate
npm run db:migrate
npm run db:seed

# 3. Run indexer workers — one per venue. Pump can run in real `live` mode;
#    Pons/Flap only have synthetic mode until their adapters are built.
cross-env VENUE=pump ADAPTER_MODE=live npm run dev --workspace=services/indexer
npm run dev:indexer:pons   # synthetic only for now
npm run dev:indexer:flap   # synthetic only for now

# 4. Run the normalizer
npm run dev:normalizer

# 5. Run the web app against real Postgres
npm run dev:web
```

Set `DATABASE_URL` / `REDIS_URL` env vars to point at non-default hosts; defaults match `infra/docker-compose.yml`.

## Next concrete steps

1. Pull the Pons V1/V2 factory ABI (no hosted API — confirmed) and build its real adapter; same for Flap's VaultPortal ABI (handle V6/V7 vault versioning).
2. Move `trades` and `percentile_engine_state` to ClickHouse per the original design doc, before real launch volume — see the documented compromise above.
3. Add holder/concentration tracking (Distribution section) and a real Launch Quality score built on top of the now-working percentile engine.
4. Run the Solana latency spike (Geyser/Yellowstone vs `onLogs`) before trusting the P50<1s target.
5. Solve reconciliation-at-scale: free public RPC cannot sustain the gap-recovery throughput needed — needs a dedicated RPC provider or batched calls.
