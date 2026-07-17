# WordBreak — Testnet Run (Celo Sepolia)

End-to-end run of the paid daily on a real network, playable in a browser wallet. This verifies
the on-chain flow against a live chain. (MiniPay's gas-in-cUSD / CIP-64 is a **mainnet** concern —
do that after the audit.)

Keys live in `contracts/.env.testnet` (gitignored, throwaway — testnet funds only).

## 0. Fund the deployer (you)

Send Sepolia CELO to the deployer address printed during setup, from a faucet:
- https://faucet.celo.org/celo-sepolia
- https://cloud.google.com/application/web3/faucet/celo/sepolia

~0.5 CELO is plenty (deploys are cheap on Celo).

## 1. Deploy pool + mock cUSD + open a round

```bash
cd contracts
set -a; source .env.testnet; set +a
forge script script/TestnetSetup.s.sol \
  --rpc-url https://forno.celo-sepolia.celo-testnet.org --broadcast
```
Note the printed `CUSD_MOCK`, `POOL`, `ROUND_ID`, `END_TIME`.

## 2. Point the backend at the deployment (referee + chain gate)

```bash
cd ../backend
REFEREE_PRIVATE_KEY=<from .env.testnet> \
POOLS_CONTRACT=<POOL> \
CHAIN_ID=11142220 \
CHAIN_RPC_URL=https://forno.celo-sepolia.celo-testnet.org \
ADMIN_TOKEN=<pick one> \
go run ./cmd/server
```

Register the round so paid submissions are gated:
```bash
curl -X POST localhost:8080/api/admin/daily/open \
  -H 'Content-Type: application/json' -H 'X-Admin-Token: <ADMIN_TOKEN>' \
  -d '{"roundId":"<ROUND_ID>","endTime":<END_TIME>}'
```

## 3. Point the web app at the deployment

`web/.env.local`:
```
NEXT_PUBLIC_API_URL=http://localhost:8080
NEXT_PUBLIC_CHAIN_ID=11142220
NEXT_PUBLIC_RPC_URL=https://forno.celo-sepolia.celo-testnet.org
NEXT_PUBLIC_POOLS_ADDRESS=<POOL>
NEXT_PUBLIC_CUSD_ADDRESS=<CUSD_MOCK>
```
```bash
cd web && npm run dev
```

## 4. Play it

- Open `/daily` in a browser with a Celo-capable wallet on Sepolia.
- Get test cUSD: the deployer holds 1000 mock cUSD — send some to your player wallet
  (`cast send <CUSD_MOCK> "transfer(address,uint256)" <player> 5000000000000000000 --private-key <deployer> --rpc-url <rpc>`).
- Connect → **Enter** (approve + enter) → play → the leaderboard fills.

## 5. Settle + claim

After `END_TIME` (or lower `ROUND_SECONDS` for a quick test):
```bash
# get the referee signature for the winners you choose
curl -X POST localhost:8080/api/admin/sign-settlement \
  -H 'Content-Type: application/json' -H 'X-Admin-Token: <ADMIN_TOKEN>' \
  -d '{"roundId":"<ROUND_ID>","winners":["0x..."],"amounts":["<wei>"]}'
# submit it
cast send <POOL> "settle(uint256,address[],uint256[],bytes)" <ROUND_ID> "[0x...]" "[<wei>]" <sig> \
  --private-key <deployer> --rpc-url <rpc>
```
Winners then hit **Claim** in the app (`pool.claim()`).

## Later — the MiniPay device run (mainnet)

MiniPay is a Celo **mainnet** wallet; verifying CIP-64 gas-in-cUSD needs a mainnet deploy with
tiny real cUSD. Gate that behind the security audit and bot mitigation.
