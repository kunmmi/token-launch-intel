import { defineConfig } from "drizzle-kit";

export default defineConfig({
  // Points at COMPILED output, not src/*.ts. drizzle-kit's loader resolves
  // require()'d relative specifiers literally (it does not remap the
  // NodeNext-required ".js" extensions in our .ts source back to ".ts"), so
  // pointing it at ./src/*.ts fails to resolve "./venues.js" from
  // "./tokens.ts". The compiled dist/schema/*.js files use real ".js"
  // filenames, so this resolves correctly. Run `npm run build` before
  // `drizzle-kit generate` (the "generate" package script does this).
  schema: "./dist/schema/*.js",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://tli:tli_dev_password@localhost:5432/token_launch_intel",
  },
});
