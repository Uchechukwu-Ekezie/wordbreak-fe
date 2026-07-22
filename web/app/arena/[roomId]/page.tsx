"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { formatUnits, stringToHex } from "viem";
import { ARENA_ADDRESS, isArenaConfigured } from "@/lib/config";
import { ARENA_ABI, ERC20_ABI } from "@/lib/contracts";
import { publicClient, sendWrite } from "@/lib/wallet";
import { useWallet } from "../../wallet-provider";

// RoomState enum, matching WordBreakArena.sol exactly.
const NONEXISTENT = 0, OPEN = 1, ACTIVE = 2, CANCELLED = 3, FINISHED = 4;

type RoomTuple = {
  entryFee: bigint;
  joinDeadline: bigint;
  maxPlayers: number;
  minPlayers: number;
  rakeBps: number;
  roundDuration: number;
  currentRound: number;
  roundEndTime: bigint;
  tiedStreak: number;
  state: number;
  winner: `0x${string}`;
  rack: `0x${string}`;
  pot: bigint;
};

// rack is bytes32, left-packed ASCII, zero-padded -- strip the trailing padding.
function rackToLetters(rack: `0x${string}`): string[] {
  const hex = rack.slice(2);
  const letters: string[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    if (byte === 0) break;
    letters.push(String.fromCharCode(byte));
  }
  return letters;
}

function short(a: string) {
  return a.startsWith("0x") && a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export default function ArenaRoom() {
  const { roomId: roomIdParam } = useParams<{ roomId: string }>();
  const roomId = /^\d+$/.test(roomIdParam) ? BigInt(roomIdParam) : null;
  const { account, connect: doConnect } = useWallet();

  const [room, setRoom] = useState<RoomTuple | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [activePlayers, setActivePlayers] = useState<`0x${string}`[]>([]);
  const [scores, setScores] = useState<Record<string, number>>({});
  const [iAmActive, setIAmActive] = useState(false);
  const [claimableAmt, setClaimableAmt] = useState(0n);

  const [symbol, setSymbol] = useState("");
  const [decimals, setDecimals] = useState(18);
  const [tokenAddr, setTokenAddr] = useState<`0x${string}` | null>(null);

  const [picks, setPicks] = useState<number[]>([]);
  const [wordValid, setWordValid] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [justEliminated, setJustEliminated] = useState(false);

  const endRoundFiredRef = useRef(false);
  const prevActiveRef = useRef<`0x${string}`[] | null>(null);
  const currentRoundRef = useRef<number | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!isArenaConfigured()) return;
    (async () => {
      try {
        const token = (await publicClient.readContract({
          address: ARENA_ADDRESS, abi: ARENA_ABI, functionName: "token",
        })) as `0x${string}`;
        setTokenAddr(token);
        const [sym, dec] = await Promise.all([
          publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }) as Promise<string>,
          publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }) as Promise<number>,
        ]);
        setSymbol(sym);
        setDecimals(dec);
      } catch {
        setSymbol("tokens");
      }
    })();
  }, []);

  const refresh = useCallback(async () => {
    if (roomId === null) return;
    try {
      const [r, players] = await Promise.all([
        publicClient.readContract({ address: ARENA_ADDRESS, abi: ARENA_ABI, functionName: "getRoom", args: [roomId] }) as Promise<RoomTuple>,
        publicClient.readContract({ address: ARENA_ADDRESS, abi: ARENA_ABI, functionName: "getActivePlayers", args: [roomId] }) as Promise<`0x${string}`[]>,
      ]);
      setRoom(r);
      setLoaded(true);

      if (account && r.state === ACTIVE && prevActiveRef.current
        && prevActiveRef.current.some((a) => a.toLowerCase() === account.toLowerCase())
        && !players.some((a) => a.toLowerCase() === account.toLowerCase())) {
        setJustEliminated(true);
      }
      prevActiveRef.current = players;
      setActivePlayers(players);

      if (players.length > 0 && r.state === ACTIVE) {
        const s = await Promise.all(
          players.map((p) =>
            publicClient.readContract({
              address: ARENA_ADDRESS, abi: ARENA_ABI, functionName: "getRoundScore", args: [roomId, p],
            }) as Promise<number>,
          ),
        );
        setScores(Object.fromEntries(players.map((p, i) => [p.toLowerCase(), s[i]])));
      }

      if (account) {
        const [active, claimableRes] = await Promise.all([
          publicClient.readContract({ address: ARENA_ADDRESS, abi: ARENA_ABI, functionName: "isActive", args: [roomId, account] }) as Promise<boolean>,
          publicClient.readContract({ address: ARENA_ADDRESS, abi: ARENA_ABI, functionName: "claimable", args: [account] }) as Promise<bigint>,
        ]);
        setIAmActive(active);
        setClaimableAmt(claimableRes);
      }
    } catch {
      /* transient RPC hiccup -- next poll picks it up */
    }
  }, [roomId, account]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2500);
    return () => clearInterval(id);
  }, [refresh]);

  // Reset per-round UI state when the round actually advances.
  useEffect(() => {
    if (room && currentRoundRef.current !== room.currentRound) {
      currentRoundRef.current = room.currentRound;
      setPicks([]);
      endRoundFiredRef.current = false;
    }
  }, [room?.currentRound]);

  // endRound is permissionless but not automatic -- once the timer's up, whoever's looking
  // at the page (with a connected wallet) advances it. A revert here just means someone else
  // already did; the next poll picks up whatever actually happened.
  useEffect(() => {
    if (!room || room.state !== ACTIVE || !account) return;
    if (now < Number(room.roundEndTime)) return;
    if (endRoundFiredRef.current) return;
    endRoundFiredRef.current = true;
    (async () => {
      try {
        const hash = await sendWrite(account, { address: ARENA_ADDRESS, abi: ARENA_ABI, functionName: "endRound", args: [roomId] });
        await publicClient.waitForTransactionReceipt({ hash });
        await refresh();
      } catch {
        /* already advanced by someone else, or the wallet declined -- fine either way */
      }
    })();
  }, [now, room, account, roomId, refresh]);

  const letters = room ? rackToLetters(room.rack) : [];
  const wordStr = picks.map((i) => letters[i]).join("");

  useEffect(() => {
    if (wordStr.length < 3) { setWordValid(null); return; }
    let cancelled = false;
    publicClient.readContract({
      address: ARENA_ADDRESS, abi: ARENA_ABI, functionName: "isValidWord", args: [stringToHex(wordStr)],
    }).then((v) => { if (!cancelled) setWordValid(v as boolean); })
      .catch(() => { if (!cancelled) setWordValid(null); });
    return () => { cancelled = true; };
  }, [wordStr]);

  const joinRoom = async () => {
    if (!account) return doConnect();
    if (!room || !tokenAddr || roomId === null) return;
    setError(null);
    try {
      const allowance = (await publicClient.readContract({
        address: tokenAddr, abi: ERC20_ABI, functionName: "allowance", args: [account, ARENA_ADDRESS],
      })) as bigint;
      if (allowance < room.entryFee) {
        setBusy(`Approving ${symbol}…`);
        const ah = await sendWrite(account, { address: tokenAddr, abi: ERC20_ABI, functionName: "approve", args: [ARENA_ADDRESS, room.entryFee] });
        await publicClient.waitForTransactionReceipt({ hash: ah });
      }
      setBusy("Joining…");
      const jh = await sendWrite(account, { address: ARENA_ADDRESS, abi: ARENA_ABI, functionName: "joinRoom", args: [roomId] });
      await publicClient.waitForTransactionReceipt({ hash: jh });
      await refresh();
    } catch (e) { setError(msg(e)); } finally { setBusy(null); }
  };

  const startRoomTx = async () => {
    if (!account || roomId === null) return;
    setError(null); setBusy("Starting…");
    try {
      const h = await sendWrite(account, { address: ARENA_ADDRESS, abi: ARENA_ABI, functionName: "startRoom", args: [roomId] });
      await publicClient.waitForTransactionReceipt({ hash: h });
      await refresh();
    } catch (e) { setError(msg(e)); } finally { setBusy(null); }
  };

  const cancelRoomTx = async () => {
    if (!account || roomId === null) return;
    setError(null); setBusy("Cancelling…");
    try {
      const h = await sendWrite(account, { address: ARENA_ADDRESS, abi: ARENA_ABI, functionName: "cancelRoom", args: [roomId] });
      await publicClient.waitForTransactionReceipt({ hash: h });
      await refresh();
    } catch (e) { setError(msg(e)); } finally { setBusy(null); }
  };

  const submitWord = async () => {
    if (!account || roomId === null || wordStr.length < 3) return;
    setError(null); setBusy("Submitting…");
    try {
      const h = await sendWrite(account, { address: ARENA_ADDRESS, abi: ARENA_ABI, functionName: "submitWord", args: [roomId, stringToHex(wordStr)] });
      await publicClient.waitForTransactionReceipt({ hash: h });
      await refresh();
    } catch (e) { setError(msg(e)); } finally { setBusy(null); setPicks([]); }
  };

  const claim = async () => {
    if (!account) return;
    setBusy("Claiming…"); setError(null);
    try {
      const h = await sendWrite(account, { address: ARENA_ADDRESS, abi: ARENA_ABI, functionName: "claim", args: [] });
      await publicClient.waitForTransactionReceipt({ hash: h });
      await refresh();
    } catch (e) { setError(msg(e)); } finally { setBusy(null); }
  };

  const claimRefund = async () => {
    if (!account || roomId === null) return;
    setBusy("Claiming refund…"); setError(null);
    try {
      const h = await sendWrite(account, { address: ARENA_ADDRESS, abi: ARENA_ABI, functionName: "claimRefund", args: [roomId] });
      await publicClient.waitForTransactionReceipt({ hash: h });
      await refresh();
    } catch (e) { setError(msg(e)); } finally { setBusy(null); }
  };

  const amt = (v: bigint) => `${Number(formatUnits(v, decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${symbol}`;

  if (!isArenaConfigured() || roomId === null) {
    return (
      <main className="shell">
        <Header />
        <div className="card" style={{ margin: "auto" }}>
          <h1 style={{ fontSize: 24 }}>Invalid room</h1>
          <Link href="/arena" className="btn" style={{ display: "block", textDecoration: "none", marginTop: 12 }}>← Back</Link>
        </div>
      </main>
    );
  }

  if (!loaded) return <div className="loading">LOADING ROOM #{roomId.toString()}…</div>;

  if (!room || room.state === NONEXISTENT) {
    return (
      <main className="shell">
        <Header />
        <div className="card" style={{ margin: "auto" }}>
          <h1 style={{ fontSize: 24 }}>Room not found</h1>
          <Link href="/arena" className="btn" style={{ display: "block", textDecoration: "none", marginTop: 12 }}>← Back</Link>
        </div>
      </main>
    );
  }

  // ---------- OPEN (lobby) ----------
  if (room.state === OPEN) {
    const full = activePlayers.length >= room.maxPlayers;
    const pastDeadline = now >= Number(room.joinDeadline);
    const readyToStart = full || (activePlayers.length >= room.minPlayers && pastDeadline);
    const cancellable = pastDeadline && activePlayers.length < room.minPlayers;

    return (
      <main className="shell">
        <Header />
        <div className="gate-inner">
          <p className="gate-note mono">ROOM #{roomId.toString()}</p>
          <div className="vs-stake-banner">
            {amt(room.entryFee)} entry · pot {amt(room.pot)}
            {!pastDeadline ? ` · joins close in ${fmtClock(Number(room.joinDeadline) - now)}` : ""}
          </div>
          <div className="vs-players">
            {activePlayers.map((p) => (
              <div className="vs-player" key={p}>
                <span>{short(p)}</span>
                {account && p.toLowerCase() === account.toLowerCase() && <span className="vs-you">YOU</span>}
              </div>
            ))}
            {Array.from({ length: Math.max(0, room.minPlayers - activePlayers.length) }).map((_, i) => (
              <div className="vs-player empty" key={`e${i}`}>waiting…</div>
            ))}
          </div>

          {!iAmActive && !pastDeadline && (
            <button className="btn primary gate-btn" onClick={joinRoom} disabled={!!busy}>
              {busy || `Join · ${amt(room.entryFee)}`}
            </button>
          )}
          {iAmActive && !readyToStart && <p className="tx-note">Waiting for more players (or the join window to close)…</p>}
          {readyToStart && (
            <button className="btn primary gate-btn" onClick={startRoomTx} disabled={!!busy}>
              {busy || "Start the game"}
            </button>
          )}
          {cancellable && (
            <button className="btn ghost gate-btn" onClick={cancelRoomTx} disabled={!!busy}>
              Cancel & open refunds
            </button>
          )}
          {error && <p className="tx-note err">{error}</p>}
          <Link href="/arena" className="daily-link">← All rooms</Link>
        </div>
      </main>
    );
  }

  // ---------- CANCELLED ----------
  if (room.state === CANCELLED) {
    return (
      <main className="shell">
        <Header />
        <div className="card" style={{ margin: "auto" }}>
          <h1 style={{ fontSize: 24 }}>Room cancelled</h1>
          <p className="tag">Didn&apos;t reach {room.minPlayers} players in time — everyone who joined gets a full refund.</p>
          {iAmActive ? (
            <button className="btn win" onClick={claimRefund} disabled={!!busy} style={{ marginTop: 12 }}>
              {busy || `Claim refund · ${amt(room.entryFee)}`}
            </button>
          ) : (
            <p className="tx-note" style={{ marginTop: 12 }}>Nothing to refund for this wallet.</p>
          )}
          {error && <p className="tx-note err">{error}</p>}
          <Link href="/arena" className="btn ghost" style={{ display: "block", textDecoration: "none", marginTop: 12 }}>← All rooms</Link>
        </div>
      </main>
    );
  }

  const iAmIn = !!account && activePlayers.some((a) => a.toLowerCase() === account.toLowerCase());
  const mySubmitted = !!account && (scores[account.toLowerCase()] ?? 0) > 0;

  // ---------- FINISHED ----------
  if (room.state === FINISHED) {
    const won = !!account && room.winner.toLowerCase() === account.toLowerCase();
    return (
      <main className="shell">
        <Header />
        <div className="gate-inner">
          <div className="big-stars">{won ? "🏆" : "☠️"}</div>
          <h1 className="vs-title display">{won ? "You won!" : `${short(room.winner)} wins`}</h1>
          <div className="big-lbl">pot {amt(room.pot)}</div>
          {claimableAmt > 0n && (
            <button className="btn win gate-btn" onClick={claim} disabled={!!busy} style={{ marginTop: 12 }}>
              {busy || `Claim ${amt(claimableAmt)}`}
            </button>
          )}
          {error && <p className="tx-note err">{error}</p>}
          <Link href="/arena" className="btn primary gate-btn" style={{ display: "block", textDecoration: "none", marginTop: 12 }}>Play again</Link>
        </div>
      </main>
    );
  }

  // ---------- ACTIVE (playing) ----------
  const timeLeft = Math.max(0, Number(room.roundEndTime) - now);
  const maxSlots = Math.max(letters.length, 5);

  if (justEliminated && !iAmIn) {
    return (
      <main className="shell">
        <Header />
        <div className="gate-inner">
          <div className="big-stars">☠️</div>
          <h1 className="vs-title display">Eliminated</h1>
          <p className="tag">Round {room.currentRound} — the game continues without you. Rooting for whoever&apos;s left?</p>
          <Link href="/arena" className="btn primary gate-btn" style={{ display: "block", textDecoration: "none", marginTop: 12 }}>← All rooms</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="top">
        <div className="wordmark display">WORD<span className="brk">BREAK</span><span className="dot">.</span></div>
        <div className={`timer ${timeLeft <= 10 ? "low" : ""}`}>
          <span className="lbl">R{room.currentRound}</span>0:{String(timeLeft).padStart(2, "0")}
        </div>
      </header>

      <div className="vs-board">
        {activePlayers.map((p) => (
          <div className={`vs-row ${account && p.toLowerCase() === account.toLowerCase() ? "me" : ""}`} key={p}>
            <span className="vs-name">{short(p)}{account && p.toLowerCase() === account.toLowerCase() ? " (you)" : ""}</span>
            <span className="vs-score mono">{scores[p.toLowerCase()] ? scores[p.toLowerCase()] : "…"}</span>
          </div>
        ))}
      </div>

      {!iAmIn ? (
        <p className="tx-note" style={{ margin: "auto" }}>You&apos;re watching — not a player in this room.</p>
      ) : mySubmitted ? (
        <div className="gate-inner">
          <p className="tag">Word in for round {room.currentRound}. Waiting on the rest of the table…</p>
        </div>
      ) : (
        <div className="stage">
          <div className="input-row">
            {Array.from({ length: maxSlots }).map((_, i) => (
              <div key={i} className={`slot ${i >= picks.length ? "empty" : ""}`}>{i < picks.length ? letters[picks[i]] : ""}</div>
            ))}
          </div>
          {wordStr.length >= 3 && (
            <p className={`tx-note ${wordValid === false ? "err" : ""}`}>
              {wordValid === null ? "checking…" : wordValid ? "✓ valid word" : "not in the dictionary"}
            </p>
          )}
          <div className="rack">
            {letters.map((l, i) => (
              <button key={i} className={`tile ${picks.includes(i) ? "used" : ""}`}
                onClick={() => !picks.includes(i) && setPicks((p) => [...p, i])} aria-label={`letter ${l}`}>
                {l}
              </button>
            ))}
          </div>
          <div className="actions">
            <button className="btn ghost" onClick={() => setPicks((p) => p.slice(0, -1))} disabled={picks.length === 0}>Del</button>
            <button className="btn primary" onClick={submitWord} disabled={!!busy || wordStr.length < 3 || wordValid === false}>
              {busy || "Submit"}
            </button>
          </div>
        </div>
      )}
      {error && <p className="tx-note err">{error}</p>}
    </main>
  );
}

function fmtClock(seconds: number) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function Header() {
  return (
    <header className="top">
      <div className="wordmark display">WORD<span className="brk">BREAK</span><span className="dot">.</span></div>
      <Link href="/arena" className="about-link">ROOMS</Link>
    </header>
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function msg(e: any): string {
  const m = e?.shortMessage || e?.message || String(e);
  if (/user rejected/i.test(m)) return "Cancelled.";
  return m.length > 130 ? m.slice(0, 130) + "…" : m;
}
