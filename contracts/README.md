<p align="center">
  <b>WordBreak</b> — <a href="https://wordbreak-fe.vercel.app/">Live app</a> ·
  <a href="https://github.com/wordBr/wordbreak-fe">Frontend</a> ·
  <a href="https://github.com/wordBr/wordbreak-backend">Backend</a>
</p>

# WordBreak — Contracts

Solidity (Foundry) for WordBreak's on-chain money layer. One contract, reused for everything:
**`WordBreakPools`** — a UUPS-upgradeable escrow that backs both the **daily paid pool** and
**staked multiplayer rooms** (no separate contract for duels — same rounds mechanism, a fresh
`roundId` per room).

## Live deployment (Celo mainnet)

| | |
|---|---|
| **Proxy (use this address)** | `0x8eF9AA2ccc401A1146eCDa6605A02cc1A72e3F3a` |
| Implementation | `0xb04da186B795C55f445B6C1c3ffCEA9B6325f14b` |
| Token | cUSD `0x765DE816845861e75A25fCA122bb6898B8B1282a` |
| Chain | Celo mainnet (42220) |

## What it does

- Players pay a fixed entry fee (cUSD) to join a round → fees pool in the contract.
- When entry closes, the **backend referee** signs an EIP-712 result (winners + amounts).
- The contract verifies the signature, credits winners, and sends the rake to the treasury.
- Winners withdraw with `claim()` (pull-payment — safe against reentrancy and gas griefing).
- **Anti-rug guarantee:** if a round is cancelled, or the referee never settles it within
  `refundDelay` after entry closes, every entrant reclaims their exact stake via `claimRefund()`.
- **Upgradeable (UUPS):** sits behind an `ERC1967Proxy`, so new features ship post-deployment
  without a migration — existing rounds and balances survive every upgrade untouched. Proven by
  test: a live round's state was carried through an upgrade to a mock V2 with a new feature, and
  both the old round *and* the new feature worked immediately after, at the same address.

### Trust model (stated plainly)

For the MVP the referee is a **trusted oracle** — it scores the game off-chain and decides
who won. The contract does *not* verify the word game on-chain. What it *does* guarantee:

1. The referee can only ever distribute what a round actually collected (`sum(payouts) ≤ pot − rake`).
2. The rake is capped on-chain at `MAX_RAKE_BPS = 10%`.
3. **Round economics are frozen at creation.** The rake and refund-delay are snapshotted into
   each round when it opens, so a later admin change to the defaults can never move the rake or
   the refund window out from under players who've already paid in.
4. Funds can never get stuck — refunds open automatically if settlement never happens, and the
   settle window and refund window are mutually exclusive (a round can't be both paid and refunded).
5. **The owner can upgrade contract logic at any time** (`_authorizeUpgrade` is `onlyOwner`).
   This is the honest cost of upgradeability: the contract is only as trustworthy as who holds
   that key. Before real money at meaningful scale, that owner should be a multisig/timelock,
   not a single EOA.

Later hardening (not built yet): commit–reveal of results, on-chain word/merkle proofs,
dispute windows, moving owner to a multisig.

## Layout

```
src/WordBreakPools.sol         the escrow contract (UUPS upgradeable)
script/lib/DeployProxy.sol     shared implementation+proxy deploy helper
script/Deploy.s.sol            full deploy (implementation + proxy + init)
script/DeployProxyOnly.s.sol   deploy a proxy against an already-deployed implementation
script/CreateRound.s.sol       open a round on an existing pool
script/LocalSetup.s.sol        Anvil-only: mock cUSD + pool + a funded test round
script/TestnetSetup.s.sol      Celo Sepolia: mock cUSD + pool + a round, one command
test/WordBreakPools.t.sol      27 tests: entry, settlement, refunds, access control, upgrades
test/mocks/WordBreakPoolsV2Mock.sol   proves the upgrade path with a real V2
```

## Build & test

```bash
forge build
forge test -vv
```

27 tests, including the load-bearing ones:
- `test_LogCanonicalDigest` — emits the exact EIP-712 digest the Go backend's signer test
  cross-checks against (byte-for-byte match required for `settle()` to ever accept a signature).
- `test_Upgrade_PreservesStateAndAddsNewFeature` — the actual upgrade proof described above.

## Backend integration — signing a settlement

The referee signs an EIP-712 typed message. Domain and types **must** match the contract
exactly (name `WordBreakPools`, version `1`, the deployed chainId + **proxy** address):

```ts
// viem — backend referee signing a round result
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.REFEREE_PRIVATE_KEY as `0x${string}`);

const domain = {
  name: "WordBreakPools",
  version: "1",
  chainId: 42220,                // 42220 mainnet, 11142220 Celo Sepolia
  verifyingContract: POOLS_PROXY_ADDRESS,
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

The [backend](https://github.com/wordBr/wordbreak-backend) does this in Go (`internal/signer`)
and, for staked multiplayer rooms, also broadcasts `createRound`/`settle` itself via a funded
operator key (`internal/chain.Writer`) — the referee only ever signs, never needs gas.

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

```bash
export PRIVATE_KEY=0x...          # deployer (pays gas)
export REFEREE=0x...              # backend signer address
export TREASURY=0x...             # rake recipient
export OWNER=0x...                # upgrade authority + admin (defaults to deployer)
export RAKE_BPS=500               # optional, default 5%
export REFUND_DELAY=172800        # optional, default 2 days (seconds)

# Celo Sepolia testnet
forge script script/Deploy.s.sol --rpc-url celo_sepolia --broadcast

# Celo mainnet
forge script script/Deploy.s.sol --rpc-url celo --broadcast
```

This deploys **both** the implementation and the `ERC1967Proxy` and initializes it in one go —
use the printed **proxy** address everywhere (frontend, backend, `talent.app`), never the
implementation address.

cUSD (USDm) is baked in as the default token per chain:
- Mainnet (42220): `0x765DE816845861e75A25fCA122bb6898B8B1282a`
- Celo Sepolia (11142220): `0xEF4d55D6dE8e8d73232827Cd1e9b2F2dBb45bC80`

Override with `TOKEN=0x...` to use USDT or another stablecoin.

> Before real money at scale: run an external audit pass (the celopedia skill points at
> `pashov/skills` — `solidity-auditor`, `x-ray` — plus Celo-specific checks), and move `owner`
> to a multisig/timelock.
