import type { Metadata, Viewport } from "next";
import { Fredoka, Space_Mono, Instrument_Sans } from "next/font/google";
import "./globals.css";
import { WalletProvider } from "./wallet-provider";
import { Providers } from "./providers";

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
  icons: {
    icon: "/icon.png",
    shortcut: "/icon.png",
    apple: "/icon.png",
  },
  openGraph: {
    title: "WordBreak",
    description: "Spell words. Smash bricks. Win cUSD.",
    images: ["/og-image.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "WordBreak",
    description: "Spell words. Smash bricks. Win cUSD.",
    images: ["/og-image.png"],
  },
  other: {
    "talentapp:project_verification":
      "45d9dbd6f891de8c124a3a71bc922102b41f342361b10ea53113d9248b927900ab8df3ca7b16a353626031c64bc72e3530cf9e54103c4988d3d16ab0190c2055",
  },
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
        <Providers>
          <WalletProvider>{children}</WalletProvider>
        </Providers>
      </body>
    </html>
  );
}
