// Wallet + chain plumbing. Reown AppKit (+ wagmi adapter) owns wallet connection — injected
// providers, WalletConnect QR pairing, and email/social login all go through one unified modal
// (see app/appkit-provider.tsx, app/wallet-provider.tsx). This file exposes what the game
// needs beyond that: a read-only viem publicClient, and sendWrite() which pulls a viem
// WalletClient from wagmi's connected account for the actual contract writes.

import { createPublicClient, http, type Abi, type Chain, type PublicClient } from "viem";
import { celo } from "viem/chains";
import { writeContract } from "@wagmi/core";
import { CHAIN_ID, RPC_URL, FEE_CURRENCY } from "./config";
import { wagmiAdapter } from "./appkit-config";

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

export const publicClient: PublicClient = createPublicClient({ chain, transport: http(RPC_URL) });

// Gas-in-stablecoin only makes sense on mainnet MiniPay; undefined elsewhere.
export function feeCurrencyOpt(): { feeCurrency?: `0x${string}` } {
  if (CHAIN_ID === 42220 && FEE_CURRENCY) return { feeCurrency: FEE_CURRENCY as `0x${string}` };
  return {};
}

/* eslint-disable @typescript-eslint/no-explicit-any */
// One place to send a contract write. Goes through wagmi's own `writeContract` action (not a
// raw viem WalletClient) — it resolves the client via the active connector and only asserts
// the current chain when a chainId is explicitly passed. Reown/WalletConnect's provider reports
// the chain as a CAIP-2 string (e.g. "eip155:42220"), which raw viem's chain assertion can't
// parse; omitting chainId here sidesteps that entirely instead of fighting the format mismatch.
// `feeCurrency` (Celo CIP-64) isn't in wagmi's generic writeContract type, so we cast through.
export async function sendWrite(
  account: `0x${string}`,
  params: { address: `0x${string}`; abi: Abi; functionName: string; args?: readonly unknown[] },
): Promise<`0x${string}`> {
  return writeContract(wagmiAdapter.wagmiConfig, { account, ...params, ...feeCurrencyOpt() } as any) as Promise<`0x${string}`>;
}
