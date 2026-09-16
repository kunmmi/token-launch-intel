import { getVenueComparison } from "../../lib/queries";
import { VenueLaunchSelector } from "./venue-launch-selector";

export const dynamic = "force-dynamic";

/**
 * M1: real coin launching. Pump.fun (Solana) supports both Devnet and
 * Mainnet — the network switch lives inside LaunchForm, defaulting to
 * devnet every page load (see app/providers/wallet-provider.tsx for why
 * that's deliberate). Flap (BNB Chain) is mainnet-only — no testnet path
 * was verified for it (see flap-launch-form.tsx). Pons isn't here: no
 * verified way to build its launch transaction was found either (see
 * README's "Next concrete steps"). The venue comparison below is real
 * intel from the same data every other page in this app is built on —
 * not a separate mocked-up feature.
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
        Pump.fun (Solana, Devnet or Mainnet) and Flap (BNB Chain, Mainnet only) are supported — pick a venue below.
        See the note at the bottom for what real vs. test money means on each.
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
        Pump.fun: Devnet SOL has no real value (get some free at faucet.solana.com) — good for testing the flow
        risk-free. Mainnet spends real SOL from your real wallet on an irreversible transaction; the network switch
        resets to Devnet every time you load this page, on purpose. Your wallet&apos;s own network setting
        (Phantom&apos;s Developer Settings or equivalent) must match whichever you pick here. Flap: mainnet only,
        real BNB, no testnet option exists here — its launch transaction (including the real on-chain vanity-address
        requirement every Flap token enforces) was verified via a live simulation against real mainnet state before
        this UI was built, but no real signed Flap launch has gone through this app yet. Pons still isn&apos;t
        supported — no verified way to build its launch transaction was found.
      </p>
    </div>
  );
}
