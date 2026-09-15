/** @type {import('next').NextConfig} */
const nextConfig = {
  // Needed for @pump-fun/pump-sdk's ESM build being broken (see
  // real-adapter.ts's header) — pump/real-adapter.ts and pump/launch.ts
  // work around it by requiring an esbuild-pre-bundled, co-located file
  // via createRequire, which webpack's static analysis can't see through
  // regardless of whether the calling file is bundled or externalized —
  // it's always a genuine runtime filesystem lookup. `standalone` makes
  // `next build` physically copy every traced dependency as a real file,
  // which Vercel is documented to detect and deploy as-is.
  output: "standalone",
  transpilePackages: ["@tli/core"],
  // @tli/db ships pre-compiled JS (dist/), so it doesn't need transpiling —
  // and its optional PGlite driver (a WASM package with its own filesystem
  // shim, used only for the Docker-free local dev mode) breaks when
  // Turbopack tries to bundle it. Keeping these external makes Next load
  // them via native Node require instead, which is what they expect.
  serverExternalPackages: ["@tli/db", "@tli/analytics", "@electric-sql/pglite", "postgres", "tdigest", "@tli/adapters"],
  // @tli/adapters is a LOCAL WORKSPACE package (a node_modules symlink
  // back into packages/adapters, not a real published package) — and,
  // confirmed live in this session across multiple attempts, symlinked
  // workspace packages marked external do not reliably get their actual
  // dist/ files copied into the standalone build by Next's own automatic
  // tracing (`standalone/packages/adapters/` kept containing only
  // package.json). Bundling it instead didn't help either, since the
  // createRequire call inside it stays opaque to webpack regardless.
  // Forcing the real files in directly, unconditionally, is what actually
  // works.
  // Two path forms for the same glob, deliberately: confirmed live that
  // "../../packages/adapters/dist/**/*" (relative to this app's own
  // directory) correctly includes the files in a local `next build`, yet
  // the exact same config still 500'd on a genuinely fresh Vercel deploy
  // (MODULE_NOT_FOUND for the traced file, confirmed via Vercel's logs).
  // The likely reason: this repo's vercel.json runs a custom buildCommand
  // from the repo root, not `next build` from inside apps/web, so
  // Vercel's build container may resolve this relative path from a
  // different base than local `next build` does. Including both the
  // app-relative and repo-root-relative forms costs nothing and removes
  // the guesswork about which base Vercel actually uses.
  outputFileTracingIncludes: {
    "/api/pump/launch-transaction": ["../../packages/adapters/dist/**/*", "packages/adapters/dist/**/*"],
  },
};

export default nextConfig;
