// Wallet + chain plumbing. Plain viem over window.ethereum — MiniPay injects it and
// auto-connects; no wagmi/connector libraries needed (per Celo's MiniPay guide).

import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Abi,
  type Chain,
  type PublicClient,
  type WalletClient,
} from "viem";
import { celo } from "viem/chains";
import { CHAIN_ID, RPC_URL, FEE_CURRENCY } from "./config";

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

/* eslint-disable @typescript-eslint/no-explicit-any */
function ethereum(): any {
  return typeof window !== "undefined" ? (window as any).ethereum : undefined;
}

export function isMiniPay(): boolean {
  return Boolean(ethereum()?.isMiniPay);
}

export function hasWallet(): boolean {
  return Boolean(ethereum());
}

export function walletClient(): WalletClient {
  const eth = ethereum();
  if (!eth) throw new Error("No wallet found");
  return createWalletClient({ chain, transport: custom(eth) });
}

export async function connect(): Promise<`0x${string}`> {
  const eth = ethereum();
  if (!eth) throw new Error("No wallet. Open this in MiniPay, or install a Celo wallet.");
  const accounts: string[] = await eth.request({ method: "eth_requestAccounts" });
  return accounts[0] as `0x${string}`;
}

// Gas-in-stablecoin only makes sense on mainnet MiniPay; undefined elsewhere.
export function feeCurrencyOpt(): { feeCurrency?: `0x${string}` } {
  if (CHAIN_ID === 42220 && FEE_CURRENCY) return { feeCurrency: FEE_CURRENCY as `0x${string}` };
  return {};
}

// One place to send a contract write. `feeCurrency` (Celo CIP-64) isn't in viem's generic
// writeContract type, so we cast through here rather than at every call site.
export async function sendWrite(
  account: `0x${string}`,
  params: { address: `0x${string}`; abi: Abi; functionName: string; args?: readonly unknown[] },
): Promise<`0x${string}`> {
  const wc = walletClient();
  return wc.writeContract({ account, chain, ...params, ...feeCurrencyOpt() } as any) as Promise<`0x${string}`>;
}
