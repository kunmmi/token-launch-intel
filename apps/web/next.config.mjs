/** @type {import('next').NextConfig} */
const nextConfig = {
  // Without this, outputFileTracingIncludes below only affects a trace
  // MANIFEST — it doesn't necessarily make Vercel's own deploy packaging
  // (this repo's vercel.json uses a custom buildCommand, not zero-config
  // detection) actually copy those files into the deployed function.
  // `standalone` makes `next build` physically assemble a self-contained
  // server with every traced dependency as a real file, which Vercel is
  // documented to detect and deploy as-is. Added after a real production
  // 500 (MODULE_NOT_FOUND: @pump-fun/pump-sdk) survived an
  // outputFileTracingIncludes-only fix that verifiably worked in the local
  // trace manifest but not on an actual Vercel deploy — not a
  // hypothetical, a real failed fix attempt in this session.
  output: "standalone",
  // @tli/adapters is here (not in serverExternalPackages like the other
  // @tli/* packages) because externalizing a LOCAL WORKSPACE package
  // (resolved via a node_modules symlink back into packages/adapters, not
  // a real published package) turned out not to reliably survive into the
  // standalone build — confirmed live in this session: with it external,
  // `.next/standalone/packages/adapters/` only ever contained
  // `package.json`, none of the actual `dist/` files real code needs.
  // Bundling it normally, like @tli/core, means its code (including the
  // createRequire call for pump-sdk — see below) ends up physically
  // embedded in route.js instead of depending on a separate file copy.
  transpilePackages: ["@tli/core", "@tli/adapters"],
  // @tli/db ships pre-compiled JS (dist/), so it doesn't need transpiling —
  // and its optional PGlite driver (a WASM package with its own filesystem
  // shim, used only for the Docker-free local dev mode) breaks when
  // Turbopack tries to bundle it. Keeping these external makes Next load
  // them via native Node require instead, which is what they expect.
  //
  // @pump-fun/pump-sdk is here for a related but distinct reason:
  // pump/real-adapter.ts and pump/launch.ts both load it via
  // `createRequire(import.meta.url)("@pump-fun/pump-sdk")` — a genuine
  // upstream defect workaround (pump-sdk's own ESM build is broken under
  // Node's ESM loader, see real-adapter.ts's header), not a choice made
  // for Next's benefit. Listing it here stops webpack from trying to
  // statically bundle a package that needs a real runtime require to
  // work at all.
  serverExternalPackages: ["@tli/db", "@tli/analytics", "@electric-sql/pglite", "postgres", "tdigest", "@pump-fun/pump-sdk"],
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
