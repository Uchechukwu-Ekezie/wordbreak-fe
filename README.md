<p align="center">
  <img src="public/wordmark.svg" alt="WordBreak" width="480" />
</p>

<p align="center">
  <b>Live:</b> <a href="https://wordbreak-fe.vercel.app/">wordbreak-fe.vercel.app</a> ·
  <b>Backend:</b> <a href="https://github.com/foxGrant/wordbreak-backend">wordbreak-backend</a> ·
  <b>Contracts:</b> <a href="https://github.com/foxGrant/wordbreak-contracts">wordbreak-contracts</a>
</p>

# WordBreak — Frontend

A word game for [MiniPay](https://www.opera.com/products/minipay) on [Celo](https://celo.org).
Spell words from a rack of letter tiles to smash a wall of bricks and climb through levels —
free forever. Connect a wallet to race friends in multiplayer, stake cUSD for winner-takes-all
pots, or enter the daily cUSD pool.

Next.js 15 (App Router) + [viem](https://viem.sh) — no wagmi, no connector libraries. MiniPay
injects `window.ethereum` directly and the app talks to it with plain viem clients.

## What's built

- **Solo levels** (`/`) — the core loop. Racks start at 3 letters and grow (up to 8) as you
  climb; each level has a score goal, a timer, and 1–3 stars. Run out of time short of the goal
  and you can pay a small amount of cUSD to buy +30s and keep going (real on-chain tx, granted
  only after it confirms — no optimistic credit).
- **Multiplayer** (`/vs`) — up to 5 players race the same rack against a shared clock.
  - **Public rooms** — no code needed; browse and join a live list of open rooms. Keep playing
    solo while you wait for players to fill in.
  - **Private rooms** — share a 4-letter code.
  - **Staked rooms** — the host sets a cUSD stake; everyone who joins stakes for real on-chain
    (approve + `enter`) before they're allowed in. Winner takes the whole pot, paid out
    automatically the moment the race ends and settlement is signed.
- **Daily pool** (`/daily`) — one shared rack for everyone, once a day. Connect → approve cUSD →
  `enter(roundId)` → play → leaderboard → `claim()` your winnings if you placed.
- **Home hub** — mode-select screen (Solo / Multiplayer / Daily) with a persistent tab bar
  (Home · Records · Profile · Settings). Play-free landing, connect-anytime — never gated behind
  a wallet unless you're doing something that costs money.
- **Profile** — name, wallet, cUSD balance, stars/levels/games stats — all on its own screen.
- Chiptune background music + SFX (synthesized, no audio assets), haptics on mobile.

## Design — "Neon Arcade"

Dark, glowy, glossy — casual-game energy: 3D keycap tiles, pill buttons with real depth, a
brick wall that visibly shatters as you spell. Type: **Fredoka** (display/tiles), Instrument
Sans (UI), Space Mono (scoreboard/timer). Palette: deep indigo background, riso-blue, fluor-pink,
amber, valid-green — see `app/globals.css` for the full token system.

## Run locally

Needs the [backend](https://github.com/foxGrant/wordbreak-backend) running (defaults to
`http://localhost:8080`).

```bash
cp .env.example .env.local     # set NEXT_PUBLIC_API_URL / chain / contract addresses
npm install
npm run dev
```

Desktop testing tip: the solo board also accepts a physical keyboard — type letters, Enter to
submit, Backspace to delete.

### Environment

See `.env.example`. The important ones:

| Var | Purpose |
|---|---|
| `NEXT_PUBLIC_API_URL` | Backend base URL |
| `NEXT_PUBLIC_CHAIN_ID` | `42220` mainnet / `11142220` Celo Sepolia |
| `NEXT_PUBLIC_RPC_URL` | Celo RPC |
| `NEXT_PUBLIC_POOLS_ADDRESS` | `WordBreakPools` **proxy** address (see contracts repo) |
| `NEXT_PUBLIC_CUSD_ADDRESS` | cUSD token address for the chosen chain |
| `NEXT_PUBLIC_TREASURY` | Recipient for "buy more time" micro-payments |
| `NEXT_PUBLIC_CONTINUE_PRICE` / `NEXT_PUBLIC_CONTINUE_SECONDS` | Buy-time price (wei) / grant (s) |

## How it talks to the backend

- **Solo** fetches `GET /api/solo/rack?size=N` and gets the letters **plus the answer set** —
  it's free practice, so validation is instant and offline-friendly.
- **Daily pool / multiplayer** never receive answers — words are submitted to the backend and
  scored server-authoritatively (`/api/daily/submit`, `/api/room/submit`), so nobody can inspect
  network traffic to cheat.
- `lib/` holds the integration: `config.ts` (env), `contracts.ts` (ABIs), `wallet.ts` (viem
  clients, MiniPay detection, network auto-switch, `sendWrite` with optional CIP-64
  fee-currency). `app/wallet-provider.tsx` is the shared wallet context — connect once, every
  screen knows (auto-reconnect, live account-change sync).

## Testing in MiniPay

MiniPay needs HTTPS on a real device (emulators don't work).

```bash
npx ngrok http 3000
```

Open the ngrok HTTPS URL in MiniPay on an Android/iOS device. For the deployed version, just
open `https://wordbreak-fe.vercel.app/` directly inside MiniPay's browser.

## Status

Solo, daily pool, and multiplayer (public/private/staked) are built and wired to a **live Celo
mainnet deployment** of `WordBreakPools` (see the [contracts repo](https://github.com/foxGrant/wordbreak-contracts)
for the address). Not yet built: persistent cross-device leaderboards (currently per-device via
localStorage — a database is the natural next step), account/name uniqueness, leagues & streaks.
