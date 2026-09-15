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
    <div style={{ maxWidth: 900 }}>
      <h1 style={{ marginBottom: 4 }}>Launch a Coin</h1>
      <p style={{ color: "#8b93a7" }}>
        Pump.fun (Solana, Devnet or Mainnet) and Flap (BNB Chain, Mainnet only) are supported — pick a venue below.
        See the note at the bottom for what real vs. test money means on each.
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
        <h2 style={{ fontSize: 14, textTransform: "uppercase", letterSpacing: 1, color: "#8b93a7" }}>Launch</h2>
        <VenueLaunchSelector />
      </section>

      <p style={{ color: "#5b6273", fontSize: 12, marginTop: 32, maxWidth: 640 }}>
        Pump.fun: Devnet SOL has no real value (get some free at faucet.solana.com) — good for testing the flow
        risk-free. Mainnet spends real SOL from your real wallet on an irreversible transaction; the network switch
        resets to Devnet every time you load this page, on purpose. Your wallet's own network setting (Phantom's
        Developer Settings or equivalent) must match whichever you pick here. Flap: mainnet only, real BNB, no
        testnet option exists here — its launch transaction (including the real on-chain vanity-address requirement
        every Flap token enforces) was verified via a live simulation against real mainnet state before this UI was
        built, but no real signed Flap launch has gone through this app yet. Pons still isn't supported — no
        verified way to build its launch transaction was found.
      </p>
    </div>
  );
}

const cellStyle = { padding: "8px 12px" } as const;
