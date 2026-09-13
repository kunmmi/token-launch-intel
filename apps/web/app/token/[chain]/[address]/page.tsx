import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTokenDetail } from "../../../../lib/queries";
import { formatAge } from "../../../../lib/format";

/**
 * PRD Section 10: one standardized token page regardless of launchpad.
 * M0 populates Overview + Launch + (partial) Creator sections from real
 * data. Market Activity, Distribution, and Intelligence sections are
 * intentionally omitted rather than shown with fabricated numbers — they
 * depend on trade ingestion and the percentile engine, neither of which
 * write through to the API in this pass yet.
 */
export default async function TokenPage({ params }: { params: Promise<{ chain: string; address: string }> }) {
  const { chain, address } = await params;
  const token = await getTokenDetail(chain, address);
  if (!token) notFound();

  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ marginBottom: 0 }}>
        {token.name} <span style={{ color: "#8b93a7" }}>({token.ticker})</span>
      </h1>
      <p style={{ color: "#8b93a7" }}>
        {token.venueId} · {token.chainId} · age {formatAge(token.launchTimestamp)}
      </p>

      <Section title="Overview">
        <Row label="Chain" value={token.chainId} />
        <Row label="Venue" value={token.venueId} />
        <Row label="Address" value={token.address} mono />
        <Row label="Graduation" value={`${token.graduationState} (${token.normalizedGraduationProgressPct.toFixed(0)}%)`} />
      </Section>

      <Section title="Launch">
        <Row label="Launch timestamp" value={token.launchTimestamp.toISOString()} />
        <Row label="Launch tx" value={token.launchTxHash} mono />
        <Row label="Block/slot" value={token.launchBlockOrSlot} />
        <Row label="Venue schema version" value={token.venueSchemaVersion} />
        <Row label="Raw graduation progress (venue-native)" value={String(token.rawGraduationProgress)} />
      </Section>

      <Section title="Creator">
        <Row
          label="Deployer address"
          value={
            token.creatorId ? (
              <Link href={`/creator/${token.creatorId}`} style={{ color: "#9db4ff" }}>
                {token.creatorAddress}
              </Link>
            ) : (
              token.creatorAddress
            )
          }
          mono
        />
      </Section>

      <p style={{ color: "#5b6273", fontSize: 12, marginTop: 24 }}>
        Market Activity, Distribution, and Intelligence (venue-relative percentiles, Launch Quality) sections are not
        shown — they require trade ingestion and the percentile-engine API wiring, which are the next pieces of work.
        Not fabricated here.
      </p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 14, textTransform: "uppercase", letterSpacing: 1, color: "#8b93a7" }}>{title}</h2>
      <div style={{ border: "1px solid #23262f", borderRadius: 8, padding: 12 }}>{children}</div>
    </section>
  );
}

function Row({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", gap: 16 }}>
      <span style={{ color: "#8b93a7" }}>{label}</span>
      <span style={{ fontFamily: mono ? "monospace" : undefined, textAlign: "right", wordBreak: "break-all" }}>
        {value}
      </span>
    </div>
  );
}
