import { getVenueComparison } from "../../lib/queries";
import { VenueLaunchSelector } from "./venue-launch-selector";

export const dynamic = "force-dynamic";

/**
 * M1: real coin launching. All three venues — Pump.fun (Solana), Flap
 * (BNB Chain), and Pons (Robinhood Chain) — are mainnet only, at the
 * user's explicit request; the earlier Devnet path for Pump.fun was
 * removed entirely, not just hidden (see app/providers/wallet-provider.tsx,
 * launch-form.tsx). The venue comparison below is real intel from the same
 * data every other page in this app is built on — not a separate
 * mocked-up feature.
 */
export default async function LaunchPage() {
  const comparison = await getVenueComparison();

  return (
    <div style={{ maxWidth: 920 }}>
      <div className="eyebrow">M1 · Real Execution</div>
      <h1 className="page-title fade-up">
        Launch a Coin
        <span className="cursor-blink" />
      </h1>
      <p className="page-subtitle fade-up" style={{ animationDelay: "40ms" }}>
        Pump.fun (Solana), Flap (BNB Chain), and Pons (Robinhood Chain) are supported — all mainnet only, pick a
        venue below. See the note at the bottom for real-money specifics on each.
      </p>

      <section className="fade-up" style={{ marginTop: 28, animationDelay: "80ms" }}>
        <div className="eyebrow" style={{ marginBottom: 12 }}>
          Which venue is hot right now (last 6h)
        </div>
        {comparison.length === 0 ? (
          <p style={{ color: "var(--paper-2)" }}>No launches in the last 6 hours to compare.</p>
        ) : (
          <div className="panel" style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Venue</th>
                  <th>Launches</th>
                  <th>% Graduating/Graduated</th>
                  <th>Avg unique buyers</th>
                  <th>Avg top-10 concentration</th>
                </tr>
              </thead>
              <tbody>
                {comparison
                  .sort((a, b) => b.recentLaunchCount - a.recentLaunchCount)
                  .map((row, i) => (
                    <tr key={row.venueId} style={{ animationDelay: `${i * 40}ms` }}>
                      <td>
                        <span className={`chip ${row.venueId === "pump" ? "venue-pump" : row.venueId === "pons" ? "venue-pons" : "venue-flap"}`}>
                          <span className="venue-dot" />
                          {row.venueId}
                        </span>
                      </td>
                      <td className="num">{row.recentLaunchCount}</td>
                      <td className="num">{row.graduatingOrGraduatedPct !== null ? `${row.graduatingOrGraduatedPct.toFixed(1)}%` : "—"}</td>
                      <td className="num">{row.avgUniqueBuyers !== null ? row.avgUniqueBuyers.toFixed(1) : "—"}</td>
                      <td className="num">{row.avgTop10ConcentrationPct !== null ? `${row.avgTop10ConcentrationPct.toFixed(1)}%` : "—"}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="footnote" style={{ marginTop: 12, paddingTop: 0, borderTop: "none" }}>
          Real numbers from this app&apos;s own indexed data over a small, recent sample — not a recommendation
          engine. Small sample sizes (shown in the Launches column) mean these can swing fast; read the sample size
          before reading the percentages. &ldquo;Avg unique buyers&rdquo; only includes launches with any ingested
          trade data. Avg top-10 concentration is Pump-only right now — see the Token page&apos;s Distribution
          section for why.
        </p>
      </section>

      <section className="fade-up" style={{ marginTop: 36, animationDelay: "120ms" }}>
        <div className="eyebrow" style={{ marginBottom: 12 }}>
          Launch
        </div>
        <VenueLaunchSelector />
      </section>

      <p className="footnote">
        All three venues spend real money from your real wallet on an irreversible transaction — there is no test
        mode. Pump.fun: real SOL on Solana mainnet. Flap: real BNB on BNB Chain — its launch transaction (including
        the real on-chain vanity-address requirement every Flap token enforces) was verified via a live simulation
        against real mainnet state before this UI was built, but no real signed Flap launch has gone through this
        app yet. Pons: real ETH on Robinhood Chain — launches go through Pons&apos;s own real atomic launch+buy
        contract (PonsV2LaunchAndBuy), the same path Pons&apos;s own frontend uses, so your initial buy settles in
        the same transaction as the launch itself; no real signed Pons launch has gone through this app yet either.
      </p>
    </div>
  );
}
