"use client";

import { useState } from "react";
import { LaunchForm } from "./launch-form";
import { FlapLaunchForm } from "./flap-launch-form";

/** Toggles between the two supported launch venues. Pons isn't here — no real, verified way to build its launch transaction was found (see README). */
export function VenueLaunchSelector() {
  const [venue, setVenue] = useState<"pump" | "flap">("pump");

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <VenueTab label="Pump.fun (Solana)" active={venue === "pump"} onClick={() => setVenue("pump")} />
        <VenueTab label="Flap (BNB Chain)" active={venue === "flap"} onClick={() => setVenue("flap")} />
      </div>
      {venue === "pump" ? <LaunchForm /> : <FlapLaunchForm />}
    </div>
  );
}

function VenueTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "8px 16px",
        borderRadius: 6,
        border: active ? "1px solid #4a5568" : "1px solid #23262f",
        background: active ? "#171921" : "#12141b",
        color: active ? "#e6e8ec" : "#8b93a7",
        cursor: "pointer",
        fontSize: 13,
        fontWeight: active ? 600 : 400,
      }}
    >
      {label}
    </button>
  );
}
