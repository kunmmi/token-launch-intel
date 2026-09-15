/** @type {import('next').NextConfig} */
const nextConfig = {
  // Physically copies every traced dependency as a real file (confirmed
  // live in this session: pump-sdk-bundle.cjs's relative-require, now
  // correctly detected since @tli/adapters is bundled below, showed up in
  // .next/standalone/packages/adapters/dist/pump/ exactly where needed).
  // Vercel is documented to detect and deploy this output as-is.
  output: "standalone",
  // @tli/core and @tli/adapters are both bundled directly (not
  // externalized like the packages below) so their code — including a
  // static import of a pre-bundled pump-sdk file, see
  // packages/adapters/src/pump/real-adapter.ts's header — goes through
  // webpack's normal, reliable bundling path. Local workspace packages
  // (node_modules symlinks back into packages/*, not real published
  // packages) marked serverExternalPackages instead were confirmed live
  // in this session not to reliably survive into a Vercel deployment
  // regardless of what they required internally — this sidesteps that
  // entirely rather than fighting it further.
  transpilePackages: ["@tli/core", "@tli/adapters"],
  // @tli/db ships pre-compiled JS (dist/), so it doesn't need transpiling —
  // and its optional PGlite driver (a WASM package with its own filesystem
  // shim, used only for the Docker-free local dev mode) breaks when
  // Turbopack tries to bundle it. Keeping these external makes Next load
  // them via native Node require instead, which is what they expect.
  serverExternalPackages: ["@tli/db", "@tli/analytics", "@electric-sql/pglite", "postgres", "tdigest"],
};

export default nextConfig;
