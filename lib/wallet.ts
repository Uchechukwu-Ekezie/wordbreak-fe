// Wallet + chain plumbing. Plain viem over window.ethereum — MiniPay injects it and
// auto-connects; no wagmi/connector libraries needed (per Celo's MiniPay guide).
//
// WalletConnect (below) is an additive fallback for wallets that don't inject a provider
// (desktop browsers, mobile wallets connecting via QR scan). It's just another EIP-1193
// provider — @walletconnect/ethereum-provider implements the same .request()/.on() shape as
// window.ethereum, so it slots into the same viem custom() transport. No wagmi, no ethers,
// no connect-modal UI framework. Dynamically imported so MiniPay users (the majority) never
// pay for its bundle.

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
import { CHAIN_ID, RPC_URL, FEE_CURRENCY, WC_PROJECT_ID } from "./config";

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

// ---- WalletConnect (additive fallback when there's no injected provider) ----

let wcProvider: any = null;
let wcInitPromise: Promise<any> | null = null;
let activeSource: "injected" | "walletconnect" = "injected";

async function getWalletConnectProvider(): Promise<any> {
  if (wcProvider) return wcProvider;
  if (!wcInitPromise) {
    wcInitPromise = import("@walletconnect/ethereum-provider").then(({ EthereumProvider }) =>
      EthereumProvider.init({
        projectId: WC_PROJECT_ID,
        chains: [CHAIN_ID],
        showQrModal: true,
        rpcMap: { [CHAIN_ID]: RPC_URL },
        metadata: {
          name: "WordBreak",
          description: "Spell words. Smash bricks. Win cUSD.",
          url: "https://wordbreak-fe.vercel.app",
          icons: ["https://wordbreak-fe.vercel.app/icon.png"],
        },
      }),
    );
  }
  wcProvider = await wcInitPromise;
  return wcProvider;
}

// The provider whose transport walletClient()/sendWrite() should use right now.
function activeProvider(): any {
  return activeSource === "walletconnect" ? wcProvider : ethereum();
}

// Best-effort, silent: if a WalletConnect session already exists from a previous visit,
// restore it without popping the QR modal again. Only runs when there's no injected wallet —
// the MiniPay-majority case never pays this SDK's bootstrap cost.
export async function restoreWalletConnectSession(): Promise<`0x${string}` | null> {
  if (hasWallet() || !WC_PROJECT_ID) return null;
  try {
    const p = await getWalletConnectProvider();
    if (p.session && p.accounts?.[0]) {
      activeSource = "walletconnect";
      return p.accounts[0] as `0x${string}`;
    }
  } catch {
    /* best-effort — a broken/expired persisted session just means no silent restore */
  }
  return null;
}

// Ends a WalletConnect pairing session properly (local state alone would leave it dangling).
// No-op for the injected-provider path — there's no "session" to tear down there.
export async function disconnectActive(): Promise<void> {
  if (activeSource === "walletconnect" && wcProvider) {
    try {
      await wcProvider.disconnect();
    } catch {
      /* best-effort */
    }
  }
  activeSource = "injected";
}

// Subscribes to the currently active provider's account/disconnect events. Returns an
// unsubscribe function. Call again after any successful connect() — the active provider may
// have changed.
export function subscribeActiveProviderEvents(
  onAccountsChanged: (accounts: string[]) => void,
  onDisconnect: () => void,
): () => void {
  const p = activeProvider();
  if (!p?.on) return () => {};
  p.on("accountsChanged", onAccountsChanged);
  p.on("disconnect", onDisconnect);
  return () => {
    p.removeListener?.("accountsChanged", onAccountsChanged);
    p.removeListener?.("disconnect", onDisconnect);
  };
}

export function walletClient(): WalletClient {
  const eth = activeProvider();
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

// Exported so callers can offer an explicit choice when more than one path is available
// (e.g. a desktop browser with both MetaMask installed and WalletConnect configured) instead
// of always silently picking one.
export async function connectInjected(): Promise<`0x${string}`> {
  const eth = ethereum();
  const accounts: string[] = await eth.request({ method: "eth_requestAccounts" });
  const address = accounts?.[0];
  if (!address) throw new Error("Wallet connected but returned no account.");
  await ensureChain(eth).catch(() => {}); // don't block connect if network switch is declined
  activeSource = "injected";
  return address as `0x${string}`;
}

export async function connectWalletConnect(): Promise<`0x${string}`> {
  const p = await getWalletConnectProvider();
  const accounts: string[] = await p.enable();
  const address = accounts?.[0];
  if (!address) throw new Error("Wallet connected but returned no account.");
  activeSource = "walletconnect";
  return address as `0x${string}`;
}

// True when the caller should offer a choice instead of auto-picking (both an injected
// wallet AND WalletConnect are available).
export function hasConnectChoice(): boolean {
  return hasWallet() && Boolean(WC_PROJECT_ID);
}

// Smart default for call sites that just need "get connected, whatever's available" (buy-time
// gates, staked-room gates, settings) — injected first, WalletConnect fallback, unchanged
// behavior when WC isn't configured. Primary "Connect" entry points (landing gate, daily page)
// use connectInjected/connectWalletConnect directly instead, to offer a real choice.
export async function connect(): Promise<`0x${string}`> {
  if (hasWallet()) return connectInjected();
  if (WC_PROJECT_ID) return connectWalletConnect();
  throw new Error(
    "No wallet detected. On desktop install MetaMask; on phone open WordBreak inside MiniPay or Valora.",
  );
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
