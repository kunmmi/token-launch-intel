import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTokenDetail } from "../../../../lib/queries";
import { formatAge, ordinal } from "../../../../lib/format";

/**
 * PRD Section 10: one standardized token page regardless of launchpad.
 * M0 populates Overview + Market Activity + Launch + (partial) Creator
 * sections from real data. Distribution shows real holder concentration for
 * Pump tokens (see lib/queries.ts's getLatestHolderSnapshot and
 * packages/db/src/schema/holders.ts) — Pons/Flap still show nothing rather
 * than a fabricated number, since no free EVM holder-data path was found.
 * Market Activity now includes real buy-volume-in-USD for Pump and Flap
 * (see packages/adapters's priceUsdFromSolTrade/priceUsdFromBnbTrade,
 * wired via a free CoinGecko price feed — packages/adapters/src/pricing.ts)
 * — Pons is still null here, deliberately: its quote token is arbitrary
 * per launch (verified against real captured fixtures, not assumed), not
 * one fixed native asset, so pricing it needs a per-launch price source
 * this project doesn't have. A full composite "Launch Quality score" is
 * still not built — two of three venues having real volume isn't the same
 * as all three, and inventing a score that silently degrades for Pons
 * would be the same fabricated-authority problem this project has
 * otherwise avoided.
 */
export default async function TokenPage({ params }: { params: Promise<{ chain: string; address: string }> }) {
  const { chain, address } = await params;
  const token = await getTokenDetail(chain, address);
  if (!token) notFound();

  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ marginBottom: 0 }}>
        {token.name} <span style={{ color: "#8b93a7" }}>({token.ticker})</span>
      </h1>
      <p style={{ color: "#8b93a7" }}>
        {token.venueId} · {token.chainId} · age {formatAge(token.launchTimestamp)}
      </p>
      {token.chainId === "solana-devnet" && (
        <p style={{ background: "#3a2a12", color: "#e0b060", padding: "8px 12px", borderRadius: 6, fontSize: 13, marginTop: 8 }}>
          DEVNET TEST LAUNCH — this is a real on-chain transaction, but on Solana&apos;s test network with free money.
          Not real economic data. Excluded from the live market feed and every percentile/ranking on this site.
        </p>
      )}

      <Section title="Overview">
        <Row label="Chain" value={token.chainId} />
        <Row label="Venue" value={token.venueId} />
        <Row label="Address" value={token.address} mono />
        <Row label="Graduation" value={`${token.graduationState} (${token.normalizedGraduationProgressPct.toFixed(0)}%)`} />
      </Section>

      <Section title="Market Activity">
        <Row label="Unique buyers" value={token.uniqueBuyerCount ?? "—"} />
        <Row
          label={`${token.venueId}-relative buyer percentile (at current age)`}
          value={token.uniqueBuyerPercentile !== null ? `${ordinal(token.uniqueBuyerPercentile)} percentile` : "—"}
        />
        <Row label="Unique sellers" value={token.uniqueSellerCount ?? "—"} />
        <Row
          label={`${token.venueId}-relative seller percentile (at current age)`}
          value={token.uniqueSellerPercentile !== null ? `${ordinal(token.uniqueSellerPercentile)} percentile` : "—"}
        />
        <Row
          label="Real buy volume (USD)"
          value={
            token.buyVolumeUsd !== null
              ? `$${token.buyVolumeUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
              : token.venueId === "pons"
                ? "— (no USD pricing for Pons yet)"
                : "—"
          }
        />
        <Row
          label={`${token.venueId}-relative buy-volume percentile (at current age)`}
          value={token.buyVolumeUsdPercentile !== null ? `${ordinal(token.buyVolumeUsdPercentile)} percentile` : "—"}
        />
      </Section>

      <Section title="Launch">
        <Row label="Launch timestamp" value={token.launchTimestamp.toISOString()} />
        <Row label="Launch tx" value={token.launchTxHash} mono />
        <Row label="Block/slot" value={token.launchBlockOrSlot} />
        <Row label="Venue schema version" value={token.venueSchemaVersion} />
        <Row label="Raw graduation progress (venue-native)" value={String(token.rawGraduationProgress)} />
      </Section>

      <Section title="Distribution">
        {token.holderSnapshot ? (
          <>
            <Row
              label="Visible holders (top 20 accounts)"
              value={token.holderSnapshot.visibleHolderCount}
            />
            <Row
              label="Top-10 concentration (of circulating supply)"
              value={
                token.holderSnapshot.top10ConcentrationPct !== null
                  ? `${token.holderSnapshot.top10ConcentrationPct.toFixed(1)}%`
                  : "— (nothing bought yet)"
              }
            />
            <Row
              label={`${token.venueId}-relative concentration percentile (at current age)`}
              value={
                token.holderSnapshot.top10ConcentrationPercentile !== null
                  ? `${ordinal(token.holderSnapshot.top10ConcentrationPercentile)} percentile — higher means MORE concentrated than peers`
                  : "—"
              }
            />
            <Row
              label="Snapshot taken"
              value={formatAge(token.holderSnapshot.capturedAt) + " ago"}
            />
          </>
        ) : (
          <p style={{ color: "#5b6273", fontSize: 12, margin: 0 }}>
            {token.venueId === "pump"
              ? "No snapshot yet — scripts/snapshot-pump-holders.mjs covers the newest launches first and hasn't reached this token yet."
              : `No holder data for ${token.venueId} — real concentration tracking only exists for Pump right now. It needs getTokenLargestAccounts (Solana), which has no equivalent free-tier-friendly RPC method verified for ${token.venueId}'s chain yet.`}
          </p>
        )}
      </Section>

      <Section title="Creator">
        <Row
          label="Deployer address"
          value={
            token.creatorId ? (
              <Link href={`/creator/${token.creatorId}`} style={{ color: "#9db4ff" }}>
                {token.creatorAddress}
              </Link>
            ) : (
              token.creatorAddress
            )
          }
          mono
        />
      </Section>

      <p style={{ color: "#5b6273", fontSize: 12, marginTop: 24 }}>
        "Top-10 concentration" excludes the token's own unsold bonding-curve reserve (verified match against the
        curve's real on-chain address, not assumed) and is only ever computed from the top 20 accounts
        getTokenLargestAccounts returns — it is not a full holder registry. "Real buy volume" is now real for Pump
        and Flap (SOL/BNB → USD via a live free price feed, priced per trade at real trade-time amounts) but
        deliberately still unavailable for Pons — its quote token varies per launch rather than being one fixed
        native asset, so pricing it would need a per-launch price source this project doesn't have. A composite
        Launch Quality score is still not shown: two of three venues having real volume data isn't the same as all
        three having it.
      </p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 14, textTransform: "uppercase", letterSpacing: 1, color: "#8b93a7" }}>{title}</h2>
      <div style={{ border: "1px solid #23262f", borderRadius: 8, padding: 12 }}>{children}</div>
    </section>
  );
}

function Row({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", gap: 16 }}>
      <span style={{ color: "#8b93a7" }}>{label}</span>
      <span style={{ fontFamily: mono ? "monospace" : undefined, textAlign: "right", wordBreak: "break-all" }}>
        {value}
      </span>
    </div>
  );
}
