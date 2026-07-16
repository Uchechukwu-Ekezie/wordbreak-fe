# WordBreak

*Working title — a word game built for MiniPay.*

## One line

A fast word game where you spell words out of a rack of letters to smash bricks — free every day to build the habit, with real cUSD prize pools for players who want to compete.

## Who it's for

MiniPay users (Opera's self-custodial stablecoin wallet, 16M+ users, mostly mobile-first, emerging markets). It has to load fast on a cheap Android over a weak network, and money moves in tiny amounts of cUSD.

## Why it fits Proof of Ship

- **Real app for real people.** A word game is universal, sticky, and something people genuinely come back to.
- **Skill, not gambling.** You win by being good with words, not by chance — keeps us clean of the regulatory line that kills DeFi/betting apps for solo builders.
- **Real onchain activity, organically.** Money moves as a natural part of play (entry into prize pools), not as a farming reward.
- **Educational cover story is honest** — it sharpens vocabulary and spelling.

## The core loop

You're given a rack of letters (5, then 6, then 7… as you climb). Find every valid word you can before the timer runs out. Each valid word smashes bricks / fills a meter. Clear the meter → next, harder rack. Stuck? Spend a few cents of cUSD for a hint.

## Modes

1. **Solo practice (free)** — endless, escalating random racks. The funnel that hooks people. *No chain, no money.*
2. **Daily challenge (paid pool)** — the *same* rack for everyone that day, small cUSD entry, top scorers split the pool. This is both the retention engine (Wordle's shared-daily-puzzle hook) and the money engine, in one.
3. **Friend duels (later)** — challenge a friend head-to-head for a stake, shared as a link. The most MiniPay-native mode, but the harder build.
4. **Leagues + streaks (later)** — small ~30-player divisions with weekly promotion/demotion, plus daily streaks. The retention deep-end.
5. **Local languages (later)** — Swahili, Yoruba, Pidgin, Tagalog, etc. The long-term moat; no serious word-money game serves these.

## Architecture

- **Frontend** — Next.js webview app for MiniPay (wagmi/viem). Tiles, timer, brick feedback, wallet connect, leagues/streaks display.
- **Backend (the referee + social layer)** — dictionary validation, letter-set generation (known-good racks, not pure random), scoring, leagues/streaks/leaderboards, matchmaking, and **signing match results** the contract will trust.
- **Smart contract (Celo, money only, kept small)** — escrows the pool for a round, releases to winners minus a small rake, *only* on seeing the backend's signed result. The builder never custodies funds; the contract escrows per-round and pays out by rule. For MVP the backend is a trusted referee.

## Open risk to design around: bots

A game that pays "most words found" is trivially beaten by an anagram solver (a tiny script that returns every valid word from a rack instantly). This is the first thing an attacker tries against a real-money word game. Mitigations to weigh before shipping any paid mode: reward speed/typing cadence not just count, cap stakes small, require account staking so bot farms are costly, and/or add human-input checks. Not solved yet — flagged so the money design accounts for it.

## Build roadmap (vertical slices, not all at once)

This is a one-month Proof of Ship cadence, so we ship a thin working slice first, then deepen.

1. **Slice 1 — Solo loop, no chain.** Rack → timer → find words → brick feedback. Dictionary + known-good-rack generation. Proves the fun is real.
2. **Slice 2 — Daily paid pool.** One shared daily rack, cUSD entry, one pool contract + signed settlement. Money moves.
3. **Later — leagues, streaks, duels, languages.** Polish on a proven loop.

## Money flow (paid modes)

Players deposit stake into the round's escrow → backend validates play and scores → backend submits a signed result → contract pays out winners minus a small rake. Funds only ever sit in the escrow contract, released by rule.
