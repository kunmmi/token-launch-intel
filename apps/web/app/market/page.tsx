import type { CSSProperties } from "react";
import Link from "next/link";
import { getLiveLaunchMarket, MARKET_VIEWS, type MarketView } from "../../lib/queries";
import { formatAge, ordinal } from "../../lib/format";

export const dynamic = "force-dynamic"; // this is a live tape, never statically cache it

const VIEW_LABELS: Record<MarketView, string> = {
  all: "All",
  new: "New",
  heating_up: "Heating Up",
  near_graduation: "Near Graduation",
  graduated: "Graduated",
};

/**
 * PRD Section 7: "The Universal Launch Market" — now with the New/Heating
 * Up/Near Graduation/Graduated tabs Section 7 calls for, over the one
 * normalized launch market (not five separate feeds). "Heating Up" is a
 * documented approximation (see lib/queries.ts matchesView) — real
 * venue-relative buyer percentiles ARE shown (PRD Section 9), but full
 * Section 8 filters (market cap, liquidity, creator reputation range,
 * etc.) are still not built.
 */
export default async function MarketPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view: rawView } = await searchParams;
  const view: MarketView = (MARKET_VIEWS as readonly string[]).includes(rawView ?? "") ? (rawView as MarketView) : "all";
  const rows = await getLiveLaunchMarket(50, view);

  return (
    <div>
      <h1 style={{ marginBottom: 4 }}>Live Launch Market</h1>
      <nav style={{ display: "flex", gap: 4, marginTop: 12 }}>
        {MARKET_VIEWS.map((v) => (
          <Link
            key={v}
            href={v === "all" ? "/market" : `/market?view=${v}`}
            style={{
              padding: "6px 12px",
              borderRadius: 6,
              fontSize: 13,
              textDecoration: "none",
              color: v === view ? "#0b0d12" : "#e6e8ec",
              background: v === view ? "#e6e8ec" : "#171921",
            }}
          >
            {VIEW_LABELS[v]}
          </Link>
        ))}
      </nav>
      <p style={{ color: "#8b93a7", marginTop: 12 }}>
        {rows.length === 0
          ? view === "all"
            ? "No launches indexed yet — start the indexer + normalizer services to populate this."
            : `No launches currently match "${VIEW_LABELS[view]}".`
          : `Showing ${rows.length} launch${rows.length === 1 ? "" : "es"} — ${VIEW_LABELS[view]}.`}
      </p>
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 16 }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #23262f", color: "#8b93a7" }}>
            <th style={cellStyle}>Token</th>
            <th style={cellStyle}>Venue</th>
            <th style={cellStyle}>Age</th>
            <th style={cellStyle}>Graduation</th>
            <th style={cellStyle}>Buyers</th>
            <th style={cellStyle}>Creator</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.tokenId} style={{ borderBottom: "1px solid #171921" }}>
              <td style={cellStyle}>
                <Link href={`/token/${row.chainId}/${row.address}`} style={{ color: "#e6e8ec" }}>
                  {row.ticker}
                </Link>
              </td>
              <td style={cellStyle}>{row.venueId}</td>
              <td style={cellStyle}>{formatAge(row.launchTimestamp)}</td>
              <td style={cellStyle}>
                {row.graduationState} ({row.normalizedGraduationProgressPct.toFixed(0)}%)
              </td>
              <td style={cellStyle}>
                {row.uniqueBuyerCount ?? "—"}
                {row.uniqueBuyerPercentile !== null && (
                  <span style={{ color: "#8b93a7", fontSize: 12 }}> ({ordinal(row.uniqueBuyerPercentile)} pct)</span>
                )}
              </td>
              <td style={cellStyle}>
                {row.creatorId ? (
                  <Link href={`/creator/${row.creatorId}`} style={{ color: "#9db4ff" }}>
                    {row.creatorAddress.slice(0, 10)}…
                  </Link>
                ) : (
                  row.creatorAddress.slice(0, 10) + "…"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ color: "#5b6273", fontSize: 12, marginTop: 16 }}>
        Buyers = real unique-wallet buy count from ingested trades (COUNT DISTINCT). "pct" = this token's
        venue-relative percentile among tokens of comparable age (PRD Section 9). "Heating Up" currently means "has
        at least one real recorded buy" — an approximation, not true buyer-velocity tracking (not built yet).
      </p>
    </div>
  );
}

const cellStyle: CSSProperties = { padding: "8px 12px" };
