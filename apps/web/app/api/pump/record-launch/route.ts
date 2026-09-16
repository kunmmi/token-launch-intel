import { NextResponse } from "next/server";
import { db, tokens, launches, creators, creatorAddresses } from "@tli/db";
import { eq, and } from "drizzle-orm";

/**
 * Writes a just-launched coin (from /launch) into this app's own database
 * so it shows up on the Market/Token pages immediately — closing the loop
 * between "launch it here" and "track it here" rather than waiting up to
 * ~20 minutes for the scheduled indexer to independently discover it. This
 * genuinely is the same real Pump.fun protocol data the scheduled indexer
 * would discover on its own; writing it immediately just beats that wait.
 * The scheduled indexer's own later discovery of the same launch is a
 * harmless no-op (onConflictDoNothing on the same chainId+address).
 *
 * Mainnet only, at the user's explicit request — the Devnet write path
 * (a separate "solana-devnet" chain, kept out of the percentile engine and
 * live market feed) was removed entirely along with the rest of the
 * Devnet UI, not just hidden. Historical devnet launches already in the
 * database from before this change are untouched.
 */

const CHAIN_ID = "solana";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { mintAddress, name, symbol, creatorAddress, launchTxHash, slot, launchTimestamp } = body as Record<string, unknown>;

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

  try {
    const [token] = await db
      .insert(tokens)
      .values({ chainId: CHAIN_ID, address: mintAddress, venueId: "pump", name, ticker: symbol })
      .onConflictDoNothing({ target: [tokens.chainId, tokens.address] })
      .returning({ id: tokens.id });

    const tokenId =
      token?.id ??
      (await db.select({ id: tokens.id }).from(tokens).where(and(eq(tokens.chainId, CHAIN_ID), eq(tokens.address, mintAddress))).limit(1))[0]?.id;

    if (!tokenId) {
      return NextResponse.json({ error: "Failed to resolve token row" }, { status: 500 });
    }

    const existingCreatorAddress = await db
      .select({ creatorId: creatorAddresses.creatorId })
      .from(creatorAddresses)
      .where(and(eq(creatorAddresses.chainId, CHAIN_ID), eq(creatorAddresses.address, creatorAddress)))
      .limit(1);

    let creatorId: string;
    if (existingCreatorAddress[0]) {
      creatorId = existingCreatorAddress[0].creatorId;
    } else {
      const [creator] = await db.insert(creators).values({}).returning({ id: creators.id });
      creatorId = creator!.id;
      await db.insert(creatorAddresses).values({ creatorId, chainId: CHAIN_ID, address: creatorAddress });
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
        venueSchemaVersion: "pump-create-v2",
        graduationState: "NOT_GRADUATED",
        rawGraduationProgress: 0,
        normalizedGraduationProgressPct: 0,
        rawPayload: { launchedViaApp: true },
      })
      .onConflictDoNothing({ target: launches.tokenId });

    return NextResponse.json({ chainId: CHAIN_ID, tokenId });
  } catch (err) {
    console.error("[record-launch] failed to write launch:", err);
    return NextResponse.json({ error: "Failed to record launch. See server logs." }, { status: 500 });
  }
}
