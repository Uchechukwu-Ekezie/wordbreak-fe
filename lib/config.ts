// Runtime config, all from NEXT_PUBLIC_* env. Defaults target Celo Sepolia testnet.

export const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || "11142220"); // Celo Sepolia
export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL || "https://forno.celo-sepolia.celo-testnet.org";

export const POOLS_ADDRESS = (process.env.NEXT_PUBLIC_POOLS_ADDRESS || "") as `0x${string}`;
export const CUSD_ADDRESS = (process.env.NEXT_PUBLIC_CUSD_ADDRESS || "") as `0x${string}`;

// Optional: pay gas in a stablecoin (Celo CIP-64). Only used on mainnet (chainId 42220),
// where MiniPay expects it. On testnet, leave unset and pay gas in CELO.
export const FEE_CURRENCY = (process.env.NEXT_PUBLIC_FEE_CURRENCY || "") as `0x${string}` | "";

// Recipient of "buy more time" payments (defaults to the pool treasury address if set).
export const TREASURY = (process.env.NEXT_PUBLIC_TREASURY || "") as `0x${string}`;
// Price of +30s, in cUSD base units (18 dp). Default 0.05 cUSD.
export const CONTINUE_PRICE = BigInt(process.env.NEXT_PUBLIC_CONTINUE_PRICE || "50000000000000000");
export const CONTINUE_SECONDS = Number(process.env.NEXT_PUBLIC_CONTINUE_SECONDS || "30");

export const isConfigured = () => Boolean(POOLS_ADDRESS && CUSD_ADDRESS);
