import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema/index.js";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://tli:tli_dev_password@localhost:5432/token_launch_intel";

const queryClient = postgres(connectionString);

export const db = drizzle(queryClient, { schema });
export type Database = typeof db;
