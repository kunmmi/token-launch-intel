"use client";

import { useState } from "react";
import { LaunchForm } from "./launch-form";
import { FlapLaunchForm } from "./flap-launch-form";

/** Toggles between the two supported launch venues. Pons isn't here — no real, verified way to build its launch transaction was found (see README). */
export function VenueLaunchSelector() {
  const [venue, setVenue] = useState<"pump" | "flap">("pump");

  return (
    <div>
      <div className="tabs" style={{ marginBottom: 20 }}>
        <button className={`tab${venue === "pump" ? " active" : ""}`} onClick={() => setVenue("pump")}>
          Pump.fun · Solana
        </button>
        <button className={`tab${venue === "flap" ? " active" : ""}`} onClick={() => setVenue("flap")}>
          Flap · BNB Chain
        </button>
      </div>
      {venue === "pump" ? <LaunchForm /> : <FlapLaunchForm />}
    </div>
  );
}
