import type { CSSProperties } from "react";
import Link from "next/link";
import { getLiveLaunchMarket } from "../../lib/queries";
import { formatAge } from "../../lib/format";

export const dynamic = "force-dynamic"; // this is a live tape, never statically cache it

/**
 * PRD Section 7: "The Universal Launch Market". M0 scope only —
 * no venue-relative percentiles displayed yet (see lib/queries.ts note:
 * the percentile engine isn't persisted/exposed via API in this pass),
 * no filters (Section 8), no New/Heating Up/Graduated tabs. Those are the
 * next concrete slice of work, not faked here with placeholder numbers.
 */
export default async function MarketPage() {
  const rows = await getLiveLaunchMarket(50);

  return (
    <div>
      <h1 style={{ marginBottom: 4 }}>Live Launch Market</h1>
      <p style={{ color: "#8b93a7", marginTop: 0 }}>
        {rows.length === 0
          ? "No launches indexed yet — start the indexer + normalizer services to populate this."
          : `Showing the ${rows.length} most recent launches across all indexed venues.`}
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
              <td style={cellStyle}>{row.uniqueBuyerCount ?? "—"}</td>
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
        Buyers = real unique-wallet buy count from ingested trades (COUNT DISTINCT). Shows "—" until the normalizer
        has processed at least one trade for that token. No venue-relative percentile yet — see README.
      </p>
    </div>
  );
}

const cellStyle: CSSProperties = { padding: "8px 12px" };
