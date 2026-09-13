/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@tli/core"],
  // @tli/db ships pre-compiled JS (dist/), so it doesn't need transpiling —
  // and its optional PGlite driver (a WASM package with its own filesystem
  // shim, used only for the Docker-free local dev mode) breaks when
  // Turbopack tries to bundle it. Keeping these external makes Next load
  // them via native Node require instead, which is what they expect.
  serverExternalPackages: ["@tli/db", "@electric-sql/pglite", "postgres"],
};

export default nextConfig;
