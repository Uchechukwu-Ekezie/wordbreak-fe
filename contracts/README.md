# WordBreak — Contracts

Solidity (Foundry) for WordBreak's on-chain money layer. One contract for now:
**`WordBreakPools`** — escrow for the daily paid challenge (Slice 2). Friend-duels get their
own contract later.

## What it does

- Players pay a fixed entry fee (cUSD) to join a round → fees pool in the contract.
- When entry closes, the **backend referee** signs an EIP-712 result (winners + amounts).
- The contract verifies the signature, credits winners, and sends the rake to the treasury.
- Winners withdraw with `claim()` (pull-payment — safe against reentrancy and gas griefing).
- **Anti-rug guarantee:** if a round is cancelled, or the referee never settles it within
  `refundDelay` after entry closes, every entrant reclaims their exact stake via `claimRefund()`.

### Trust model (stated plainly)

For the MVP the referee is a **trusted oracle** — it scores the game off-chain and decides
who won. The contract does *not* verify the word game on-chain. What it *does* guarantee:

1. The referee can only ever distribute what a round actually collected (`sum(payouts) ≤ pot − rake`).
2. The rake is capped on-chain at `MAX_RAKE_BPS = 10%`.
3. **Round economics are frozen at creation.** The rake and refund-delay are snapshotted into
   each round when it opens, so a later admin change to the defaults can never move the rake or
   the refund window out from under players who've already paid in. New settings apply only to
   future rounds.
4. Funds can never get stuck — refunds open automatically if settlement never happens, and the
   settle window and refund window are mutually exclusive (a round can't be both paid and refunded).

Later hardening (not built yet): commit–reveal of results, on-chain word/merkle proofs,
dispute windows.

## Layout

```
src/WordBreakPools.sol      the escrow contract
test/WordBreakPools.t.sol   17 tests: entry, settlement, refunds, access control
script/Deploy.s.sol         deploy script (env-driven, cUSD baked in per chain)
```

## Build & test

```bash
forge build
forge test -vv
```

## Backend integration — signing a settlement

The referee signs an EIP-712 typed message. Domain and types **must** match the contract
exactly (name `WordBreakPools`, version `1`, the deployed chainId + contract address):

```ts
// viem — backend referee signing a round result
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.REFEREE_PRIVATE_KEY as `0x${string}`);

const domain = {
  name: "WordBreakPools",
  version: "1",
  chainId: 42220,                // 42220 mainnet, 11142220 Celo Sepolia
  verifyingContract: POOLS_ADDRESS,
} as const;

const types = {
  Settlement: [
    { name: "roundId", type: "uint256" },
    { name: "winners", type: "address[]" },
    { name: "amounts", type: "uint256[]" },
  ],
} as const;

const signature = await account.signTypedData({
  domain,
  types,
  primaryType: "Settlement",
  message: { roundId, winners, amounts }, // amounts in token base units (cUSD = 18 dp)
});

// then, from any wallet: pool.settle(roundId, winners, amounts, signature)
```

Cross-check: `pool.settlementDigest(roundId, winners, amounts)` returns the exact digest the
contract will recover against — handy for debugging a signature mismatch.

Rules the backend must respect (else `settle` reverts):
- `winners.length == amounts.length`, at least one winner.
- `sum(amounts) ≤ pot − rake`, where `rake = pot * rakeBps / 10000`. The treasury
  automatically receives `pot − sum(amounts)` (rake plus any leftover), so it's fine to leave
  a margin; it just goes to the house.
- Settle only **within the window** `endTime ≤ now ≤ endTime + refundDelay`, and only once per
  round. After that window the referee is presumed dead and settlement is locked out so it can
  never collide with refunds — the backend must settle promptly (well inside `refundDelay`).

## Deploy

Set env vars, then run against a Celo RPC:

```bash
export PRIVATE_KEY=0x...          # deployer
export REFEREE=0x...              # backend signer address
export TREASURY=0x...             # rake recipient
export RAKE_BPS=500               # optional, default 5%
export REFUND_DELAY=172800        # optional, default 2 days (seconds)

# Celo Sepolia testnet
forge script script/Deploy.s.sol --rpc-url celo_sepolia --broadcast

# Celo mainnet
forge script script/Deploy.s.sol --rpc-url celo --broadcast
```

cUSD (USDm) is baked in as the default token per chain:
- Mainnet (42220): `0x765DE816845861e75A25fCA122bb6898B8B1282a`
- Celo Sepolia (11142220): `0xEF4d55D6dE8e8d73232827Cd1e9b2F2dBb45bC80`

Override with `TOKEN=0x...` to use USDT or another stablecoin.

> Before mainnet: run an external audit pass. The celopedia skill points at
> `pashov/skills` (`solidity-auditor`, `x-ray`) plus Celo-specific checks.
