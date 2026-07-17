import type { Metadata, Viewport } from "next";
import { Fredoka, Space_Mono, Instrument_Sans } from "next/font/google";
import "./globals.css";
import { WalletProvider } from "./wallet-provider";

const display = Fredoka({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["500", "600", "700"],
});
const body = Instrument_Sans({ subsets: ["latin"], variable: "--font-body" });
const mono = Space_Mono({ subsets: ["latin"], variable: "--font-mono", weight: ["400", "700"] });

export const metadata: Metadata = {
  title: "WordBreak",
  description: "Spell words. Smash bricks. Win cUSD.",
};

export const viewport: Viewport = {
  themeColor: "#0f0a24",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}
