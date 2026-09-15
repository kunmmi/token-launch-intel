import { getVenueComparison } from "../../lib/queries";
import { LaunchForm } from "./launch-form";

export const dynamic = "force-dynamic";

/**
 * M1: real coin launching, starting with Pump.fun on devnet only (see
 * launch-form.tsx and app/providers/wallet-provider.tsx for why). The
 * venue comparison below is real intel from the same data every other
 * page in this app is built on — not a separate mocked-up feature.
 */
export default async function LaunchPage() {
  const comparison = await getVenueComparison();

  return (
    <div style={{ maxWidth: 900 }}>
      <h1 style={{ marginBottom: 4 }}>Launch a Coin</h1>
      <p style={{ color: "#8b93a7" }}>
        Pump.fun only, on Solana Devnet — real transactions, fake money. See the note at the bottom for what that
        means and why.
      </p>

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 14, textTransform: "uppercase", letterSpacing: 1, color: "#8b93a7" }}>
          Which venue is hot right now (last 6 hours)
        </h2>
        {comparison.length === 0 ? (
          <p style={{ color: "#8b93a7" }}>No launches in the last 6 hours to compare.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #23262f", color: "#8b93a7" }}>
                <th style={cellStyle}>Venue</th>
                <th style={cellStyle}>Launches</th>
                <th style={cellStyle}>% Graduating/Graduated</th>
                <th style={cellStyle}>Avg unique buyers</th>
                <th style={cellStyle}>Avg top-10 concentration</th>
              </tr>
            </thead>
            <tbody>
              {comparison
                .sort((a, b) => b.recentLaunchCount - a.recentLaunchCount)
                .map((row) => (
                  <tr key={row.venueId} style={{ borderBottom: "1px solid #171921" }}>
                    <td style={cellStyle}>{row.venueId}</td>
                    <td style={cellStyle}>{row.recentLaunchCount}</td>
                    <td style={cellStyle}>{row.graduatingOrGraduatedPct !== null ? `${row.graduatingOrGraduatedPct.toFixed(1)}%` : "—"}</td>
                    <td style={cellStyle}>{row.avgUniqueBuyers !== null ? row.avgUniqueBuyers.toFixed(1) : "—"}</td>
                    <td style={cellStyle}>{row.avgTop10ConcentrationPct !== null ? `${row.avgTop10ConcentrationPct.toFixed(1)}%` : "—"}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
        <p style={{ color: "#5b6273", fontSize: 12, marginTop: 8 }}>
          Real numbers from this app's own indexed data over a small, recent sample — not a recommendation engine.
          Small sample sizes (shown in the Launches column) mean these can swing fast; read the sample size before
          reading the percentages. "Avg unique buyers" only includes launches with any ingested trade data. Avg
          top-10 concentration is Pump-only right now — see the Token page's Distribution section for why.
        </p>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 14, textTransform: "uppercase", letterSpacing: 1, color: "#8b93a7" }}>Launch (Pump.fun, Devnet)</h2>
        <LaunchForm />
      </section>

      <p style={{ color: "#5b6273", fontSize: 12, marginTop: 32, maxWidth: 640 }}>
        This is real Solana Devnet — the same Pump.fun program and instructions mainnet uses, verified live before
        this page was built, but Devnet SOL has no real value (get some free at faucet.solana.com). Your wallet must
        be switched to Devnet for this to work. Mainnet launching is not available here yet — this is the first,
        deliberately-scoped step before that, not an oversight. Only Pump.fun is supported; Pons and Flap launch
        flows are a separate, unbuilt feature.
      </p>
    </div>
  );
}

const cellStyle = { padding: "8px 12px" } as const;
