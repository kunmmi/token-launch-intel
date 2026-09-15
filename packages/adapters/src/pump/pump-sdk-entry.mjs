// Bundled at build time (see package.json's build:pump-sdk-bundle script)
// into dist/pump/pump-sdk-bundle.cjs via esbuild, with @solana/web3.js and
// @coral-xyz/anchor left external (shared with the rest of this package,
// not duplicated) — see real-adapter.ts's header for the full story of
// why this exists: @pump-fun/pump-sdk's own ESM build is broken (its
// transitive @pump-fun/agent-payments-sdk does `import { BN } from
// "@coral-xyz/anchor"`, which Node's native ESM loader rejects since
// anchor is CJS). A `createRequire()` runtime workaround fixed this for
// every context this project ran in UNTIL Vercel's serverless deployment,
// where a dynamic require() proved unreliable to package correctly no
// matter how the Next.js/Vercel build config was tuned (verified across
// several real, failed production deploys in this session, not assumed).
// esbuild resolves the exact same interop problem at BUILD time instead —
// bundling it once into a real, statically-requireable file sidesteps the
// whole class of runtime-resolution problems, on Vercel or anywhere else.
export * from "@pump-fun/pump-sdk";
