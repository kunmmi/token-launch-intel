import { NextResponse } from "next/server";
import { db, tokens, launches, creators, creatorAddresses } from "@tli/db";
import { eq, and } from "drizzle-orm";

/**
 * Writes a just-launched Flap coin into this app's own database
 * immediately on success — same reasoning as the Pump equivalent (see
 * app/api/pump/record-launch/route.ts): the scheduled indexer would
 * discover it on its own within ~20 minutes anyway (this is genuinely
 * the same real Flap protocol data), writing it immediately just beats
 * that wait. The indexer's later independent discovery of the same
 * launch is a harmless no-op (onConflictDoNothing on chainId+address).
 *
 * No devnet/mainnet split here unlike Pump's — every part of the Flap
 * launch mechanics in this project was verified against BNB Chain
 * mainnet specifically, so there's only one real chain to write under: "bnb".
 */

const FLAP_CHAIN_ID = "bnb";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { tokenAddress, name, symbol, creatorAddress, launchTxHash, blockNumber, launchTimestamp } = body as Record<string, unknown>;

  if (typeof tokenAddress !== "string" || tokenAddress.length === 0) {
    return NextResponse.json({ error: "tokenAddress is required" }, { status: 400 });
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
  if (typeof blockNumber !== "string" && typeof blockNumber !== "number") {
    return NextResponse.json({ error: "blockNumber is required" }, { status: 400 });
  }
  if (typeof launchTimestamp !== "number" || !Number.isFinite(launchTimestamp)) {
    return NextResponse.json({ error: "launchTimestamp (unix seconds) is required" }, { status: 400 });
  }

  try {
    const [token] = await db
      .insert(tokens)
      .values({ chainId: FLAP_CHAIN_ID, address: tokenAddress, venueId: "flap", name, ticker: symbol })
      .onConflictDoNothing({ target: [tokens.chainId, tokens.address] })
      .returning({ id: tokens.id });

    const tokenId =
      token?.id ??
      (await db.select({ id: tokens.id }).from(tokens).where(and(eq(tokens.chainId, FLAP_CHAIN_ID), eq(tokens.address, tokenAddress))).limit(1))[0]?.id;

    if (!tokenId) {
      return NextResponse.json({ error: "Failed to resolve token row" }, { status: 500 });
    }

    const existingCreatorAddress = await db
      .select({ creatorId: creatorAddresses.creatorId })
      .from(creatorAddresses)
      .where(and(eq(creatorAddresses.chainId, FLAP_CHAIN_ID), eq(creatorAddresses.address, creatorAddress)))
      .limit(1);

    let creatorId: string;
    if (existingCreatorAddress[0]) {
      creatorId = existingCreatorAddress[0].creatorId;
    } else {
      const [creator] = await db.insert(creators).values({}).returning({ id: creators.id });
      creatorId = creator!.id;
      await db.insert(creatorAddresses).values({ creatorId, chainId: FLAP_CHAIN_ID, address: creatorAddress });
    }

    await db
      .insert(launches)
      .values({
        tokenId,
        creatorId,
        creatorAddress,
        launchTimestamp: new Date(launchTimestamp * 1000),
        launchTxHash,
        launchBlockOrSlot: String(blockNumber),
        venueSchemaVersion: "flap-portal-v6",
        graduationState: "NOT_GRADUATED",
        rawGraduationProgress: 0,
        normalizedGraduationProgressPct: 0,
        rawPayload: { launchedViaApp: true },
      })
      .onConflictDoNothing({ target: launches.tokenId });

    return NextResponse.json({ tokenId });
  } catch (err) {
    console.error("[flap/record-launch] failed to write launch:", err);
    return NextResponse.json({ error: "Failed to record launch. See server logs." }, { status: 500 });
  }
}
