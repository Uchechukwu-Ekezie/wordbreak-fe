"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";
import { API, POOLS_ADDRESS, CUSD_ADDRESS, isConfigured } from "@/lib/config";
import { POOLS_ABI, ERC20_ABI } from "@/lib/contracts";
import { hasWallet, publicClient, sendWrite } from "@/lib/wallet";
import { useWallet } from "../wallet-provider";

const PLAY_SECONDS = 90;
const WALL_BRICKS = 24;

function wordPoints(n: number): number {
  if (n < 3) return 0;
  if (n === 3) return 1;
  if (n === 4) return 2;
  if (n === 5) return 4;
  if (n === 6) return 6;
  if (n === 7) return 10;
  return 10 + (n - 7) * 4;
}

const LETTER_VALUE: Record<string, number> = {
  A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8, K: 5, L: 1, M: 3,
  N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1, U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10,
};

type DailyInfo = { dateKey: string; letters: string; paid: boolean; roundId?: string };
type Round = {
  entryFee: bigint;
  endTime: bigint;
  settled: boolean;
  cancelled: boolean;
  pot: bigint;
  entrants: bigint;
};
type LB = { rank: number; address: string; score: number; words: number }[];
type View = "loading" | "no-pool" | "lobby" | "playing" | "done";

export default function Daily() {
  const { account: address, connect: onConnect } = useWallet();
  const [view, setView] = useState<View>("loading");
  const [info, setInfo] = useState<DailyInfo | null>(null);
  const [round, setRound] = useState<Round | null>(null);
  const [entered, setEntered] = useState(false);
  const [claimable, setClaimable] = useState<bigint>(0n);
  const [leaderboard, setLeaderboard] = useState<LB>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // play state
  const [letters, setLetters] = useState<string[]>([]);
  const [picks, setPicks] = useState<number[]>([]);
  const [attempts, setAttempts] = useState<string[]>([]);
  const [found, setFound] = useState<{ word: string; pts: number }[]>([]);
  const [score, setScore] = useState(0);
  const [timeLeft, setTimeLeft] = useState(PLAY_SECONDS);
  const [fx, setFx] = useState<"pop" | "shake" | null>(null);
  const attemptsRef = useRef<string[]>([]);
  attemptsRef.current = attempts;

  const roundId = info?.roundId ? BigInt(info.roundId) : null;

  const fetchLeaderboard = useCallback(async () => {
    try {
      const r = await fetch(`${API}/api/daily/leaderboard`, { cache: "no-store" });
      const d = await r.json();
      setLeaderboard(d.leaderboard ?? []);
    } catch {
      /* non-fatal */
    }
  }, []);

  const refreshChain = useCallback(
    async (addr: `0x${string}`, rId: bigint) => {
      const [r, ent, cl] = await Promise.all([
        publicClient.readContract({ address: POOLS_ADDRESS, abi: POOLS_ABI, functionName: "getRound", args: [rId] }),
        publicClient.readContract({ address: POOLS_ADDRESS, abi: POOLS_ABI, functionName: "hasEntered", args: [rId, addr] }),
        publicClient.readContract({ address: POOLS_ADDRESS, abi: POOLS_ABI, functionName: "claimable", args: [addr] }),
      ]);
      setRound(r as Round);
      setEntered(ent as boolean);
      setClaimable(cl as bigint);
    },
    [],
  );

  // Initial load.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API}/api/daily`, { cache: "no-store" });
        const d: DailyInfo = await res.json();
        setInfo(d);
        setLetters(d.letters.split(""));
        if (!d.paid || !isConfigured()) {
          setView("no-pool");
          return;
        }
        fetchLeaderboard();
        setView("lobby");
      } catch {
        setError("Couldn't load today's pool.");
        setView("no-pool");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load on-chain state whenever the wallet (from context) or the round becomes available.
  useEffect(() => {
    if (address && info?.roundId) refreshChain(address, BigInt(info.roundId));
  }, [address, info?.roundId, refreshChain]);

  const enterPool = async () => {
    if (!address || !round || !roundId) return;
    setError(null);
    try {
      // Approve only if needed.
      const allowance = (await publicClient.readContract({
        address: CUSD_ADDRESS, abi: ERC20_ABI, functionName: "allowance", args: [address, POOLS_ADDRESS],
      })) as bigint;
      if (allowance < round.entryFee) {
        setBusy("Approving cUSD…");
        const ah = await sendWrite(address, {
          address: CUSD_ADDRESS, abi: ERC20_ABI, functionName: "approve",
          args: [POOLS_ADDRESS, round.entryFee],
        });
        await publicClient.waitForTransactionReceipt({ hash: ah });
      }
      setBusy("Joining the pool…");
      const eh = await sendWrite(address, {
        address: POOLS_ADDRESS, abi: POOLS_ABI, functionName: "enter", args: [roundId],
      });
      await publicClient.waitForTransactionReceipt({ hash: eh });
      await refreshChain(address, roundId);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const claim = async () => {
    if (!address || !roundId) return;
    setError(null);
    try {
      setBusy("Claiming…");
      const h = await sendWrite(address, {
        address: POOLS_ADDRESS, abi: POOLS_ABI, functionName: "claim", args: [],
      });
      await publicClient.waitForTransactionReceipt({ hash: h });
      await refreshChain(address, roundId);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const startPlay = () => {
    setAttempts([]);
    setFound([]);
    setScore(0);
    setPicks([]);
    setTimeLeft(PLAY_SECONDS);
    setView("playing");
  };

  // Play countdown.
  useEffect(() => {
    if (view !== "playing") return;
    const id = setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) {
          clearInterval(id);
          setView("done");
          fetchLeaderboard();
          if (address && roundId) refreshChain(address, roundId);
          return 0;
        }
        return t - 1;
      });
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const flash = (k: "pop" | "shake") => {
    setFx(k);
    setTimeout(() => setFx(null), 400);
  };

  const submitWord = useCallback(async () => {
    if (view !== "playing" || !address) return;
    const word = picks.map((i) => letters[i]).join("").toUpperCase();
    setPicks([]);
    if (word.length < 3 || attemptsRef.current.includes(word)) return flash("shake");

    const next = [...attemptsRef.current, word];
    setAttempts(next);
    try {
      const res = await fetch(`${API}/api/daily/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, words: next }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        setError(e.error || "Submission rejected.");
        return flash("shake");
      }
      const data = await res.json();
      const accepted: { word: string; points: number }[] = data.result?.accepted ?? [];
      setFound(accepted.map((a) => ({ word: a.word, pts: a.points })));
      setScore(data.score ?? 0);
      if (accepted.some((a) => a.word === word)) {
        if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(28);
        flash("pop");
      } else {
        flash("shake");
      }
    } catch {
      flash("shake");
    }
  }, [view, address, picks, letters]);

  const broken = Math.min(WALL_BRICKS, score);
  const maxSlots = Math.max(letters.length, 5);
  const cusd = (v: bigint) => `${Number(formatUnits(v, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })} cUSD`;
  const roundOpen = round ? Date.now() / 1000 < Number(round.endTime) && !round.settled && !round.cancelled : false;

  if (view === "loading") return <div className="loading">LOADING TODAY&apos;S POOL…</div>;

  if (view === "no-pool") {
    return (
      <main className="shell">
        <Header timeLeft={0} showTimer={false} />
        <div className="card" style={{ margin: "auto", boxShadow: "0 10px 0 var(--blue)" }}>
          <h1 style={{ fontSize: 30 }}>No pool today</h1>
          <p className="tag">
            {error || "There isn't an open daily pool right now. Come back later — or sharpen up in solo."}
          </p>
          <Link href="/" className="btn" style={{ display: "block", textDecoration: "none" }}>
            Play solo
          </Link>
        </div>
      </main>
    );
  }

  if (view === "lobby") {
    return (
      <main className="shell">
        <Header timeLeft={0} showTimer={false} />
        <Link href="/" className="backlink">← Solo</Link>

        <section className="pool-card">
          <div className="pool-top">
            <span className="pool-title display">TODAY&apos;S POOL</span>
            <span className="pool-date mono">{info?.dateKey}</span>
          </div>
          <div className="pool-stats">
            <div className="pstat"><div className="pn">{round ? cusd(round.pot) : "—"}</div><div className="pk">prize pool</div></div>
            <div className="pstat"><div className="pn">{round ? cusd(round.entryFee) : "—"}</div><div className="pk">entry</div></div>
            <div className="pstat"><div className="pn">{round ? String(round.entrants) : "—"}</div><div className="pk">players</div></div>
          </div>
        </section>

        {!address ? (
          <button className="btn primary" onClick={onConnect}>
            {hasWallet() ? "Connect wallet" : "Open in MiniPay to play"}
          </button>
        ) : (
          <>
            <div className="addr mono">{short(address)}{entered ? " · entered ✓" : ""}</div>
            {busy && <div className="tx-note">{busy}</div>}
            {!entered && roundOpen && (
              <button className="btn primary" onClick={enterPool} disabled={!!busy}>
                Enter {round ? `· ${cusd(round.entryFee)}` : ""}
              </button>
            )}
            {entered && roundOpen && (
              <button className="btn primary" onClick={startPlay}>Play today&apos;s rack</button>
            )}
            {round && !roundOpen && <div className="tx-note">This pool is closed.</div>}
            {claimable > 0n && (
              <button className="btn win" onClick={claim} disabled={!!busy}>
                Claim {cusd(claimable)}
              </button>
            )}
          </>
        )}

        {error && <div className="tx-note err">{error}</div>}
        <Leaderboard rows={leaderboard} me={address} />
      </main>
    );
  }

  // playing / done share the board chrome
  return (
    <main className="shell">
      <Header timeLeft={timeLeft} showTimer={view === "playing"} />

      <section className="wall-wrap">
        <div className="wall-head">
          <span className="lvl display">DAILY · {info?.dateKey}</span>
          <span className="left">{Math.max(0, WALL_BRICKS - broken)} bricks left</span>
        </div>
        <div className="wall">
          {Array.from({ length: WALL_BRICKS }).map((_, i) => (
            <div key={i} className={`brick c${i % 3} ${i < broken ? "broken" : ""}`} />
          ))}
        </div>
      </section>

      <div className="found">
        {found.map((f) => (
          <span className="chip" key={f.word}>{f.word} <span className="pts">+{f.pts}</span></span>
        ))}
      </div>

      {view === "playing" ? (
        <div className="stage">
          <div className={`input-row ${fx ?? ""}`}>
            {Array.from({ length: maxSlots }).map((_, i) => (
              <div key={i} className={`slot ${i >= picks.length ? "empty" : ""}`}>
                {i < picks.length ? letters[picks[i]] : ""}
              </div>
            ))}
          </div>
          <div className="rack">
            {letters.map((l, i) => (
              <button key={i} className={`tile ${picks.includes(i) ? "used" : ""}`}
                onClick={() => !picks.includes(i) && setPicks((p) => [...p, i])} aria-label={`letter ${l}`}>
                {l}<span className="val">{LETTER_VALUE[l] ?? ""}</span>
              </button>
            ))}
          </div>
          <div className="actions">
            <button className="btn ghost" onClick={() => setPicks((p) => p.slice(0, -1))} disabled={picks.length === 0}>Delete</button>
            <button className="btn primary" onClick={submitWord} disabled={picks.length < 3}>Smash</button>
          </div>
        </div>
      ) : (
        <div className="card" style={{ margin: "auto", boxShadow: "0 10px 0 var(--amber)" }}>
          <h1>ROUND DONE</h1>
          <div className="big">{score}</div>
          <div className="big-lbl">your score</div>
          {claimable > 0n && <button className="btn win" onClick={claim} disabled={!!busy}>Claim {cusd(claimable)}</button>}
          <Leaderboard rows={leaderboard} me={address} />
          <button className="btn" style={{ marginTop: 14 }} onClick={() => setView("lobby")}>Back to pool</button>
        </div>
      )}

      <div className="scorebar">
        <span>SCORE <b>{String(score).padStart(4, "0")}</b></span>
        <span>{found.length} words</span>
      </div>
    </main>
  );
}

function Header({ timeLeft, showTimer }: { timeLeft: number; showTimer: boolean }) {
  const mm = String(Math.floor(timeLeft / 60));
  const ss = String(timeLeft % 60).padStart(2, "0");
  return (
    <header className="top">
      <div className="wordmark display">WORD<span className="brk">BREAK</span><span className="dot">.</span></div>
      {showTimer && (
        <div className={`timer ${timeLeft <= 10 ? "low" : ""}`}><span className="lbl">TIME</span>{mm}:{ss}</div>
      )}
    </header>
  );
}

function Leaderboard({ rows, me }: { rows: LB; me: `0x${string}` | null }) {
  if (!rows.length) return <div className="lb-empty">No scores yet — be first.</div>;
  return (
    <div className="lb">
      {rows.slice(0, 10).map((r) => (
        <div className={`lb-row ${me && r.address.toLowerCase() === me.toLowerCase() ? "me" : ""}`} key={r.address}>
          <span className="lb-rank mono">{r.rank}</span>
          <span className="lb-addr mono">{short(r.address as `0x${string}`)}</span>
          <span className="lb-score mono">{r.score}</span>
        </div>
      ))}
    </div>
  );
}

function short(a: `0x${string}`) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function errMsg(e: any): string {
  const m = e?.shortMessage || e?.message || String(e);
  if (/user rejected/i.test(m)) return "Cancelled.";
  return m.length > 140 ? m.slice(0, 140) + "…" : m;
}
