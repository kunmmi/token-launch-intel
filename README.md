# Token Launch Intelligence — M0

Private real-time intelligence prototype observing Pons, Pump.fun, and Flap, normalizing launches into a common schema, and ranking them venue-relative (per the M0 design doc: read-only, no launch/execution capability).

## What's real vs. stubbed — read this before demoing anything

**Real and verified, end to end, against live mainnet — not simulated:**
- The Pump.fun adapter (`packages/adapters/src/pump/real-adapter.ts`) is a real implementation against the official `@pump-fun/pump-sdk`: it subscribes to live program logs, decodes real `CreateEvent`/`TradeEvent`/`CompleteEvent` events via Anchor's `EventParser`/`BorshCoder` against the SDK's own IDL, and reads real `BondingCurve`/`Global` accounts for graduation state.
- **The full pipeline has been run against live mainnet data and observed working in the actual Next.js app**: real Pump.fun launches were decoded, normalized, persisted to a real Postgres-compatible schema, and rendered correctly on the Market, Token, and Creator pages in a browser. This is not a claim from reading the code — it was watched happening. See "Running it for real" below to reproduce.
- `@tli/analytics`' cohort percentile engine has passing unit tests proving the core IP claim: the same raw value (150 "buyers") ranks differently across venue distributions (PRD Section 9).
- `@tli/db`'s Drizzle schema generates valid, foreign-key-correct PostgreSQL migrations.
- Dependency versions were checked against `npm audit` and bumped off a critical Next.js RCE, a high-severity Drizzle SQL-injection advisory, and a broken `@pump-fun/pump-sdk` ESM build (worked around via `createRequire`, documented in `real-adapter.ts`) — none of that was shipped silently.

**A real bug this process caught (worth reading, not just the fix):**
`eventKindFor()` originally checked for camelCase event names (`"createEvent"`). Anchor's `EventParser` actually returns PascalCase (`"CreateEvent"`, exactly as declared in the IDL). Every real event was silently classified as `"unknown"` and dropped — the adapter would have run without errors while doing nothing. The original unit tests didn't catch it because they fabricated fixture data using the same wrong assumption. Caught only by listening to live mainnet logs and inspecting actual decoded names. Fixed, covered by a regression test, and re-verified against live mainnet. `packages/adapters/src/pump/__fixtures__/real-create-events.json` holds two genuine captured mainnet transactions (real signatures/mints, checkable on any Solana explorer) used as a network-independent regression fixture.

**Not real — explicitly stubbed, not faked:**
- `packages/adapters/src/{pons,flap}/real-adapter.ts` still throw on use. Pons has no hosted API (confirmed) and needs its V1/V2 factory ABIs; Flap needs its VaultPortal ABI per vault version (V6/V7 differ).
- No trade ingestion is wired into the normalizer yet (the Pump adapter can decode real trades — `normalizeTrade` works and is tested — but the normalizer service only processes `kind: "launch"` events today).
- No venue-relative percentile is exposed via the API/Market page yet — the engine is real and tested in isolation (`packages/analytics`), but its output isn't persisted or served through the web app.
- No Launch Passport, Creator signature verification, Venue Fit, or any execution capability — all explicitly out of M0 scope per the design doc.
- The Solana ingestion latency spike from the M0 design doc (Geyser/Yellowstone vs plain RPC `onLogs`, needed to validate the P50<1s target) has not been run.
- Reconciliation (`reconcile()`) works but is empirically too slow against free public RPC (~1 `getTransaction` call/sec before 429s) to meet the P95<5s gap-recovery target — needs a dedicated RPC provider.

## Architecture

```
indexer (per venue, VENUE=pump|pons|flap) --publish--> Redis Streams
                                                             |
                                                        normalizer (consumer group)
                                                             |
                                                    Postgres (entities) + percentile engine (in-memory, not yet persisted)
                                                             |
                                                        apps/web (Next.js, reads Postgres directly)
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

`scripts/verify-live-pump-pipeline.mjs` runs the same real pipeline end-to-end against a throwaway in-memory PGlite instance and asserts the read-back matches what was decoded — a regression check for "does the real adapter + real schema + real persistence still actually work," runnable any time with zero setup: `node scripts/verify-live-pump-pipeline.mjs 40`.

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

1. Wire trade ingestion into the normalizer (`normalizeTrade` already works for Pump) and feed real buyer/seller counts into the percentile engine — currently the Market page's Buyers column is empty for real data because nothing computes it yet.
2. Persist the percentile engine's digest state and expose it through the API/Market page — the single biggest piece of differentiated IP (PRD Section 9) isn't visible in the UI yet.
3. Pull the Pons V1/V2 factory ABI (no hosted API — confirmed) and build its real adapter; same for Flap's VaultPortal ABI (handle V6/V7 vault versioning).
4. Run the Solana latency spike (Geyser/Yellowstone vs `onLogs`) before trusting the P50<1s target.
5. Solve reconciliation-at-scale: free public RPC cannot sustain the gap-recovery throughput needed — needs a dedicated RPC provider or batched calls.
