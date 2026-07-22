// Wallet + chain plumbing. Privy (+ a plain wagmi config, see lib/wagmiConfig.ts) owns wallet
// connection — MiniPay/injected providers, WalletConnect QR pairing, and email/social login
// all go through one unified modal (see app/providers.tsx, app/wallet-provider.tsx). This file
// exposes what the game needs beyond that: a read-only viem publicClient, and sendWrite() which
// sends a contract write through wagmi's active connector.

import { createPublicClient, http, type Abi, type PublicClient } from "viem";
import { writeContract } from "@wagmi/core";
import { CHAIN_ID, RPC_URL, FEE_CURRENCY } from "./config";
import { chain, wagmiConfig } from "./wagmiConfig";

export { chain };

export const publicClient: PublicClient = createPublicClient({ chain, transport: http(RPC_URL) });

// Gas-in-stablecoin only makes sense on mainnet MiniPay; undefined elsewhere.
export function feeCurrencyOpt(): { feeCurrency?: `0x${string}` } {
  if (CHAIN_ID === 42220 && FEE_CURRENCY) return { feeCurrency: FEE_CURRENCY as `0x${string}` };
  return {};
}

/* eslint-disable @typescript-eslint/no-explicit-any */
// One place to send a contract write. Goes through wagmi's own `writeContract` action (not a
// raw viem WalletClient) — it resolves the client via the active connector and only asserts
// the current chain when a chainId is explicitly passed; omitting chainId here avoids that
// assertion entirely. `feeCurrency` (Celo CIP-64) isn't in wagmi's generic writeContract type,
// so we cast through.
export async function sendWrite(
  account: `0x${string}`,
  params: { address: `0x${string}`; abi: Abi; functionName: string; args?: readonly unknown[] },
): Promise<`0x${string}`> {
  return writeContract(wagmiConfig, { account, ...params, ...feeCurrencyOpt() } as any) as Promise<`0x${string}`>;
}
