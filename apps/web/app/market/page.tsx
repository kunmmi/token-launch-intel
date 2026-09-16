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
      <div className="eyebrow">Section 7 · Universal Launch Market</div>
      <h1 className="page-title">
        Live Launch Tape
        <span className="cursor-blink" />
      </h1>
      <p className="page-subtitle">
        Every real launch across Pump.fun, Pons, and Flap, normalized into one feed and ranked venue-relative — not
        five separate dashboards pretending to be comparable.
      </p>

      <div className="tabs fade-up" style={{ marginTop: 20 }}>
        {MARKET_VIEWS.map((v) => (
          <Link key={v} href={v === "all" ? "/market" : `/market?view=${v}`} className={`tab${v === view ? " active" : ""}`}>
            {VIEW_LABELS[v]}
          </Link>
        ))}
      </div>

      <p className="meta-row">
        <span>
          {rows.length === 0
            ? view === "all"
              ? "No launches indexed yet."
              : `Nothing currently matches “${VIEW_LABELS[view]}”.`
            : `${rows.length} launch${rows.length === 1 ? "" : "es"} · ${VIEW_LABELS[view]}`}
        </span>
      </p>

      <div className="panel fade-up" style={{ marginTop: 16, overflowX: "auto", animationDelay: "60ms" }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Token</th>
              <th>Venue</th>
              <th>Age</th>
              <th>Graduation</th>
              <th>Buyers</th>
              <th>Sellers</th>
              <th>Creator</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.tokenId} style={{ animationDelay: `${Math.min(i * 18, 400)}ms` }}>
                <td>
                  <Link href={`/token/${row.chainId}/${row.address}`} className="ticker-link">
                    {row.ticker}
                  </Link>
                </td>
                <td>
                  <VenueChip venue={row.venueId} />
                </td>
                <td className="num" style={{ color: "var(--paper-2)" }}>
                  {formatAge(row.launchTimestamp)}
                </td>
                <td>
                  <GraduationTag state={row.graduationState} pct={row.normalizedGraduationProgressPct} />
                </td>
                <td className="num">
                  {row.uniqueBuyerCount ?? "—"}
                  {row.uniqueBuyerPercentile !== null && <span className="pct-tag"> {ordinal(row.uniqueBuyerPercentile)}pct</span>}
                </td>
                <td className="num">
                  {row.uniqueSellerCount ?? "—"}
                  {row.uniqueSellerPercentile !== null && <span className="pct-tag"> {ordinal(row.uniqueSellerPercentile)}pct</span>}
                </td>
                <td>
                  {row.creatorId ? (
                    <Link href={`/creator/${row.creatorId}`} className="addr-link">
                      {row.creatorAddress.slice(0, 8)}…
                    </Link>
                  ) : (
                    <span className="addr-link">{row.creatorAddress.slice(0, 8)}…</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="footnote">
        Buyers/Sellers = real unique-wallet counts from ingested trades (COUNT DISTINCT). “pct” = this token&apos;s
        venue-relative percentile among tokens of comparable age (PRD Section 9). Pons and Flap only started trade
        ingestion recently — their Buyers/Sellers columns fill in as new trades arrive, not backfilled historically.
        &ldquo;Heating Up&rdquo; currently means &ldquo;has at least one real recorded buy&rdquo; — an approximation,
        not true buyer-velocity tracking (not built yet).
      </p>
    </div>
  );
}

function VenueChip({ venue }: { venue: string }) {
  const cls = venue === "pump" ? "venue-pump" : venue === "pons" ? "venue-pons" : "venue-flap";
  return (
    <span className={`chip ${cls}`}>
      <span className="venue-dot" />
      {venue}
    </span>
  );
}

function GraduationTag({ state, pct }: { state: string; pct: number }) {
  const cls = state === "GRADUATED" ? "status-graduated" : state === "GRADUATING" ? "status-graduating" : "status-notgraduated";
  return (
    <span className={cls} style={{ fontSize: 12 }}>
      {state} <span className="num">({pct.toFixed(0)}%)</span>
    </span>
  );
}
