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

  const venueCls = token.venueId === "pump" ? "venue-pump" : token.venueId === "pons" ? "venue-pons" : "venue-flap";
  const gradCls =
    token.graduationState === "GRADUATED" ? "status-graduated" : token.graduationState === "GRADUATING" ? "status-graduating" : "status-notgraduated";

  return (
    <div style={{ maxWidth: 760 }}>
      <div className="eyebrow">Section 10 · Standardized Token Record</div>
      <h1 className="page-title fade-up">
        {token.name} <span style={{ color: "var(--paper-2)", fontSize: 18 }}>({token.ticker})</span>
      </h1>
      <div className="meta-row fade-up" style={{ animationDelay: "40ms" }}>
        <span className={`chip ${venueCls}`}>
          <span className="venue-dot" />
          {token.venueId}
        </span>
        <span>{token.chainId}</span>
        <span>age {formatAge(token.launchTimestamp)}</span>
        <span className={gradCls}>
          {token.graduationState} ({token.normalizedGraduationProgressPct.toFixed(0)}%)
        </span>
      </div>

      {token.chainId === "solana-devnet" && (
        <div className="warn-banner fade-up" style={{ marginTop: 16, animationDelay: "60ms" }}>
          DEVNET TEST LAUNCH — this is a real on-chain transaction, but on Solana&apos;s test network with free money.
          Not real economic data. Excluded from the live market feed and every percentile/ranking on this site.
        </div>
      )}

      <Section title="Overview" delay={80}>
        <Row label="Chain" value={token.chainId} />
        <Row label="Venue" value={token.venueId} />
        <Row label="Address" value={token.address} mono />
        <Row label="Graduation" value={`${token.graduationState} (${token.normalizedGraduationProgressPct.toFixed(0)}%)`} />
      </Section>

      <Section title="Market Activity" delay={120}>
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

      <Section title="Launch" delay={160}>
        <Row label="Launch timestamp" value={token.launchTimestamp.toISOString()} />
        <Row label="Launch tx" value={token.launchTxHash} mono />
        <Row label="Block/slot" value={token.launchBlockOrSlot} />
        <Row label="Venue schema version" value={token.venueSchemaVersion} />
        <Row label="Raw graduation progress (venue-native)" value={String(token.rawGraduationProgress)} />
      </Section>

      <Section title="Distribution" delay={200}>
        {token.holderSnapshot ? (
          <>
            <Row label="Visible holders (top 20 accounts)" value={token.holderSnapshot.visibleHolderCount} />
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
            <Row label="Snapshot taken" value={formatAge(token.holderSnapshot.capturedAt) + " ago"} />
          </>
        ) : (
          <p style={{ color: "var(--paper-3)", fontSize: 12, margin: 0, lineHeight: 1.7 }}>
            {token.venueId === "pump"
              ? "No snapshot yet — scripts/snapshot-pump-holders.mjs covers the newest launches first and hasn't reached this token yet."
              : `No holder data for ${token.venueId} — real concentration tracking only exists for Pump right now. It needs getTokenLargestAccounts (Solana), which has no equivalent free-tier-friendly RPC method verified for ${token.venueId}'s chain yet.`}
          </p>
        )}
      </Section>

      <Section title="Creator" delay={240}>
        <Row
          label="Deployer address"
          value={
            token.creatorId ? (
              <Link href={`/creator/${token.creatorId}`} className="addr-link" style={{ fontSize: 12 }}>
                {token.creatorAddress}
              </Link>
            ) : (
              token.creatorAddress
            )
          }
          mono
        />
      </Section>

      <p className="footnote">
        &ldquo;Top-10 concentration&rdquo; excludes the token&apos;s own unsold bonding-curve reserve (verified match
        against the curve&apos;s real on-chain address, not assumed) and is only ever computed from the top 20
        accounts getTokenLargestAccounts returns — it is not a full holder registry. &ldquo;Real buy volume&rdquo; is
        now real for Pump and Flap (SOL/BNB → USD via a live free price feed, priced per trade at real trade-time
        amounts) but deliberately still unavailable for Pons — its quote token varies per launch rather than being
        one fixed native asset, so pricing it would need a per-launch price source this project doesn&apos;t have. A
        composite Launch Quality score is still not shown: two of three venues having real volume data isn&apos;t
        the same as all three having it.
      </p>
    </div>
  );
}

function Section({ title, children, delay }: { title: string; children: ReactNode; delay?: number }) {
  return (
    <section className="fade-up" style={{ marginTop: 20, animationDelay: `${delay ?? 0}ms` }}>
      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">{title}</span>
        </div>
        <div className="panel-body">{children}</div>
      </div>
    </section>
  );
}

function Row({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="row">
      <span className="row-label">{label}</span>
      <span className={`row-value${mono ? " mono-addr" : ""}`}>{value}</span>
    </div>
  );
}
