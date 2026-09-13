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
    <div style={{ maxWidth: 720 }}>
      <h1>{creator.displayName ?? "Unclaimed creator profile"}</h1>

      <section style={{ display: "flex", gap: 24, margin: "16px 0" }}>
        <Stat label="Total launches" value={creator.totalLaunches} />
        <Stat label="Graduated" value={creator.graduatedCount} />
      </section>

      <h2 style={{ fontSize: 14, textTransform: "uppercase", letterSpacing: 1, color: "#8b93a7" }}>
        Verified addresses
      </h2>
      <ul>
        {creator.addresses.map((a) => (
          <li key={`${a.chainId}:${a.address}`} style={{ fontFamily: "monospace" }}>
            {a.chainId}: {a.address}{" "}
            <span style={{ color: "#5b6273" }}>
              ({a.isSignatureVerified ? "signature verified" : a.isSelfAttested ? "self-attested" : "observed only"})
            </span>
          </li>
        ))}
      </ul>

      <h2 style={{ fontSize: 14, textTransform: "uppercase", letterSpacing: 1, color: "#8b93a7", marginTop: 24 }}>
        Previous launches
      </h2>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <tbody>
          {creator.launches.map((l) => (
            <tr key={l.tokenId} style={{ borderBottom: "1px solid #171921" }}>
              <td style={{ padding: "6px 8px" }}>
                <Link href={`/token/${l.chainId}/${l.address}`} style={{ color: "#e6e8ec" }}>
                  {l.ticker}
                </Link>
              </td>
              <td style={{ padding: "6px 8px", color: "#8b93a7" }}>{l.venueId}</td>
              <td style={{ padding: "6px 8px", color: "#8b93a7" }}>{formatAge(l.launchTimestamp)} ago</td>
              <td style={{ padding: "6px 8px" }}>{l.graduationState}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div style={{ fontSize: 24 }}>{value}</div>
      <div style={{ color: "#8b93a7", fontSize: 12 }}>{label}</div>
    </div>
  );
}
