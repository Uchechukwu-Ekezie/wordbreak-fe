/**
 * arena-driver.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * WordBreak Arena — Autonomous 15-wallet Battle Royale Driver
 *
 * Architecture follows the Universal On-Chain Transaction Driver blueprint:
 *  Pillar 1  – Dynamic Wallet Derivation from a single BIP-39 mnemonic (15 wallets)
 *  Pillar 2  – Smart Pre-Verification ("Checkmating") before every tx
 *  Pillar 3  – Self-Healing RPC with exponential back-off
 *  Pillar 4  – Local State Persistence (driver-arena-cache.json)
 *  Pillar 5  – Micro-unit awareness & cUSD stablecoin handling
 *  Pillar 6  – Liquidity Injection — auto-create a fresh room when none are joinable
 *  Pillar 7  – Decoupled while(true) loop with randomised wallet selection
 *  Pillar 8  – Strictly Enforced Approval Chains (await receipt before joinRoom)
 *  Pillar 9  – Dynamic Gas Estimation with 30 % safety buffer
 *  Pillar 10 – Master Sweeper: fund all 15 derived wallets from one master key
 *  Pillar 11 – Optional feeCurrency (pay gas in cUSD via Celo CIP-64)
 *
 * Usage:
 *   # Normal autonomous play loop
 *   npx tsx arena-driver.ts run
 *
 *   # Fund all 15 derived wallets from MASTER_PRIVATE_KEY before first run
 *   npx tsx arena-driver.ts sweep
 *
 *   # Start the current active room (if >= minPlayers have joined and deadline passed)
 *   npx tsx arena-driver.ts start <roomId>
 *
 *   # End the current round (permissionless keeper call)
 *   npx tsx arena-driver.ts end-round <roomId>
 *
 *   # Claim winnings for all wallets
 *   npx tsx arena-driver.ts claim-all
 *
 *   # Print all 15 derived wallet addresses (no private keys)
 *   npx tsx arena-driver.ts print-wallets
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as dotenv from "dotenv";
import { mnemonicToAccount } from "viem/accounts";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  parseAbi,
  type Address,
  type WalletClient,
  type PublicClient,
  type Chain,
} from "viem";
import { celo, celoAlfajores } from "viem/chains";

// ─── Resolve __dirname for ESM ──────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, ".env") });

// ─────────────────────────────────────────────────────────────────────────────
// 0. CONFIG  (all values read from .env — never hardcoded)
// ─────────────────────────────────────────────────────────────────────────────

const RPC_URL = process.env.RPC_URL ?? "https://forno.celo-sepolia.celo-testnet.org";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? "11142220");
const ARENA_ADDRESS = (process.env.ARENA_ADDRESS ?? "") as Address;
// CELO's native ERC-20 address (no contract changes needed — CELO is already an ERC-20 on Celo).
// Mainnet:     0x471EcE3750Da237f93B8E339c536989b8978a438
// Alfajores:   0xF194afDf50B03e69Bd7D057c1Aa9e10c9954E4C
// Celo Sepolia: 0x5ac7FB5CD696f01E6B38ad7e40b2c0d9a4A2e3E9 (check latest — may vary)
const TOKEN_ADDRESS = (
  process.env.TOKEN_ADDRESS ?? "0xF194afDf50B03e69Bd7D057c1Aa9e10c9954E4C"
) as Address; // Alfajores CELO ERC-20 default
const FEE_CURRENCY = (process.env.FEE_CURRENCY ?? "") as Address | "";
const MASTER_PRIVATE_KEY = process.env.MASTER_PRIVATE_KEY ?? "";
const DRIVER_MNEMONIC = process.env.DRIVER_MNEMONIC ?? "";

// How many wallets to derive from the mnemonic (15 gladiators)
const WALLET_COUNT = 15;

// Arena game parameters for creating a new room (Pillar 6: liquidity injection)
const ENTRY_FEE_CELO = process.env.ENTRY_FEE_CELO ?? "0.005";    // 0.005 CELO per player
const MIN_PLAYERS = Number(process.env.MIN_PLAYERS ?? "3");
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS ?? "15");
const JOIN_DEADLINE_SECS = Number(process.env.JOIN_DEADLINE_SECS ?? "300");   // 5-min join window
const ROUND_DURATION_SECS = Number(process.env.ROUND_DURATION_SECS ?? "120"); // 2 min per round

const CACHE_FILE = path.join(__dirname, "driver-arena-cache.json");

// Human-latency randomised delay between loop iterations: 10–25 s (Pillar 7)
const DELAY_MIN_MS = 10_000;
const DELAY_MAX_MS = 25_000;

// ─────────────────────────────────────────────────────────────────────────────
// ABI FRAGMENTS
// ─────────────────────────────────────────────────────────────────────────────

// Using JSON ABI for getRoom because abitype's parseAbi doesn't support
// named-component tuple returns in human-readable form.
const ARENA_ABI = [
  // ── Views ──
  {
    type: "function",
    name: "getRoom",
    stateMutability: "view",
    inputs: [{ name: "roomId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "entryFee", type: "uint128" },
          { name: "joinDeadline", type: "uint64" },
          { name: "maxPlayers", type: "uint16" },
          { name: "minPlayers", type: "uint16" },
          { name: "rakeBps", type: "uint16" },
          { name: "roundDuration", type: "uint32" },
          { name: "currentRound", type: "uint32" },
          { name: "roundEndTime", type: "uint64" },
          { name: "tiedStreak", type: "uint16" },
          { name: "state", type: "uint8" },
          { name: "winner", type: "address" },
          { name: "rack", type: "bytes32" },
          { name: "pot", type: "uint256" },
        ],
      },
    ],
  },
  ...parseAbi([
    "function getActivePlayers(uint256 roomId) view returns (address[])",
    "function getRoundScore(uint256 roomId, address player) view returns (uint16)",
    "function isActive(uint256 roomId, address player) view returns (bool)",
    "function claimable(address account) view returns (uint256)",
    "function nextRoomId() view returns (uint256)",
    // Mutating
    "function createRoom(uint128 entryFee, uint16 maxPlayers, uint16 minPlayers, uint64 joinDeadline, uint32 roundDuration) returns (uint256 roomId)",
    "function joinRoom(uint256 roomId)",
    "function startRoom(uint256 roomId)",
    "function submitWord(uint256 roomId, bytes word)",
    "function endRound(uint256 roomId)",
    "function claim()",
    "function cancelRoom(uint256 roomId)",
  ]),
] as const;

const ERC20_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

// RoomState mirrors the contract enum
const RoomState: Record<number, string> = {
  0: "NonExistent",
  1: "Open",
  2: "Active",
  3: "Cancelled",
  4: "Finished",
};

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

interface Gladiator {
  index: number;
  label: string;
  address: Address;
  walletClient: WalletClient;
}

interface Cache {
  activeRoomId: number | null;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. LOCAL STATE PERSISTENCE
// ─────────────────────────────────────────────────────────────────────────────

function loadCache(): Cache {
  if (fs.existsSync(CACHE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as Cache;
    } catch {
      /* corrupt cache — start fresh */
    }
  }
  return { activeRoomId: null };
}

function saveCache(data: Partial<Cache>): void {
  const current = loadCache();
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ ...current, ...data }, null, 2));
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. SELF-HEALING RPC WRAPPER (exponential back-off)
// ─────────────────────────────────────────────────────────────────────────────

async function withRetry<T>(fn: () => Promise<T>, label: string, maxRetries = 5): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      if (attempt === maxRetries) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      const waitMs = Math.pow(2, attempt) * 1000 + Math.random() * 500;
      console.log(
        `  ⚠️  [${label}] RPC error (${attempt + 1}/${maxRetries}): ${msg.slice(0, 100)}`
      );
      console.log(`     Backing off ${(waitMs / 1000).toFixed(1)}s…`);
      await sleep(waitMs);
    }
  }
  throw new Error("withRetry: exhausted");
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. DYNAMIC GAS ESTIMATION — pad by 30 %
// ─────────────────────────────────────────────────────────────────────────────

async function estimateGas(
  publicClient: PublicClient,
  params: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
    account: Address;
    feeCurrency?: Address;
  }
): Promise<bigint> {
  try {
    const raw = await publicClient.estimateContractGas(
      params as Parameters<typeof publicClient.estimateContractGas>[0]
    );
    return (raw * 130n) / 100n; // +30 % safety buffer
  } catch {
    return 600_000n; // generous safe fallback
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function humanDelay(): Promise<void> {
  const ms = DELAY_MIN_MS + Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS);
  console.log(`  💤  Human-latency pause — ${(ms / 1000).toFixed(1)}s\n`);
  return sleep(ms);
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Word pool: common 3-letter words from standard Scrabble letter distribution ──
const WORD_POOL = [
  "CAT", "BAT", "RAT", "TAR", "ART", "TAN", "ANT", "NAP", "PAN", "LAP",
  "PAL", "SAP", "SAT", "GAP", "TAG", "TAP", "PAT", "MAP", "MAT", "MAN",
  "RAM", "RAN", "RAP", "NAB", "BAN", "CAN", "CAP", "CAB", "LAD", "LAB",
  "BAD", "MAD", "DAM", "ADD", "NAN", "GAT", "LAG", "LAM", "TAD", "TAB",
  "MAR", "MAG", "NAG", "GAB", "BAG", "SAG", "PAD", "RAG", "LAX", "TAX",
];

/** Convert word string to 0x-prefixed hex bytes for submitWord */
function wordToBytes(word: string): `0x${string}` {
  return ("0x" + Buffer.from(word.toUpperCase(), "ascii").toString("hex")) as `0x${string}`;
}

/**
 * Check whether every letter in `word` appears in the 10-byte rack.
 * rack is a bytes32 left-packed with ASCII uppercase letters.
 */
function wordFitsRack(word: string, rackHex: string): boolean {
  const rackBuf = Buffer.from(rackHex.replace(/^0x/, ""), "hex").slice(0, 10);
  const counts: Record<string, number> = {};
  for (const b of rackBuf) {
    if (b === 0) break;
    const ch = String.fromCharCode(b);
    counts[ch] = (counts[ch] ?? 0) + 1;
  }
  for (const ch of word.toUpperCase()) {
    if (!counts[ch]) return false;
    counts[ch]--;
  }
  return true;
}

/** Pick a random valid word that fits the current rack */
function pickWord(rackHex: string): string | null {
  for (const w of shuffle(WORD_POOL)) {
    if (wordFitsRack(w, rackHex)) return w;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CHAIN + VIEM CLIENT SETUP
// ─────────────────────────────────────────────────────────────────────────────

function buildChain(): Chain {
  if (CHAIN_ID === 42220) return celo;
  return {
    ...celoAlfajores,
    id: CHAIN_ID,
    rpcUrls: {
      default: { http: [RPC_URL] },
      public: { http: [RPC_URL] },
    },
  } as Chain;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. DYNAMIC WALLET DERIVATION — 15 gladiators from BIP-39 mnemonic
// ─────────────────────────────────────────────────────────────────────────────

function deriveGladiators(mnemonic: string): Gladiator[] {
  const chain = buildChain();
  const gladiators: Gladiator[] = [];

  for (let i = 0; i < WALLET_COUNT; i++) {
    const account = mnemonicToAccount(mnemonic, { addressIndex: i });
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(RPC_URL),
    });
    gladiators.push({
      index: i,
      label: `Gladiator-${String(i).padStart(2, "0")}`,
      address: account.address,
      walletClient,
    });
  }
  return gladiators;
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. STRICTLY ENFORCED APPROVAL CHAIN
// ─────────────────────────────────────────────────────────────────────────────

async function ensureApproval(
  publicClient: PublicClient,
  gladiator: Gladiator,
  spender: Address,
  amount: bigint
): Promise<void> {
  const allowance = await withRetry(
    () =>
      publicClient.readContract({
        address: TOKEN_ADDRESS,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [gladiator.address, spender],
      }),
    `${gladiator.label}:allowance`
  );

  if ((allowance as bigint) >= amount) {
    console.log(`  ✅  ${gladiator.label}: allowance already sufficient`);
    return;
  }

  console.log(
    `  🔑  ${gladiator.label}: approving ${formatUnits(amount, 18)} CELO to ${spender}…`
  );

  const gasLimit = await estimateGas(publicClient, {
    address: TOKEN_ADDRESS,
    abi: ERC20_ABI as readonly unknown[],
    functionName: "approve",
    args: [spender, amount],
    account: gladiator.address,
    ...(FEE_CURRENCY ? { feeCurrency: FEE_CURRENCY as Address } : {}),
  });

  const approveHash = await gladiator.walletClient.writeContract({
    address: TOKEN_ADDRESS,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [spender, amount],
    gas: gasLimit,
    ...(FEE_CURRENCY ? { feeCurrency: FEE_CURRENCY as Address } : {}),
  } as Parameters<WalletClient["writeContract"]>[0]);

  console.log(`     ⏳  Waiting for approve receipt: ${approveHash}`);
  await withRetry(
    () => publicClient.waitForTransactionReceipt({ hash: approveHash as `0x${string}` }),
    `${gladiator.label}:approveReceipt`
  );
  console.log(`     ✅  Approval confirmed. Safe to proceed.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. LIQUIDITY INJECTION — create a fresh room
// ─────────────────────────────────────────────────────────────────────────────

async function createRoom(publicClient: PublicClient, gladiator: Gladiator): Promise<number> {
  const entryFee = parseUnits(ENTRY_FEE_CELO, 18);
  const joinDeadline = BigInt(Math.floor(Date.now() / 1000) + JOIN_DEADLINE_SECS);

  console.log(`\n  🏟️  ${gladiator.label}: creating new arena room (liquidity injection)…`);
  console.log(
    `     entryFee=${ENTRY_FEE_CELO} CELO | players=${MIN_PLAYERS}-${MAX_PLAYERS} | join=+${JOIN_DEADLINE_SECS}s | round=${ROUND_DURATION_SECS}s`
  );

  const gasLimit = await estimateGas(publicClient, {
    address: ARENA_ADDRESS,
    abi: ARENA_ABI as readonly unknown[],
    functionName: "createRoom",
    args: [entryFee, MAX_PLAYERS, MIN_PLAYERS, joinDeadline, BigInt(ROUND_DURATION_SECS)],
    account: gladiator.address,
  });

  const hash = await gladiator.walletClient.writeContract({
    address: ARENA_ADDRESS,
    abi: ARENA_ABI,
    functionName: "createRoom",
    args: [entryFee, MAX_PLAYERS, MIN_PLAYERS, joinDeadline, BigInt(ROUND_DURATION_SECS)],
    gas: gasLimit,
    ...(FEE_CURRENCY ? { feeCurrency: FEE_CURRENCY as Address } : {}),
  } as Parameters<WalletClient["writeContract"]>[0]);

  await withRetry(
    () => publicClient.waitForTransactionReceipt({ hash: hash as `0x${string}` }),
    `${gladiator.label}:createRoom`
  );

  const nextId = (await withRetry(
    () => publicClient.readContract({ address: ARENA_ADDRESS, abi: ARENA_ABI, functionName: "nextRoomId" }),
    "nextRoomId"
  )) as bigint;
  const roomId = Number(nextId) - 1;

  console.log(`  ✅  Room ${roomId} created. tx: ${hash}`);
  return roomId;
}

// ─────────────────────────────────────────────────────────────────────────────
// JOIN ROOM
// ─────────────────────────────────────────────────────────────────────────────

async function joinRoom(
  publicClient: PublicClient,
  gladiator: Gladiator,
  roomId: number,
  entryFee: bigint
): Promise<void> {
  // Pillar 8: ensure approval before join
  await ensureApproval(publicClient, gladiator, ARENA_ADDRESS, entryFee);

  console.log(`  ⚔️  ${gladiator.label}: joining room ${roomId}…`);

  const gasLimit = await estimateGas(publicClient, {
    address: ARENA_ADDRESS,
    abi: ARENA_ABI as readonly unknown[],
    functionName: "joinRoom",
    args: [BigInt(roomId)],
    account: gladiator.address,
  });

  const hash = await gladiator.walletClient.writeContract({
    address: ARENA_ADDRESS,
    abi: ARENA_ABI,
    functionName: "joinRoom",
    args: [BigInt(roomId)],
    gas: gasLimit,
    ...(FEE_CURRENCY ? { feeCurrency: FEE_CURRENCY as Address } : {}),
  } as Parameters<WalletClient["writeContract"]>[0]);

  await withRetry(
    () => publicClient.waitForTransactionReceipt({ hash: hash as `0x${string}` }),
    `${gladiator.label}:joinRoom`
  );
  console.log(`     ✅  ${gladiator.label} joined room ${roomId}. tx: ${hash}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// SUBMIT WORD
// ─────────────────────────────────────────────────────────────────────────────

async function submitWord(
  publicClient: PublicClient,
  gladiator: Gladiator,
  roomId: number,
  rackHex: string
): Promise<void> {
  const word = pickWord(rackHex);
  if (!word) {
    console.log(`  🤐  ${gladiator.label}: no word fits rack ${rackHex.slice(0, 22)}… — skipping`);
    return;
  }

  console.log(`  📝  ${gladiator.label}: submitting word "${word}" for room ${roomId}…`);

  const wordBytes = wordToBytes(word);
  const gasLimit = await estimateGas(publicClient, {
    address: ARENA_ADDRESS,
    abi: ARENA_ABI as readonly unknown[],
    functionName: "submitWord",
    args: [BigInt(roomId), wordBytes],
    account: gladiator.address,
  });

  const hash = await gladiator.walletClient.writeContract({
    address: ARENA_ADDRESS,
    abi: ARENA_ABI,
    functionName: "submitWord",
    args: [BigInt(roomId), wordBytes],
    gas: gasLimit,
    ...(FEE_CURRENCY ? { feeCurrency: FEE_CURRENCY as Address } : {}),
  } as Parameters<WalletClient["writeContract"]>[0]);

  await withRetry(
    () => publicClient.waitForTransactionReceipt({ hash: hash as `0x${string}` }),
    `${gladiator.label}:submitWord`
  );
  console.log(`     ✅  "${word}" submitted by ${gladiator.label}. tx: ${hash}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// START ROOM (permissionless keeper)
// ─────────────────────────────────────────────────────────────────────────────

async function startRoom(
  publicClient: PublicClient,
  gladiator: Gladiator,
  roomId: number
): Promise<void> {
  console.log(`  🚀  ${gladiator.label}: starting room ${roomId}…`);

  const gasLimit = await estimateGas(publicClient, {
    address: ARENA_ADDRESS,
    abi: ARENA_ABI as readonly unknown[],
    functionName: "startRoom",
    args: [BigInt(roomId)],
    account: gladiator.address,
  });

  const hash = await gladiator.walletClient.writeContract({
    address: ARENA_ADDRESS,
    abi: ARENA_ABI,
    functionName: "startRoom",
    args: [BigInt(roomId)],
    gas: gasLimit,
    ...(FEE_CURRENCY ? { feeCurrency: FEE_CURRENCY as Address } : {}),
  } as Parameters<WalletClient["writeContract"]>[0]);

  await withRetry(
    () => publicClient.waitForTransactionReceipt({ hash: hash as `0x${string}` }),
    `${gladiator.label}:startRoom`
  );
  console.log(`     ✅  Room ${roomId} started. tx: ${hash}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// CANCEL ROOM (permissionless keeper)
// ─────────────────────────────────────────────────────────────────────────────

async function cancelRoom(
  publicClient: PublicClient,
  gladiator: Gladiator,
  roomId: number
): Promise<void> {
  console.log(`  🗑️  ${gladiator.label}: cancelling stale room ${roomId}…`);

  const gasLimit = await estimateGas(publicClient, {
    address: ARENA_ADDRESS,
    abi: ARENA_ABI as readonly unknown[],
    functionName: "cancelRoom",
    args: [BigInt(roomId)],
    account: gladiator.address,
  });

  const hash = await gladiator.walletClient.writeContract({
    address: ARENA_ADDRESS,
    abi: ARENA_ABI,
    functionName: "cancelRoom",
    args: [BigInt(roomId)],
    gas: gasLimit,
    ...(FEE_CURRENCY ? { feeCurrency: FEE_CURRENCY as Address } : {}),
  } as Parameters<WalletClient["writeContract"]>[0]);

  await withRetry(
    () => publicClient.waitForTransactionReceipt({ hash: hash as `0x${string}` }),
    `${gladiator.label}:cancelRoom`
  );
  console.log(`     ✅  Room ${roomId} cancelled. tx: ${hash}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// END ROUND (permissionless keeper)
// ─────────────────────────────────────────────────────────────────────────────

async function endRound(
  publicClient: PublicClient,
  gladiator: Gladiator,
  roomId: number
): Promise<void> {
  console.log(`  🔔  ${gladiator.label}: ending round for room ${roomId}…`);

  const gasLimit = await estimateGas(publicClient, {
    address: ARENA_ADDRESS,
    abi: ARENA_ABI as readonly unknown[],
    functionName: "endRound",
    args: [BigInt(roomId)],
    account: gladiator.address,
  });

  const hash = await gladiator.walletClient.writeContract({
    address: ARENA_ADDRESS,
    abi: ARENA_ABI,
    functionName: "endRound",
    args: [BigInt(roomId)],
    gas: gasLimit,
    ...(FEE_CURRENCY ? { feeCurrency: FEE_CURRENCY as Address } : {}),
  } as Parameters<WalletClient["writeContract"]>[0]);

  await withRetry(
    () => publicClient.waitForTransactionReceipt({ hash: hash as `0x${string}` }),
    `${gladiator.label}:endRound`
  );
  console.log(`     ✅  Round ended. tx: ${hash}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// CLAIM WINNINGS
// ─────────────────────────────────────────────────────────────────────────────

async function claimWinnings(publicClient: PublicClient, gladiator: Gladiator): Promise<void> {
  const pending = (await withRetry(
    () =>
      publicClient.readContract({
        address: ARENA_ADDRESS,
        abi: ARENA_ABI,
        functionName: "claimable",
        args: [gladiator.address],
      }),
    `${gladiator.label}:claimable`
  )) as bigint;

  if (pending === 0n) {
    console.log(`  💰  ${gladiator.label}: nothing to claim.`);
    return;
  }

  console.log(`  💰  ${gladiator.label}: claiming ${formatUnits(pending, 18)} CELO…`);

  const gasLimit = await estimateGas(publicClient, {
    address: ARENA_ADDRESS,
    abi: ARENA_ABI as readonly unknown[],
    functionName: "claim",
    args: [],
    account: gladiator.address,
  });

  const hash = await gladiator.walletClient.writeContract({
    address: ARENA_ADDRESS,
    abi: ARENA_ABI,
    functionName: "claim",
    args: [],
    gas: gasLimit,
    ...(FEE_CURRENCY ? { feeCurrency: FEE_CURRENCY as Address } : {}),
  } as Parameters<WalletClient["writeContract"]>[0]);

  await withRetry(
    () => publicClient.waitForTransactionReceipt({ hash: hash as `0x${string}` }),
    `${gladiator.label}:claim`
  );
  console.log(`     ✅  Claimed ${formatUnits(pending, 18)} CELO. tx: ${hash}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. MASTER SWEEPER — fund all 15 derived wallets
// ─────────────────────────────────────────────────────────────────────────────

async function sweep(publicClient: PublicClient, gladiators: Gladiator[]): Promise<void> {
  if (!MASTER_PRIVATE_KEY) {
    console.error("❌  MASTER_PRIVATE_KEY not set in .env — cannot sweep.");
    process.exit(1);
  }

  const chain = buildChain();
  const { privateKeyToAccount } = await import("viem/accounts");
  const master = privateKeyToAccount(MASTER_PRIVATE_KEY as `0x${string}`);
  const masterWc = createWalletClient({ account: master, chain, transport: http(RPC_URL) });

  // Entry CELO: 0.005 CELO × 40 entries = 0.2 CELO per wallet for entries
  // Gas CELO:   0.05 CELO covers hundreds of transactions
  const gasCeloPerWallet = parseUnits("0.05", 18);  // gas buffer
  const entryCeloPerWallet = parseUnits("0.2", 18);   // 40 entries at 0.005 CELO each
  const totalPerWallet = gasCeloPerWallet + entryCeloPerWallet; // 0.25 CELO total

  console.log(`\n🌊  MASTER SWEEPER — funding ${gladiators.length} gladiators`);
  console.log(`   Master wallet: ${master.address}`);
  console.log(`   Per wallet: 0.25 CELO (0.05 gas + 0.2 entry budget @ 0.005 CELO/entry)\n`);

  for (const g of gladiators) {
    // Send 0.25 CELO total (gas + entry budget) in a single native transfer.
    // Because CELO is also an ERC-20, the contract's safeTransferFrom pulls from
    // the ERC-20 balance — which is the same balance as the native CELO balance.
    const hash = await withRetry(
      () => masterWc.sendTransaction({ to: g.address, value: totalPerWallet }),
      `sweep:${g.label}`
    );
    await publicClient.waitForTransactionReceipt({ hash: hash as `0x${string}` });
    console.log(`  ✅  ${g.label} (${g.address}) — 0.25 CELO sent. tx: ${hash}`);
  }

  console.log("\n🏁  Sweep complete. All 15 gladiators funded.\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. MAIN AUTONOMOUS LOOP
// ─────────────────────────────────────────────────────────────────────────────

let totalWins = 0;

async function runLoop(publicClient: PublicClient, gladiators: Gladiator[]): Promise<void> {
  console.log(`\n⚔️  WordBreak Arena Driver — RUNNING`);
  console.log(`   Chain: ${CHAIN_ID} | RPC: ${RPC_URL}`);
  console.log(`   Arena: ${ARENA_ADDRESS}`);
  console.log(`   Gladiators (${gladiators.length}):`);
  gladiators.forEach((g) => console.log(`     [${String(g.index).padStart(2, "0")}] ${g.label}: ${g.address}`));
  console.log("");

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      // ── Pillar 7: randomly select a gladiator ────────────────────────────
      const g = gladiators[Math.floor(Math.random() * gladiators.length)];
      console.log(`\n🤖  [${g.label}] Analysing arena state…`);

      const cache = loadCache();
      let roomId = cache.activeRoomId;

      // ── 2. CHECKMATE: read room state before doing anything ──────────────
      if (roomId !== null) {
        let room: Record<string, unknown>;
        try {
          room = (await withRetry(
            () =>
              publicClient.readContract({
                address: ARENA_ADDRESS,
                abi: ARENA_ABI,
                functionName: "getRoom",
                args: [BigInt(roomId!)],
              }),
            `getRoom:${roomId}`
          )) as Record<string, unknown>;
        } catch {
          // Room doesn't exist yet on-chain (freshly deployed, no rooms)
          console.log(`  ℹ️  Room ${roomId} not found on-chain. Resetting.`);
          saveCache({ activeRoomId: null });
          roomId = null;
          room = {} as Record<string, unknown>;
        }

        if (roomId !== null) {
          const state = Number(room.state);
          const stateLabel = RoomState[state] ?? "Unknown";
          console.log(`  📊  Room ${roomId} state: ${stateLabel}`);

          if (state === 3 /* Cancelled */ || state === 4 /* Finished */) {
            console.log(`  ℹ️  Room ${roomId} is ${stateLabel}. Clearing cached room.`);
            saveCache({ activeRoomId: null });
            roomId = null;

          } else if (state === 1 /* Open */) {
            // ── Try to join if this gladiator hasn't yet ─────────────────
            const alreadyIn = (await withRetry(
              () =>
                publicClient.readContract({
                  address: ARENA_ADDRESS,
                  abi: ARENA_ABI,
                  functionName: "isActive",
                  args: [BigInt(roomId!), g.address],
                }),
              `isActive:${g.label}`
            )) as boolean;

            const now = BigInt(Math.floor(Date.now() / 1000));
            const deadline = room.joinDeadline as bigint;
            const entryFee = room.entryFee as bigint;

            if (!alreadyIn && now < deadline) {
              await joinRoom(publicClient, g, roomId!, entryFee);
            } else if (alreadyIn) {
              console.log(`  ✔️  ${g.label} already in room ${roomId}.`);
            } else {
              console.log(`  ⏰  Join deadline has passed for room ${roomId}.`);
            }

            // ── Try to start room if conditions are met ──────────────────
            const players = (await withRetry(
              () =>
                publicClient.readContract({
                  address: ARENA_ADDRESS,
                  abi: ARENA_ABI,
                  functionName: "getActivePlayers",
                  args: [BigInt(roomId!)],
                }),
              `getActivePlayers:${roomId}`
            )) as Address[];

            const playerCount = players.length;
            const minP = Number(room.minPlayers);
            const maxP = Number(room.maxPlayers);
            const canStart =
              playerCount >= maxP || (playerCount >= minP && now >= deadline);
            const canCancel = playerCount < minP && now >= deadline;

            console.log(
              `  👥  Room ${roomId}: ${playerCount}/${maxP} players (min=${minP})`
            );

            if (canStart) {
              await startRoom(publicClient, g, roomId!);
            } else if (canCancel) {
              await cancelRoom(publicClient, g, roomId!);
            }

          } else if (state === 2 /* Active */) {
            const alive = (await withRetry(
              () =>
                publicClient.readContract({
                  address: ARENA_ADDRESS,
                  abi: ARENA_ABI,
                  functionName: "isActive",
                  args: [BigInt(roomId!), g.address],
                }),
              `isActive:${g.label}`
            )) as boolean;

            const now = BigInt(Math.floor(Date.now() / 1000));
            const roundEndTime = room.roundEndTime as bigint;

            if (now < roundEndTime) {
              // ── Submission window: submit a word if alive and not yet done ──
              if (alive) {
                const existingScore = (await withRetry(
                  () =>
                    publicClient.readContract({
                      address: ARENA_ADDRESS,
                      abi: ARENA_ABI,
                      functionName: "getRoundScore",
                      args: [BigInt(roomId!), g.address],
                    }),
                  `getRoundScore:${g.label}`
                )) as number;

                if (existingScore === 0) {
                  const rackHex = room.rack as string;
                  await submitWord(publicClient, g, roomId!, rackHex);
                } else {
                  console.log(`  ✔️  ${g.label} already submitted this round (score=${existingScore}).`);
                }
              } else {
                console.log(`  💀  ${g.label} has been eliminated from room ${roomId}.`);
              }
            } else {
              // ── Round timer elapsed: call endRound as keeper ─────────────
              await endRound(publicClient, g, roomId!);
            }
          }
        }
      }

      // ── 6. LIQUIDITY INJECTION: no valid active room → create one ────────
      if (roomId === null) {
        console.log(`  🌊  No open room found. Injecting fresh room…`);
        const newRoomId = await createRoom(publicClient, g);
        saveCache({ activeRoomId: newRoomId });

        // Creator joins immediately
        const entryFee = parseUnits(ENTRY_FEE_CELO, 18);
        await joinRoom(publicClient, g, newRoomId, entryFee);
      }

      // ── Opportunistic claim check ─────────────────────────────────────────
      const pending = (await withRetry(
        () =>
          publicClient.readContract({
            address: ARENA_ADDRESS,
            abi: ARENA_ABI,
            functionName: "claimable",
            args: [g.address],
          }),
        `claimable:${g.label}`
      )) as bigint;

      if (pending > 0n) {
        await claimWinnings(publicClient, g);
        totalWins++;
        console.log(`\n🎉  ${g.label} HAS WON THE ARENA! (Win ${totalWins}/10)`);
        
        if (totalWins >= 10) {
          console.log(`\n🏆 Reached 10 completed rounds! Exiting driver script...`);
          process.exit(0);
        }
      }

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`\n  ❌  [LOOP ERROR] Recoverable — ${msg.slice(0, 200)}\n`);
    }

    // ── Pillar 7: human latency between iterations ────────────────────────
    await humanDelay();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTRYPOINT
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const command = process.argv[2] ?? "run";

  if (!DRIVER_MNEMONIC) {
    console.error("❌  DRIVER_MNEMONIC not set in .env\n");
    console.error(
      "    Generate one with: node -e \"const {generateMnemonic,english}=require('@scure/bip39');console.log(generateMnemonic(english))\""
    );
    process.exit(1);
  }

  const chain = buildChain();
  const publicClient = createPublicClient({
    chain,
    transport: http(RPC_URL),
  }) as PublicClient;

  const gladiators = deriveGladiators(DRIVER_MNEMONIC);

  switch (command) {
    case "run":
      if (!ARENA_ADDRESS) {
        console.error("❌  ARENA_ADDRESS not set in .env");
        process.exit(1);
      }
      await runLoop(publicClient, gladiators);
      break;

    case "sweep":
      await sweep(publicClient, gladiators);
      break;

    case "start": {
      const roomId = Number(process.argv[3]);
      if (!roomId) {
        console.error("Usage: npx tsx arena-driver.ts start <roomId>");
        process.exit(1);
      }
      await startRoom(publicClient, gladiators[0], roomId);
      break;
    }

    case "end-round": {
      const roomId = Number(process.argv[3]);
      if (!roomId) {
        console.error("Usage: npx tsx arena-driver.ts end-round <roomId>");
        process.exit(1);
      }
      await endRound(publicClient, gladiators[0], roomId);
      break;
    }

    case "claim-all":
      if (!ARENA_ADDRESS) {
        console.error("❌  ARENA_ADDRESS not set in .env");
        process.exit(1);
      }
      for (const g of gladiators) {
        await claimWinnings(publicClient, g);
        await sleep(1500); // brief pause between wallets
      }
      break;

    case "print-wallets":
      console.log(`\n⚔️  WordBreak Arena — 15 Derived Gladiator Wallets`);
      console.log("   (index  address)");
      gladiators.forEach((g) =>
        console.log(`   [${String(g.index).padStart(2, "0")}] ${g.address}  — ${g.label}`)
      );
      console.log("");
      break;

    default:
      console.log(
        "Commands: run | sweep | start <roomId> | end-round <roomId> | claim-all | print-wallets"
      );
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
