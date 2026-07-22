// Runtime config, all from NEXT_PUBLIC_* env. Defaults target Celo Sepolia testnet.

export const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || "11142220"); // Celo Sepolia
export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL || "https://forno.celo-sepolia.celo-testnet.org";

export const POOLS_ADDRESS = (process.env.NEXT_PUBLIC_POOLS_ADDRESS || "") as `0x${string}`;
export const CUSD_ADDRESS = (process.env.NEXT_PUBLIC_CUSD_ADDRESS || "") as `0x${string}`;

// WordBreakArena — no backend, so this is the only config the on-chain battle-royale game
// needs. Its entry token is read live from the contract's own immutable `token()` rather than
// hardcoded here, since a given deployment could use any ERC-20 (this session's Sepolia
// deployment uses native CELO's ERC-20 wrapper, not cUSD).
export const ARENA_ADDRESS = (process.env.NEXT_PUBLIC_ARENA_ADDRESS || "") as `0x${string}`;
export const isArenaConfigured = () => Boolean(ARENA_ADDRESS);

// Optional: pay gas in a stablecoin (Celo CIP-64). Only used on mainnet (chainId 42220),
// where MiniPay expects it. On testnet, leave unset and pay gas in CELO.
export const FEE_CURRENCY = (process.env.NEXT_PUBLIC_FEE_CURRENCY || "") as `0x${string}` | "";

// Recipient of "buy more time" payments (defaults to the pool treasury address if set).
export const TREASURY = (process.env.NEXT_PUBLIC_TREASURY || "") as `0x${string}`;
// Price of +30s, in cUSD base units (18 dp). Default 0.05 cUSD.
export const CONTINUE_PRICE = BigInt(process.env.NEXT_PUBLIC_CONTINUE_PRICE || "50000000000000000");
export const CONTINUE_SECONDS = Number(process.env.NEXT_PUBLIC_CONTINUE_SECONDS || "30");

export const isConfigured = () => Boolean(POOLS_ADDRESS && CUSD_ADDRESS);

// WalletConnect (QR pairing) — passed through to Privy so its "wallet" login option can
// pair with mobile wallets that don't inject window.ethereum. Get a project ID from
// https://dashboard.walletconnect.com. Unset = WalletConnect pairing is inert, no behavior change.
export const WC_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "";

// Privy (email/social login + embedded wallet). Get an App ID from https://dashboard.privy.io.
// Unset = createAppKit-equivalent init is skipped; see app/providers.tsx.
export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID || "";
