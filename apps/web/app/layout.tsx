import type { ReactNode } from "react";
import { JetBrains_Mono } from "next/font/google";
import Link from "next/link";
import { SolanaWalletProvider } from "./providers/wallet-provider";
import "./globals.css";

const jbMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700", "800"],
  variable: "--font-jbmono",
  display: "swap",
});

export const metadata = {
  title: "Token Launch Intelligence — M0/M1",
  description: "Cross-venue token launch intelligence and real launch execution for Pump.fun and Flap.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={jbMono.variable}>
      <body>
        <SolanaWalletProvider>
          <header className="topbar">
            <div className="topbar-inner">
              <Link href="/market" className="brand">
                <span className="brand-mark">◈</span>
                TOKEN&nbsp;LAUNCH<span style={{ color: "var(--paper-3)" }}>/</span>INTEL
                <span className="brand-sub">M0·M1</span>
              </Link>
              <nav className="nav">
                <Link href="/market" className="nav-link">
                  Market
                </Link>
                <Link href="/launch" className="nav-link">
                  Launch
                </Link>
              </nav>
              <span className="live-pill">
                <span className="live-dot" />
                live feed
              </span>
            </div>
          </header>
          <main className="page">{children}</main>
        </SolanaWalletProvider>
      </body>
    </html>
  );
}
