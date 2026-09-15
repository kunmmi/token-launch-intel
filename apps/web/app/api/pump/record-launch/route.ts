import { NextResponse } from "next/server";
import { db, chains, tokens, launches, creators, creatorAddresses } from "@tli/db";
import { eq, and } from "drizzle-orm";

/**
 * Writes a just-launched coin (from /launch) into this app's own database
 * so it shows up on the Market/Token pages — closing the loop between
 * "launch it here" and "track it here". Before this route existed, a real
 * launch through /launch was genuinely on-chain but invisible in this
 * app, because the scheduled indexer only ever watches mainnet, never
 * devnet — confirmed live in this session (a real launched coin 404'd on
 * its own Token page) rather than assumed to already work.
 *
 * Deliberately NOT wired into the percentile engine or holder-snapshot
 * systems: those are real economic-distribution statistics computed
 * across real mainnet launches, and mixing a free-money devnet test coin
 * into those cohorts would quietly corrupt them for every other token in
 * the same venue. This route only writes tokens/launches/creators rows —
 * enough for the page to render real on-chain facts, nothing that could
 * bias a percentile ranking.
 *
 * Stored under chain "solana-devnet" (not "solana", which is reserved for
 * real mainnet Pump data) so it's structurally distinguishable — see
 * lib/queries.ts's getLiveLaunchMarket, which excludes this chain from
 * the default live market feed for the same reason.
 */

const DEVNET_CHAIN_ID = "solana-devnet";

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
    await db.insert(chains).values({ id: DEVNET_CHAIN_ID, displayName: "Solana (Devnet — test launches, not real economic data)" }).onConflictDoNothing();

    const [token] = await db
      .insert(tokens)
      .values({ chainId: DEVNET_CHAIN_ID, address: mintAddress, venueId: "pump", name, ticker: symbol })
      .onConflictDoNothing({ target: [tokens.chainId, tokens.address] })
      .returning({ id: tokens.id });

    const tokenId =
      token?.id ??
      (await db.select({ id: tokens.id }).from(tokens).where(and(eq(tokens.chainId, DEVNET_CHAIN_ID), eq(tokens.address, mintAddress))).limit(1))[0]?.id;

    if (!tokenId) {
      return NextResponse.json({ error: "Failed to resolve token row" }, { status: 500 });
    }

    const existingCreatorAddress = await db
      .select({ creatorId: creatorAddresses.creatorId })
      .from(creatorAddresses)
      .where(and(eq(creatorAddresses.chainId, DEVNET_CHAIN_ID), eq(creatorAddresses.address, creatorAddress)))
      .limit(1);

    let creatorId: string;
    if (existingCreatorAddress[0]) {
      creatorId = existingCreatorAddress[0].creatorId;
    } else {
      const [creator] = await db.insert(creators).values({}).returning({ id: creators.id });
      creatorId = creator!.id;
      await db.insert(creatorAddresses).values({ creatorId, chainId: DEVNET_CHAIN_ID, address: creatorAddress });
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
        venueSchemaVersion: "pump-create-v2-devnet",
        graduationState: "NOT_GRADUATED",
        rawGraduationProgress: 0,
        normalizedGraduationProgressPct: 0,
        rawPayload: { devnet: true, launchedViaApp: true },
      })
      .onConflictDoNothing({ target: launches.tokenId });

    return NextResponse.json({ chainId: DEVNET_CHAIN_ID, tokenId });
  } catch (err) {
    console.error("[record-launch] failed to write launch:", err);
    return NextResponse.json({ error: "Failed to record launch. See server logs." }, { status: 500 });
  }
}
