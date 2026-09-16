import Link from "next/link";
import { notFound } from "next/navigation";
import { getCreatorHistory } from "../../../lib/queries";
import { formatAge } from "../../../lib/format";

/**
 * PRD Section 13: "We should not begin with a mysterious trust score.
 * Instead we display verifiable history." M0 shows exactly that — total
 * launches and graduated count, computed directly from observed data, no
 * reputation score.
 */
export default async function CreatorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const creator = await getCreatorHistory(id);
  if (!creator) notFound();

  return (
    <div style={{ maxWidth: 760 }}>
      <div className="eyebrow">Section 13 · Verifiable History, Not a Trust Score</div>
      <h1 className="page-title fade-up">{creator.displayName ?? "Unclaimed creator profile"}</h1>

      <div className="fade-up" style={{ display: "flex", gap: 32, margin: "24px 0", animationDelay: "60ms" }}>
        <div className="stat-block">
          <span className="stat-value num">{creator.totalLaunches}</span>
          <span className="stat-label">Total launches</span>
        </div>
        <div className="stat-block">
          <span className="stat-value num" style={{ color: "var(--green-0)" }}>
            {creator.graduatedCount}
          </span>
          <span className="stat-label">Graduated</span>
        </div>
      </div>

      <section className="fade-up" style={{ marginTop: 24, animationDelay: "100ms" }}>
        <div className="panel">
          <div className="panel-header">
            <span className="panel-title">Verified addresses</span>
          </div>
          <div className="panel-body">
            {creator.addresses.map((a) => (
              <div key={`${a.chainId}:${a.address}`} className="row">
                <span className="row-label">{a.chainId}</span>
                <span className="row-value mono-addr">
                  {a.address}{" "}
                  <span style={{ color: "var(--paper-3)" }}>
                    ({a.isSignatureVerified ? "signature verified" : a.isSelfAttested ? "self-attested" : "observed only"})
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="fade-up" style={{ marginTop: 20, animationDelay: "140ms" }}>
        <div className="panel" style={{ overflowX: "auto" }}>
          <div className="panel-header">
            <span className="panel-title">Previous launches</span>
          </div>
          <table className="data-table">
            <tbody>
              {creator.launches.map((l, i) => (
                <tr key={l.tokenId} style={{ animationDelay: `${Math.min(i * 18, 300)}ms` }}>
                  <td>
                    <Link href={`/token/${l.chainId}/${l.address}`} className="ticker-link">
                      {l.ticker}
                    </Link>
                  </td>
                  <td>
                    <span className={`chip ${l.venueId === "pump" ? "venue-pump" : l.venueId === "pons" ? "venue-pons" : "venue-flap"}`}>
                      <span className="venue-dot" />
                      {l.venueId}
                    </span>
                  </td>
                  <td className="num" style={{ color: "var(--paper-2)" }}>
                    {formatAge(l.launchTimestamp)} ago
                  </td>
                  <td
                    className={
                      l.graduationState === "GRADUATED" ? "status-graduated" : l.graduationState === "GRADUATING" ? "status-graduating" : "status-notgraduated"
                    }
                  >
                    {l.graduationState}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
