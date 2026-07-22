// Minimal ABIs for the frontend — only the functions the daily flow calls.

export const POOLS_ABI = [
  {
    type: "function",
    name: "enter",
    stateMutability: "nonpayable",
    inputs: [{ name: "roundId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "hasEntered",
    stateMutability: "view",
    inputs: [
      { name: "roundId", type: "uint256" },
      { name: "player", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "claimable",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "roundExists",
    stateMutability: "view",
    inputs: [{ name: "roundId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "getScores",
    stateMutability: "view",
    inputs: [
      { name: "roundId", type: "uint256" },
      { name: "player", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "getRound",
    stateMutability: "view",
    inputs: [{ name: "roundId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "entryFee", type: "uint128" },
          { name: "endTime", type: "uint64" },
          { name: "refundDelay", type: "uint32" },
          { name: "rakeBps", type: "uint16" },
          { name: "settled", type: "bool" },
          { name: "cancelled", type: "bool" },
          { name: "pot", type: "uint256" },
          { name: "entrants", type: "uint256" },
        ],
      },
    ],
  },
] as const;

export const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

// WordBreakArena — fully on-chain elimination word game, no backend. Every read/write here
// goes straight to the contract via publicClient/sendWrite (see lib/wallet.ts), unlike
// POOLS_ABI above whose game state lives partly in the Go backend.
export const ARENA_ABI = [
  {
    type: "function",
    name: "createRoom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "entryFee", type: "uint128" },
      { name: "maxPlayers", type: "uint16" },
      { name: "minPlayers", type: "uint16" },
      { name: "joinDeadline", type: "uint64" },
      { name: "roundDuration", type: "uint32" },
    ],
    outputs: [{ name: "roomId", type: "uint256" }],
  },
  {
    type: "function",
    name: "joinRoom",
    stateMutability: "nonpayable",
    inputs: [{ name: "roomId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "cancelRoom",
    stateMutability: "nonpayable",
    inputs: [{ name: "roomId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "claimRefund",
    stateMutability: "nonpayable",
    inputs: [{ name: "roomId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "startRoom",
    stateMutability: "nonpayable",
    inputs: [{ name: "roomId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "submitWord",
    stateMutability: "nonpayable",
    inputs: [
      { name: "roomId", type: "uint256" },
      { name: "word", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "endRound",
    stateMutability: "nonpayable",
    inputs: [{ name: "roomId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
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
  {
    type: "function",
    name: "getActivePlayers",
    stateMutability: "view",
    inputs: [{ name: "roomId", type: "uint256" }],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    type: "function",
    name: "getRoundScore",
    stateMutability: "view",
    inputs: [
      { name: "roomId", type: "uint256" },
      { name: "player", type: "address" },
    ],
    outputs: [{ name: "", type: "uint16" }],
  },
  {
    type: "function",
    name: "isActive",
    stateMutability: "view",
    inputs: [
      { name: "roomId", type: "uint256" },
      { name: "player", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "isValidWord",
    stateMutability: "view",
    inputs: [{ name: "word", type: "bytes" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "token",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "nextRoomId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "RACK_SIZE",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "MIN_WORD_LENGTH",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "MAX_PLAYERS_HARD_CAP",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint16" }],
  },
  {
    type: "function",
    name: "claimable",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
