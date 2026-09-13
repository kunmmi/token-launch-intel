import type { NormalizedLaunch } from "@tli/core";
import { db, tokens, launches, creators, creatorAddresses } from "@tli/db";
import { eq, and } from "drizzle-orm";

/**
 * Idempotent write path for a normalized launch. Safe under at-least-once
 * delivery from the Redis Streams consumer group: re-processing the same
 * event twice must not create duplicate rows or throw.
 *
 * Order matters: creator resolution -> token -> launch, since launch has a
 * FK to both. Each step is upsert-or-fetch-existing rather than
 * insert-or-fail, per the idempotency requirement above.
 */
export async function writeNormalizedLaunch(normalized: NormalizedLaunch): Promise<{ tokenId: string; isNewLaunch: boolean }> {
  const creatorId = await resolveCreator(normalized);

  const [token] = await db
    .insert(tokens)
    .values({
      chainId: normalized.chain,
      address: normalized.tokenAddress,
      venueId: normalized.venue,
      name: normalized.tokenName,
      ticker: normalized.tokenTicker,
    })
    .onConflictDoNothing({ target: [tokens.chainId, tokens.address] })
    .returning({ id: tokens.id });

  const tokenId =
    token?.id ??
    (
      await db
        .select({ id: tokens.id })
        .from(tokens)
        .where(and(eq(tokens.chainId, normalized.chain), eq(tokens.address, normalized.tokenAddress)))
        .limit(1)
    )[0]?.id;

  if (!tokenId) {
    throw new Error(`Failed to resolve token id for ${normalized.chain}:${normalized.tokenAddress}`);
  }

  const inserted = await db
    .insert(launches)
    .values({
      tokenId,
      creatorId,
      creatorAddress: normalized.creatorAddress,
      launchTimestamp: new Date(normalized.launchTimestamp * 1000),
      launchTxHash: normalized.launchTxHash,
      launchBlockOrSlot: normalized.launchBlockOrSlot,
      venueSchemaVersion: normalized.venueSchemaVersion,
      graduationState: normalized.graduationState,
      rawGraduationProgress: normalized.rawGraduationProgress,
      normalizedGraduationProgressPct: normalized.normalizedGraduationProgressPct,
      rawPayload: normalized.rawPayload,
    })
    .onConflictDoNothing({ target: launches.tokenId })
    .returning({ id: launches.id });

  return { tokenId, isNewLaunch: inserted.length > 0 };
}

/**
 * Resolve (or create) a platform Creator profile for an observed deployer
 * address. This is passive/observational only in M0 — no signed proof, no
 * cross-chain linking (that's Section 14 / M1). Every observed address gets
 * exactly one Creator profile unless a future signed-proof flow merges them.
 */
// NOTE: this read-then-insert has a race window under concurrent normalizer
// instances (two processes could both miss the "existing" check and each
// create a Creator row for the same address, leaving one orphaned after
// creatorAddresses' onConflictDoNothing keeps only one mapping). Harmless
// for M0's single-instance normalizer; needs a real atomic upsert (advisory
// lock or a DB-level upsert function) before running multiple instances.
async function resolveCreator(normalized: NormalizedLaunch): Promise<string> {
  const existing = await db
    .select({ creatorId: creatorAddresses.creatorId })
    .from(creatorAddresses)
    .where(and(eq(creatorAddresses.chainId, normalized.chain), eq(creatorAddresses.address, normalized.creatorAddress)))
    .limit(1);

  if (existing[0]) return existing[0].creatorId;

  const [creator] = await db.insert(creators).values({}).returning({ id: creators.id });
  if (!creator) throw new Error("Failed to create creator profile");

  await db
    .insert(creatorAddresses)
    .values({
      creatorId: creator.id,
      chainId: normalized.chain,
      address: normalized.creatorAddress,
      isSelfAttested: false,
      isSignatureVerified: false,
    })
    .onConflictDoNothing({ target: [creatorAddresses.chainId, creatorAddresses.address] });

  return creator.id;
}
