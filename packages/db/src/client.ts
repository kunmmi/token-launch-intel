import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema/index.js";

type AppDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

const connectionString =
  process.env.DATABASE_URL ?? "postgres://tli:tli_dev_password@localhost:5432/token_launch_intel";

/**
 * DATABASE_URL="pglite://<path>" switches to an embedded, zero-install
 * Postgres engine (PGlite — real Postgres compiled to WASM, runs
 * in-process, no server/service/Docker/admin rights needed) instead of a
 * real TCP Postgres connection. This exists ONLY to make local development
 * and demos possible without Docker — production must use real Postgres
 * (postgres-js) for anything beyond a single process's local file, since
 * PGlite is an embedded single-process engine, not a client-server database.
 *
 * See scripts/verify-live-pump-pipeline.mjs and scripts/seed-live-pump-data.mjs
 * for how this mode gets exercised against real chain data.
 */
let dbInstance: AppDatabase;

if (connectionString.startsWith("pglite://")) {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle: drizzlePglite } = await import("drizzle-orm/pglite");
  const dataDir = connectionString.replace("pglite://", "");
  const pglite = new PGlite(dataDir);
  dbInstance = drizzlePglite(pglite, { schema }) as unknown as AppDatabase;
} else {
  const postgres = (await import("postgres")).default;
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const queryClient = postgres(connectionString);
  dbInstance = drizzle(queryClient, { schema }) as unknown as AppDatabase;
}

export const db = dbInstance;
export type Database = AppDatabase;
