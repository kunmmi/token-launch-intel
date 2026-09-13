import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";

/**
 * Persisted state for @tli/analytics' CohortPercentileEngine, so the web
 * app can compute "what percentile is this token's buyer count" without
 * being in the same process as the normalizer (which is where the engine
 * actually runs and updates).
 *
 * Single-row table (id is always "singleton") holding the engine's full
 * serializeAll() output as one JSON blob. This is a deliberately simple
 * M0 choice — one row, rewritten whole on every update — over a
 * per-cohort-key table, because at M0 data volume the entire serialized
 * state is small (t-digest centroids are compact) and simplicity here
 * matters more than avoiding redundant writes. Revisit if/when the engine
 * tracks enough cohorts×metrics for whole-blob rewrites to matter.
 */
export const percentileEngineState = pgTable("percentile_engine_state", {
  id: text("id").primaryKey(),
  state: jsonb("state").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const PERCENTILE_ENGINE_SINGLETON_ID = "singleton";
