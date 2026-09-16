"use client";

import { useState } from "react";
import { LaunchForm } from "./launch-form";
import { FlapLaunchForm } from "./flap-launch-form";
import { PonsLaunchForm } from "./pons-launch-form";

/** Toggles between the three supported launch venues. */
export function VenueLaunchSelector() {
  const [venue, setVenue] = useState<"pump" | "flap" | "pons">("pump");

  return (
    <div>
      <div className="tabs" style={{ marginBottom: 20 }}>
        <button className={`tab${venue === "pump" ? " active" : ""}`} onClick={() => setVenue("pump")}>
          Pump.fun · Solana
        </button>
        <button className={`tab${venue === "flap" ? " active" : ""}`} onClick={() => setVenue("flap")}>
          Flap · BNB Chain
        </button>
        <button className={`tab${venue === "pons" ? " active" : ""}`} onClick={() => setVenue("pons")}>
          Pons · Robinhood Chain
        </button>
      </div>
      {venue === "pump" ? <LaunchForm /> : venue === "flap" ? <FlapLaunchForm /> : <PonsLaunchForm />}
    </div>
  );
}
