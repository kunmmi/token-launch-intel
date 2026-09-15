import { NextResponse } from "next/server";
import { db, chains, tokens, launches, creators, creatorAddresses } from "@tli/db";
import { eq, and } from "drizzle-orm";

/**
 * Writes a just-launched coin (from /launch) into this app's own database
 * so it shows up on the Market/Token pages immediately — closing the loop
 * between "launch it here" and "track it here" rather than waiting up to
 * ~20 minutes for the scheduled indexer to independently discover it (for
 * a mainnet launch, it eventually would anyway; for devnet, it never
 * would, since that indexer only watches mainnet — confirmed live in this
 * session, a real devnet launch 404'd on its own Token page before this
 * route existed).
 *
 * Devnet writes are deliberately NOT wired into the percentile engine or
 * holder-snapshot systems: those are real economic-distribution
 * statistics computed across real mainnet launches, and mixing a
 * free-money devnet test coin into those cohorts would quietly corrupt
 * them for every other token in the venue. Stored under chain
 * "solana-devnet" (never "solana") so it's structurally distinguishable —
 * see lib/queries.ts's getLiveLaunchMarket, which excludes that chain
 * from the default live market feed for the same reason.
 *
 * Mainnet writes use the real "solana" chain — this genuinely is the same
 * real Pump.fun protocol data the scheduled indexer would discover on its
 * own; writing it immediately just beats that ~20-minute wait. The
 * scheduled indexer's own later discovery of the same launch is a
 * harmless no-op (onConflictDoNothing on the same chainId+address).
 */

const CHAIN_ID_FOR_NETWORK: Record<"devnet" | "mainnet-beta", string> = {
  devnet: "solana-devnet",
  "mainnet-beta": "solana",
};

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { mintAddress, name, symbol, creatorAddress, launchTxHash, slot, launchTimestamp, network } = body as Record<string, unknown>;

  if (network !== "devnet" && network !== "mainnet-beta") {
    return NextResponse.json({ error: 'network must be exactly "devnet" or "mainnet-beta"' }, { status: 400 });
  }
  if (typeof mintAddress !== "string" || mintAddress.length === 0) {
    return NextResponse.json({ error: "mintAddress is required" }, { status: 400 });
  }
  if (typeof name !== "string" || typeof symbol !== "string") {
    return NextResponse.json({ error: "name and symbol are required strings" }, { status: 400 });
  }
  if (typeof creatorAddress !== "string" || creatorAddress.length === 0) {
    return NextResponse.json({ error: "creatorAddress is required" }, { status: 400 });
  }
  if (typeof launchTxHash !== "string" || launchTxHash.length === 0) {
    return NextResponse.json({ error: "launchTxHash is required" }, { status: 400 });
  }
  if (typeof slot !== "string" && typeof slot !== "number") {
    return NextResponse.json({ error: "slot is required" }, { status: 400 });
  }
  if (typeof launchTimestamp !== "number" || !Number.isFinite(launchTimestamp)) {
    return NextResponse.json({ error: "launchTimestamp (unix seconds) is required" }, { status: 400 });
  }

  const chainId = CHAIN_ID_FOR_NETWORK[network];
  const isDevnet = network === "devnet";

  try {
    if (isDevnet) {
      await db.insert(chains).values({ id: chainId, displayName: "Solana (Devnet — test launches, not real economic data)" }).onConflictDoNothing();
    } // "solana" (mainnet) already exists as real reference data — never overwritten here.

    const [token] = await db
      .insert(tokens)
      .values({ chainId, address: mintAddress, venueId: "pump", name, ticker: symbol })
      .onConflictDoNothing({ target: [tokens.chainId, tokens.address] })
      .returning({ id: tokens.id });

    const tokenId =
      token?.id ??
      (await db.select({ id: tokens.id }).from(tokens).where(and(eq(tokens.chainId, chainId), eq(tokens.address, mintAddress))).limit(1))[0]?.id;

    if (!tokenId) {
      return NextResponse.json({ error: "Failed to resolve token row" }, { status: 500 });
    }

    const existingCreatorAddress = await db
      .select({ creatorId: creatorAddresses.creatorId })
      .from(creatorAddresses)
      .where(and(eq(creatorAddresses.chainId, chainId), eq(creatorAddresses.address, creatorAddress)))
      .limit(1);

    let creatorId: string;
    if (existingCreatorAddress[0]) {
      creatorId = existingCreatorAddress[0].creatorId;
    } else {
      const [creator] = await db.insert(creators).values({}).returning({ id: creators.id });
      creatorId = creator!.id;
      await db.insert(creatorAddresses).values({ creatorId, chainId, address: creatorAddress });
    }

    await db
      .insert(launches)
      .values({
        tokenId,
        creatorId,
        creatorAddress,
        launchTimestamp: new Date(launchTimestamp * 1000),
        launchTxHash,
        launchBlockOrSlot: String(slot),
        venueSchemaVersion: isDevnet ? "pump-create-v2-devnet" : "pump-create-v2",
        graduationState: "NOT_GRADUATED",
        rawGraduationProgress: 0,
        normalizedGraduationProgressPct: 0,
        rawPayload: { devnet: isDevnet, launchedViaApp: true },
      })
      .onConflictDoNothing({ target: launches.tokenId });

    return NextResponse.json({ chainId, tokenId });
  } catch (err) {
    console.error("[record-launch] failed to write launch:", err);
    return NextResponse.json({ error: "Failed to record launch. See server logs." }, { status: 500 });
  }
}
