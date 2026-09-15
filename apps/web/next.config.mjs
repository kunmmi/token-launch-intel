/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@tli/core"],
  // @tli/db ships pre-compiled JS (dist/), so it doesn't need transpiling —
  // and its optional PGlite driver (a WASM package with its own filesystem
  // shim, used only for the Docker-free local dev mode) breaks when
  // Turbopack tries to bundle it. Keeping these external makes Next load
  // them via native Node require instead, which is what they expect.
  //
  // @tli/adapters and @pump-fun/pump-sdk are here for a related but
  // distinct reason: pump/real-adapter.ts and pump/launch.ts both load
  // pump-sdk via `createRequire(import.meta.url)("@pump-fun/pump-sdk")` —
  // a genuine upstream defect workaround (pump-sdk's own ESM build is
  // broken under Node's ESM loader, see real-adapter.ts's header), not a
  // choice made for Next's benefit. Listing it here stops webpack from
  // trying to statically bundle a package that needs a real runtime
  // require to work at all.
  serverExternalPackages: ["@tli/db", "@tli/analytics", "@electric-sql/pglite", "postgres", "tdigest", "@tli/adapters", "@pump-fun/pump-sdk"],
  // serverExternalPackages alone isn't enough, though: Vercel's deployment
  // file-tracer decides which node_modules files actually get shipped to
  // the serverless function by STATICALLY analyzing imports, and a
  // dynamic createRequire() call is invisible to it — confirmed live in
  // this session as a real 500 (MODULE_NOT_FOUND: @pump-fun/pump-sdk) on
  // the first deploy of the /launch feature, not a hypothetical. This
  // forces the whole @pump-fun scope (pump-sdk plus its own
  // agent-payments-sdk/pump-swap-sdk dependencies) into the trace
  // regardless of what static analysis sees.
  outputFileTracingIncludes: {
    "/api/pump/launch-transaction": ["../../node_modules/@pump-fun/**/*"],
  },
};

export default nextConfig;
