// Plain wagmi config for Privy (@privy-io/wagmi's createConfig — a drop-in wrapper wagmi
// needs to stay in sync with Privy's own wallet state). No AppKit/WalletConnect-adapter
// involved: `injected()` alone covers both desktop browser extensions and MiniPay (which
// injects window.ethereum with isMiniPay: true) — see app/minipay-connector.tsx for the
// auto-connect. Privy's own "wallet" login method covers WalletConnect QR pairing to mobile
// wallets that don't inject, so no separate WC connector is needed here.

import { fallback, http } from "wagmi";
import { createConfig } from "@privy-io/wagmi";
import { injected } from "wagmi/connectors";
import { celo } from "viem/chains";
import type { Chain } from "viem";
import { CHAIN_ID, RPC_URL } from "./config";

// Use viem's built-in celo chain on mainnet (it carries the CIP-64 fee-currency formatter);
// a plain chain object is enough for testnet where gas is paid in CELO.
export const chain: Chain =
  CHAIN_ID === 42220
    ? celo
    : {
        id: CHAIN_ID,
        name: "Celo",
        nativeCurrency: { name: "CELO", symbol: "CELO", decimals: 18 },
        rpcUrls: { default: { http: [RPC_URL] } },
      };

export const supportedChains = [chain] as const;

export const wagmiConfig = createConfig({
  chains: supportedChains,
  connectors: [injected({ shimDisconnect: false })],
  // Multi-RPC fallback — if the primary RPC throttles or goes down, wagmi fails over to the
  // next one instead of stalling. Matters most on MiniPay, where users can't easily refresh.
  transports: {
    [chain.id]: fallback([http(RPC_URL), http()]),
  },
});
