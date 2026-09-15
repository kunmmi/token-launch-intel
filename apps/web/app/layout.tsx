import type { ReactNode } from "react";
import Link from "next/link";
import { SolanaWalletProvider } from "./providers/wallet-provider";

export const metadata = {
  title: "Token Launch Intelligence — M0/M1",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, background: "#0b0d12", color: "#e6e8ec" }}>
        <SolanaWalletProvider>
          <nav
            style={{
              display: "flex",
              gap: 20,
              padding: "14px 24px",
              borderBottom: "1px solid #23262f",
              alignItems: "center",
            }}
          >
            <strong>Launch Intel — M0/M1</strong>
            <Link href="/market" style={{ color: "#9db4ff" }}>
              Market
            </Link>
            <Link href="/launch" style={{ color: "#9db4ff" }}>
              Launch a coin
            </Link>
          </nav>
          <main style={{ padding: 24 }}>{children}</main>
        </SolanaWalletProvider>
      </body>
    </html>
  );
}
