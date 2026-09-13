import { test } from "node:test";
import assert from "node:assert/strict";
import { CohortPercentileEngine } from "./percentile-engine.js";

test("cold start returns null before any data recorded", () => {
  const engine = new CohortPercentileEngine();
  const rank = engine.percentileRankOf("pump", 60, "unique_buyers", 100);
  assert.equal(rank, null);
});

test("a value near the top of its cohort gets a high percentile rank", () => {
  const engine = new CohortPercentileEngine();
  for (let i = 1; i <= 100; i++) {
    engine.record("pump", 60, "unique_buyers", i);
  }
  const rank = engine.percentileRankOf("pump", 60, "unique_buyers", 95);
  assert.ok(rank !== null && rank >= 85, `expected high percentile, got ${rank}`);
});

test("cohorts are isolated per venue and age bucket", () => {
  const engine = new CohortPercentileEngine();
  for (let i = 1; i <= 50; i++) engine.record("pump", 60, "unique_buyers", i * 10); // 10..500
  for (let i = 1; i <= 50; i++) engine.record("pons", 60, "unique_buyers", i); // 1..50

  // 150 buyers is mid-pack on Pump (values 10..500) but would be an outlier on Pons (values 1..50)
  const pumpRank = engine.percentileRankOf("pump", 60, "unique_buyers", 150);
  const ponsRank = engine.percentileRankOf("pons", 60, "unique_buyers", 150);
  assert.ok(pumpRank !== null && pumpRank < 60, `expected mid pump rank, got ${pumpRank}`);
  assert.ok(ponsRank !== null && ponsRank >= 95, `expected near-top pons rank, got ${ponsRank}`);
});

test("serialize/loadFrom round-trip preserves approximate percentile rank", () => {
  const engine = new CohortPercentileEngine();
  for (let i = 1; i <= 200; i++) engine.record("flap", 300, "unique_buyers", i);
  const before = engine.percentileRankOf("flap", 300, "unique_buyers", 150);

  const restored = new CohortPercentileEngine();
  restored.loadFrom(engine.serializeAll());
  const after = restored.percentileRankOf("flap", 300, "unique_buyers", 150);

  assert.ok(before !== null && after !== null);
  assert.ok(Math.abs((before as number) - (after as number)) <= 5, `expected close ranks, got ${before} vs ${after}`);
});
