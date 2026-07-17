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
// Pick an injected provider. Some browsers expose several under window.ethereum.providers;
// prefer MiniPay, then MetaMask, else the first one.
function ethereum(): any {
  if (typeof window === "undefined") return undefined;
  const eth = (window as any).ethereum;
  if (!eth) return undefined;
  if (Array.isArray(eth.providers) && eth.providers.length) {
    return (
      eth.providers.find((p: any) => p.isMiniPay) ||
      eth.providers.find((p: any) => p.isMetaMask) ||
      eth.providers[0]
    );
  }
  return eth;
}

// The chosen injected provider (for account/event subscriptions in the wallet context).
export function injectedProvider(): any {
  return ethereum();
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

const CHAIN_HEX = "0x" + CHAIN_ID.toString(16);

// Best-effort: put the wallet on the right Celo network (adds it if unknown).
async function ensureChain(eth: any): Promise<void> {
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
  } catch (e: any) {
    if (e?.code === 4902 || /nrecognized|not.*added|unknown chain/i.test(e?.message || "")) {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: CHAIN_HEX,
            chainName: CHAIN_ID === 42220 ? "Celo" : "Celo Sepolia",
            nativeCurrency: { name: "CELO", symbol: "CELO", decimals: 18 },
            rpcUrls: [RPC_URL],
            blockExplorerUrls: [
              CHAIN_ID === 42220 ? "https://celoscan.io" : "https://celo-sepolia.blockscout.com",
            ],
          },
        ],
      });
    }
  }
}

export async function connect(): Promise<`0x${string}`> {
  const eth = ethereum();
  if (!eth) {
    throw new Error(
      "No wallet detected. On desktop install MetaMask; on phone open WordBreak inside MiniPay or Valora.",
    );
  }
  const accounts: string[] = await eth.request({ method: "eth_requestAccounts" });
  const address = accounts?.[0];
  if (!address) throw new Error("Wallet connected but returned no account.");
  await ensureChain(eth).catch(() => {}); // don't block connect if network switch is declined
  return address as `0x${string}`;
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
