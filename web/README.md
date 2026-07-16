# WordBreak — Web (MiniPay frontend)

Next.js app — the playable game. **Slice 1: solo mode** (no wallet yet). Spell words from a rack
of letter tiles to smash a wall of bricks against the clock; clear the wall to level up into a
bigger, harder rack.

## Design — "Riso Arcade"

Deliberately not a generic template look. Cheap-print poster energy, high-contrast for outdoor
mobile screens, tactile keycap tiles. Signature element: a **brick wall that shatters as you
spell**. Type: Bricolage Grotesque (display + tiles), Instrument Sans (UI), Space Mono
(scoreboard/timer). Palette: riso paper, ink-plum, riso-blue, fluor-pink, amber, valid-green.

## Run

Needs the Go backend running (defaults to `http://localhost:8080`).

```bash
cp .env.example .env       # set NEXT_PUBLIC_API_URL if the backend isn't on :8080
npm install
npm run dev
```

Then open the app. In dev you can play with a physical keyboard (type letters, Enter = Smash,
Backspace = delete) as well as tapping tiles.

## How it talks to the backend

- On play / level-up it fetches `GET /api/solo/rack?size=N` and gets the letters **plus the
  answer set** — solo is free practice, so validation is instant and offline-friendly. Scoring
  mirrors the backend's `WordPoints` exactly.
- The **paid daily** (Slice 2) will use `/api/daily` (answers withheld) and submit to the server
  for authoritative scoring — no answers ever sent to the client.

## Testing in MiniPay

MiniPay needs HTTPS on a real device (emulators don't work). Expose the dev server:

```bash
npx ngrok http 3000
```

Open the ngrok HTTPS URL in MiniPay on an Android/iOS device.

## Daily pool (Slice 2 — built)

`/daily` is the paid mode: connect wallet (MiniPay auto-connects via `window.ethereum`; plain
viem, no wagmi) → read the round on-chain (`getRound`, `hasEntered`, `claimable`) → **approve
cUSD + `enter(roundId)`** → play today's shared rack (scored server-side, answers withheld) →
leaderboard → **`claim()`** winnings. Contract addresses + chain come from `NEXT_PUBLIC_*` env
(see `.env.example`); without them, `/daily` shows a "no pool" state.

`lib/` holds the integration: `config.ts` (env), `contracts.ts` (ABIs), `wallet.ts` (viem
clients, MiniPay detection, `sendWrite` with optional CIP-64 fee-currency).

> **Unverified until a testnet round-trip.** The code builds and type-checks, but the real
> acceptance test is a live **enter → settle → claim** on Celo Sepolia (needs a deployed pool +
> a funded key). Allowance ordering, decimals, roundId alignment, and MiniPay's on-device gas
> (CIP-64) only truly surface there.

## Not built yet (next slices)

- Leagues, streaks, friend duels.
