# Token Launch Intelligence — M0

Private real-time intelligence prototype observing Pons, Pump.fun, and Flap, normalizing launches into a common schema, and ranking them venue-relative (per the M0 design doc: read-only, no launch/execution capability).

## What's real vs. stubbed — read this before demoing anything

This is an early, actively-verified scaffold, not a finished product. Be precise about what's proven:

**Real and verified in this session:**
- Monorepo builds clean end-to-end (`npm run build`), including a full `next build`.
- `@tli/analytics`' cohort percentile engine has passing unit tests proving the core IP claim: the same raw value (150 "buyers") ranks differently across venue distributions (PRD Section 9).
- `@tli/db`'s Drizzle schema generates valid, foreign-key-correct PostgreSQL migrations.
- The synthetic 3-venue pipeline (indexer → Redis Streams → normalizer → Postgres → web) is fully wired and type-safe.
- Dependency versions were checked against `npm audit` and bumped off a critical Next.js RCE and a high-severity Drizzle SQL-injection advisory that the initial scaffold would otherwise have shipped with.

**Not real — explicitly stubbed, not faked:**
- `packages/adapters/src/{pump,pons,flap}/real-adapter.ts` all throw on use. Real chain integration needs: the official Pump.fun IDL, the Pons V1/V2 factory ABIs, the Flap VaultPortal ABI (per version — V6/V7 differ), and the Phase 0 latency spike (Geyser vs RPC subscription for Solana) from the M0 design doc. None of that was fabricated here.
- All market data in the UI when running in `synthetic` mode is randomly generated (`GenericSyntheticAdapter`) — useful for proving the pipeline shape, useless as a product demo to anyone outside this team.
- No trade ingestion, no holder/concentration tracking, no venue-relative percentile exposed via the API yet (the engine exists and is tested in isolation, but isn't wired to persist/serve through the web app).
- No Launch Passport, Creator signature verification, Venue Fit, or any execution capability — all explicitly out of M0 scope per the design doc.

**Not verified in this session (no Docker available in this sandbox):**
- Postgres/Redis/ClickHouse were never actually run. Schema correctness was verified via `drizzle-kit generate` (no live connection needed); the ingestion pipeline's runtime behavior against a real database has not been observed. Run `docker compose up` from `infra/` and walk through Quickstart below before trusting this beyond "it type-checks."

## Architecture

See the M0 design doc (in the originating conversation) for the full rationale. Summary:

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
- `packages/db` — Drizzle ORM schema + migrations for relational entities (Venue, Chain, Token, Launch, Creator, CreatorAddress, VenueSystemAddress).
- `packages/analytics` — the streaming venue×age-bucket percentile engine (t-digest based).
- `packages/adapters` — one real (unimplemented) + one synthetic adapter per venue, plus the registry that picks between them.
- `services/indexer` — persistent worker, one process per venue (`VENUE` env var), not serverless.
- `services/normalizer` — consumes all three venue streams, writes to Postgres, feeds the percentile engine.
- `apps/web` — Next.js app: Market / Token / Creator pages.

## Quickstart

```bash
# 1. Start local infra (requires Docker)
docker compose -f infra/docker-compose.yml up -d

# 2. Install deps (already done if you're reading this from the built repo)
npm install

# 3. Apply schema + seed reference data (chains/venues)
npm run db:generate
npm run db:migrate
npm run db:seed

# 4. Run three indexer workers (synthetic mode by default — real chain
#    integration is not implemented, see above)
npm run dev:indexer:pump
npm run dev:indexer:pons
npm run dev:indexer:flap

# 5. Run the normalizer
npm run dev:normalizer

# 6. Run the web app
npm run dev:web
# -> http://localhost:3000/market
```

Set `DATABASE_URL` / `REDIS_URL` env vars to point at non-default hosts; defaults match `infra/docker-compose.yml`.

## Next concrete steps (not started)

1. Pull real ABIs/IDLs (Pump.fun `@pump-fun/pump-sdk`, Pons `ponsdotdev/ponsfamily`, Flap `docs.flap.sh`) and implement one real adapter — recommend starting with Pons since it's confirmed to have no hosted API and is the highest-risk integration.
2. Run the Phase 0 Solana latency spike (Geyser/Yellowstone vs RPC subscription) before writing `PumpAdapter.discover()`.
3. Wire the percentile engine to persist digest state (ClickHouse, per the design doc) and expose it via the API/Market page.
4. Add trade ingestion (`normalizeTrade`) — currently only launches flow through the pipeline.
