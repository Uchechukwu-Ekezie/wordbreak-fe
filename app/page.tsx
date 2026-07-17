"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";
import { API, CUSD_ADDRESS, TREASURY, CONTINUE_PRICE, CONTINUE_SECONDS, isConfigured } from "@/lib/config";
import { ERC20_ABI } from "@/lib/contracts";
import { hasWallet, hasConnectChoice, publicClient, sendWrite } from "@/lib/wallet";
import { levelDef, starsFor, loadProgress, saveResult, totalStars, type Progress } from "@/lib/levels";
import {
  gridLevelDef,
  gridStarsFor,
  loadGridProgress,
  saveGridResult,
  totalGridStars,
  type GridProgress,
} from "@/lib/gridLevels";
import { music, sfxGood, sfxBad, sfxWin } from "@/lib/audio";
import { useWallet } from "./wallet-provider";

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

// Grid-track drag helpers: pure functions of (index, width), no component state needed.
function isAdjacent(a: number, b: number, w: number): boolean {
  if (a === b) return false;
  const ar = Math.floor(a / w), ac = a % w;
  const br = Math.floor(b / w), bc = b % w;
  return Math.abs(ar - br) <= 1 && Math.abs(ac - bc) <= 1;
}

function cellIndexFromPoint(x: number, y: number): number | null {
  if (typeof document === "undefined") return null;
  const el = document.elementFromPoint(x, y);
  const attr = (el as Element | null)?.closest("[data-idx]")?.getAttribute("data-idx");
  return attr == null ? null : Number(attr);
}

type View =
  | "landing" | "home" | "records" | "profile" | "settings"
  | "map" | "loading" | "playing" | "result"
  | "track" | "gmap" | "gplaying" | "gresult";

export default function Game() {
  const [view, setView] = useState<View>("landing");
  const [progress, setProgress] = useState<Progress>({ unlocked: 1, stars: {}, best: {}, history: [] });
  const [level, setLevel] = useState(1);
  const [showAbout, setShowAbout] = useState(false);
  const [musicOn, setMusicOn] = useState(false);

  // per-level play state
  const [letters, setLetters] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Set<string>>(new Set());
  const [picks, setPicks] = useState<number[]>([]);
  const [found, setFound] = useState<{ word: string; pts: number }[]>([]);
  const [score, setScore] = useState(0);
  const [timeLeft, setTimeLeft] = useState(60);
  const [hints, setHints] = useState(3);
  const [hintText, setHintText] = useState<string | null>(null);
  const [fx, setFx] = useState<"pop" | "shake" | null>(null);

  // result + buy-more-time
  const [result, setResult] = useState<{ stars: number; won: boolean } | null>(null);
  const [buyOpen, setBuyOpen] = useState(false);
  const [buying, setBuying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // grid track state — Boggle-style drag-to-connect, a separate track from the rack above.
  // Fully parallel state, never shares data with the rack's letters/picks/answers/found/score.
  const [gridProgress, setGridProgress] = useState<GridProgress>({ unlocked: 1, stars: {}, best: {}, history: [] });
  const [gridLevel, setGridLevel] = useState(1);
  const [gridLetters, setGridLetters] = useState<string[]>([]);
  const [gridWidth, setGridWidth] = useState(4);
  const [gridAnswers, setGridAnswers] = useState<Set<string>>(new Set());
  const [gridPath, setGridPath] = useState<number[]>([]);
  const [gridFound, setGridFound] = useState<{ word: string; pts: number }[]>([]);
  const [gridScore, setGridScore] = useState(0);
  const [gridTimeLeft, setGridTimeLeft] = useState(60);
  const [gridFx, setGridFx] = useState<"pop" | "shake" | null>(null);
  const [gridResult, setGridResult] = useState<{ stars: number; won: boolean } | null>(null);
  const [gridBuyOpen, setGridBuyOpen] = useState(false);
  const [gridBuying, setGridBuying] = useState<string | null>(null);
  const [gridError, setGridError] = useState<string | null>(null);

  // wallet — shared app-wide via context (connect once, known everywhere)
  const {
    account, name, setName, connecting, error: connectErr,
    connect: doConnect, connectInjected, connectWalletConnect, disconnect,
  } = useWallet();
  const [balance, setBalance] = useState<bigint | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  // cUSD balance for the profile
  useEffect(() => {
    if (!account || !CUSD_ADDRESS) { setBalance(null); return; }
    publicClient
      .readContract({ address: CUSD_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [account] })
      .then((b) => setBalance(b as bigint))
      .catch(() => setBalance(null));
  }, [account]);

  const def = levelDef(level);
  const foundRef = useRef(found); foundRef.current = found;
  const scoreRef = useRef(score); scoreRef.current = score;
  const progressRef = useRef(progress); progressRef.current = progress;

  const gdef = gridLevelDef(gridLevel);
  const gridFoundRef = useRef(gridFound); gridFoundRef.current = gridFound;
  const gridScoreRef = useRef(gridScore); gridScoreRef.current = gridScore;
  const gridProgressRef = useRef(gridProgress); gridProgressRef.current = gridProgress;

  useEffect(() => { setProgress(loadProgress()); }, []);
  useEffect(() => { setGridProgress(loadGridProgress()); }, []);

  const loadRack = useCallback(async (size: number) => {
    const res = await fetch(`${API}/api/solo/rack?size=${size}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`rack ${res.status}`);
    const d: { letters: string; words: string[] } = await res.json();
    setLetters(d.letters.split(""));
    setAnswers(new Set(d.words.map((w) => w.toUpperCase())));
  }, []);

  const startLevel = useCallback(async (lvl: number) => {
    const d = levelDef(lvl);
    setLevel(lvl); setError(null); setView("loading");
    setPicks([]); setFound([]); setScore(0); setHints(3); setHintText(null); setResult(null); setBuyOpen(false);
    try {
      await loadRack(d.rackSize);
      setTimeLeft(d.seconds);
      setView("playing");
      music.start(); setMusicOn(true);
    } catch {
      setError("Can't reach the game server. Is the backend running?");
      setView("map");
    }
  }, [loadRack]);

  const loadGrid = useCallback(async (size: number) => {
    const res = await fetch(`${API}/api/solo/grid?size=${size}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`grid ${res.status}`);
    const d: { letters: string; width: number; words: string[] } = await res.json();
    setGridLetters(d.letters.split(""));
    setGridWidth(d.width);
    setGridAnswers(new Set(d.words.map((w) => w.toUpperCase())));
  }, []);

  const startGridLevel = useCallback(async (lvl: number) => {
    const d = gridLevelDef(lvl);
    setGridLevel(lvl); setGridError(null); setView("loading");
    setGridPath([]); setGridFound([]); setGridScore(0); setGridResult(null); setGridBuyOpen(false);
    try {
      await loadGrid(d.gridSize);
      setGridTimeLeft(d.seconds);
      setView("gplaying");
      music.start(); setMusicOn(true);
    } catch {
      setGridError("Can't reach the game server. Is the backend running?");
      setView("gmap");
    }
  }, [loadGrid]);

  // countdown (paused while the out-of-time modal is open)
  useEffect(() => {
    if (view !== "playing" || buyOpen) return;
    const id = setInterval(() => setTimeLeft((t) => Math.max(0, t - 1)), 1000);
    return () => clearInterval(id);
  }, [view, buyOpen]);

  // time's up → win (stars) or offer to buy more time
  useEffect(() => {
    if (view !== "playing" || buyOpen || timeLeft !== 0) return;
    const stars = starsFor(scoreRef.current, def.goal);
    if (scoreRef.current >= def.goal) {
      const np = saveResult(progressRef.current, level, scoreRef.current, foundRef.current.length, stars);
      setProgress(np);
      setResult({ stars, won: true });
      setView("result");
      sfxWin();
    } else {
      setBuyOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeLeft, view, buyOpen]);

  const flash = (k: "pop" | "shake") => { setFx(k); setTimeout(() => setFx(null), 400); };

  // grid track: countdown (paused while the out-of-time modal is open)
  useEffect(() => {
    if (view !== "gplaying" || gridBuyOpen) return;
    const id = setInterval(() => setGridTimeLeft((t) => Math.max(0, t - 1)), 1000);
    return () => clearInterval(id);
  }, [view, gridBuyOpen]);

  // grid track: time's up → win (stars) or offer to buy more time
  useEffect(() => {
    if (view !== "gplaying" || gridBuyOpen || gridTimeLeft !== 0) return;
    const stars = gridStarsFor(gridScoreRef.current, gdef.goal);
    if (gridScoreRef.current >= gdef.goal) {
      const np = saveGridResult(gridProgressRef.current, gridLevel, gridScoreRef.current, gridFoundRef.current.length, stars);
      setGridProgress(np);
      setGridResult({ stars, won: true });
      setView("gresult");
      sfxWin();
    } else {
      setGridBuyOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridTimeLeft, view, gridBuyOpen]);

  const gridFlash = (k: "pop" | "shake") => { setGridFx(k); setTimeout(() => setGridFx(null), 400); };

  const submit = useCallback(() => {
    if (view !== "playing") return;
    const word = picks.map((i) => letters[i]).join("").toUpperCase();
    setPicks([]);
    if (word.length < 3 || foundRef.current.some((f) => f.word === word) || !answers.has(word)) {
      sfxBad(); return flash("shake");
    }
    const pts = wordPoints(word.length);
    setFound((f) => [{ word, pts }, ...f]);
    setScore((s) => s + pts);
    setHintText(null);
    if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(24);
    sfxGood(); flash("pop");
  }, [view, picks, letters, answers]);

  const gridSubmit = useCallback(() => {
    if (view !== "gplaying" || gridPath.length === 0) return;
    const word = gridPath.map((i) => gridLetters[i]).join("").toUpperCase();
    setGridPath([]);
    if (word.length < 3 || gridFoundRef.current.some((f) => f.word === word) || !gridAnswers.has(word)) {
      sfxBad(); return gridFlash("shake");
    }
    const pts = wordPoints(word.length);
    setGridFound((f) => [{ word, pts }, ...f]);
    setGridScore((s) => s + pts);
    if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(24);
    sfxGood(); gridFlash("pop");
  }, [view, gridPath, gridLetters, gridAnswers]);

  const useHint = () => {
    if (hints <= 0) return;
    const got = new Set(foundRef.current.map((f) => f.word));
    const options = [...answers].filter((w) => !got.has(w)).sort((a, b) => a.length - b.length);
    if (!options.length) return;
    const w = options[0];
    setHintText(`${w[0]}${" _".repeat(w.length - 1)}  (${w.length})`);
    setHints((h) => h - 1);
  };

  const buyTime = async () => {
    setError(null);
    if (!account) { setError("Connect your wallet to buy time."); doConnect(); return; }
    if (!isConfigured() || !TREASURY) { setError("Payments aren't configured on this build."); return; }
    try {
      setBuying("Confirm payment in your wallet…");
      const hash = await sendWrite(account, { address: CUSD_ADDRESS, abi: ERC20_ABI, functionName: "transfer", args: [TREASURY, CONTINUE_PRICE] });
      setBuying("Confirming…");
      await publicClient.waitForTransactionReceipt({ hash }); // grant time only after it confirms
      setTimeLeft((t) => t + CONTINUE_SECONDS);
      setBuyOpen(false); setBuying(null);
    } catch (e) {
      setBuying(null); setError(errMsg(e));
    }
  };

  const gridBuyTime = async () => {
    setGridError(null);
    if (!account) { setGridError("Connect your wallet to buy time."); doConnect(); return; }
    if (!isConfigured() || !TREASURY) { setGridError("Payments aren't configured on this build."); return; }
    try {
      setGridBuying("Confirm payment in your wallet…");
      const hash = await sendWrite(account, { address: CUSD_ADDRESS, abi: ERC20_ABI, functionName: "transfer", args: [TREASURY, CONTINUE_PRICE] });
      setGridBuying("Confirming…");
      await publicClient.waitForTransactionReceipt({ hash });
      setGridTimeLeft((t) => t + CONTINUE_SECONDS);
      setGridBuyOpen(false); setGridBuying(null);
    } catch (e) {
      setGridBuying(null); setGridError(errMsg(e));
    }
  };

  const toggleMusic = () => setMusicOn(music.toggle());

  const resetProgress = () => {
    if (typeof window !== "undefined") localStorage.removeItem("wb_progress_v1");
    setProgress({ unlocked: 1, stars: {}, best: {}, history: [] });
  };

  const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  const tabs = (active: View) => (
    <nav className="tabbar">
      {(
        [
          ["home", "🏠", "Home"],
          ["records", "🏆", "Records"],
          ["profile", "👤", "Profile"],
          ["settings", "⚙️", "Settings"],
        ] as const
      ).map(([v, ic, label]) => (
        <button key={v} className={`tab ${active === v ? "on" : ""}`} onClick={() => setView(v)}>
          <span className="tab-ic">{ic}</span>
          <span className="tab-lb">{label}</span>
        </button>
      ))}
    </nav>
  );

  const broken = Math.min(WALL_BRICKS, Math.round((score / def.goal) * WALL_BRICKS));
  const maxSlots = Math.max(letters.length, 5);
  const mm = String(Math.floor(timeLeft / 60));
  const ss = String(timeLeft % 60).padStart(2, "0");
  const reached = score >= def.goal;

  // ---------- LANDING (play free, connect optional) ----------
  if (view === "landing") {
    const shortAcct = account ? `${account.slice(0, 6)}…${account.slice(-4)}` : "";
    return (
      <main className="shell gate">
        <div className="landing-top">
          <button className="icon-btn" onClick={toggleMusic} aria-label="music">{musicOn ? "🔊" : "🔇"}</button>
          <button className="about-link" onClick={() => setShowAbout(true)}>ABOUT</button>
        </div>
        <div className="gate-inner">
          <div className="gate-art">
            {["W", "O", "R", "D"].map((l, i) => (<span key={i} className="gate-tile">{l}</span>))}
          </div>
          <div className="gate-mark display">WORD<span className="brk">BREAK</span><span className="dot">.</span></div>
          <p className="gate-tag">Spell. Smash. Climb.<br /><b>Win cUSD.</b></p>
          <button className="btn primary gate-btn" onClick={() => { music.start(); setMusicOn(true); setView("home"); }}>
            ▶ Play free
          </button>
          {account ? (
            <button className="btn ghost gate-btn" style={{ marginTop: 10 }} onClick={doConnect} disabled={connecting}>
              ⚡ {shortAcct}
            </button>
          ) : hasConnectChoice() ? (
            <div style={{ display: "flex", gap: 8, marginTop: 10, width: "100%" }}>
              <button className="btn ghost gate-btn" style={{ flex: 1 }} onClick={connectInjected} disabled={connecting}>
                {connecting ? "Connecting…" : "⚡ MetaMask"}
              </button>
              <button className="btn ghost gate-btn" style={{ flex: 1 }} onClick={connectWalletConnect} disabled={connecting}>
                {connecting ? "Connecting…" : "🔗 WalletConnect"}
              </button>
            </div>
          ) : (
            <button className="btn ghost gate-btn" style={{ marginTop: 10 }} onClick={doConnect} disabled={connecting}>
              {connecting ? "Connecting…" : hasWallet() ? "⚡ Connect wallet" : "🔗 Connect wallet"}
            </button>
          )}
          {connectErr && <p className="tx-note err">{connectErr}</p>}
          <p className="gate-note mono">Free to play. Connect anytime to win cUSD &amp; save progress.</p>
        </div>

        {showAbout && (
          <div className="overlay" onClick={() => setShowAbout(false)}>
            <div className="card" onClick={(e) => e.stopPropagation()} style={{ boxShadow: "0 10px 0 var(--blue)" }}>
              <h1 style={{ fontSize: 30 }}>About</h1>
              <p className="tag" style={{ textAlign: "left" }}>
                WordBreak is a word game for MiniPay. Spell words from a rack of tiles to smash
                bricks and clear levels. Play free forever — or connect your wallet to enter the
                daily cUSD pool and keep what you win. Built on Celo.
              </p>
              <button className="btn" onClick={() => setShowAbout(false)}>Got it</button>
            </div>
          </div>
        )}
      </main>
    );
  }

  // ---------- HOME (mode select) ----------
  if (view === "home") {
    return (
      <main className="shell has-tabbar">
        <header className="top">
          <div className="wordmark display">WORD<span className="brk">BREAK</span><span className="dot">.</span></div>
          <div className="top-ctrls">
            <span className="stars-total mono">⭐ {totalStars(progress)}</span>
            <button className="icon-btn" onClick={toggleMusic} aria-label="music">{musicOn ? "🔊" : "🔇"}</button>
          </div>
        </header>
        <div className="modes">
          <button className="mode-card" onClick={() => setView("track")}>
            <span className="mode-emoji">🧩</span>
            <span className="mode-text"><b>Solo</b><i>Climb the levels</i></span>
            <span className="mode-go">→</span>
          </button>
          <Link href="/vs" className="mode-card">
            <span className="mode-emoji">⚔️</span>
            <span className="mode-text"><b>Multiplayer</b><i>Race up to 5 players</i></span>
            <span className="mode-go">→</span>
          </Link>
          <Link href="/daily" className="mode-card">
            <span className="mode-emoji">💰</span>
            <span className="mode-text"><b>Daily Pool</b><i>Win cUSD</i></span>
            <span className="mode-go">→</span>
          </Link>
        </div>
        {tabs("home")}
      </main>
    );
  }

  // ---------- RECORDS ----------
  if (view === "records") {
    return (
      <main className="shell has-tabbar">
        <header className="top">
          <div className="wordmark display" style={{ fontSize: 22 }}>Records</div>
          <span className="stars-total mono">⭐ {totalStars(progress)}</span>
        </header>
        <p className="tx-note" style={{ textAlign: "left", padding: "0 2px" }}>
          {progress.history.length} games · best per level saved
        </p>
        <div className="records-body">
          {progress.history.length === 0 ? (
            <div className="lb-empty">No games yet — play a Solo level.</div>
          ) : (
            progress.history.slice(0, 30).map((h, i) => (
              <div className="hist-row" key={i}>
                <span className="mono">L{h.level}</span>
                <span className="hist-stars">{"★".repeat(h.stars)}{"☆".repeat(3 - h.stars)}</span>
                <span className="mono">{h.score} pts</span>
              </div>
            ))
          )}
        </div>
        {tabs("records")}
      </main>
    );
  }

  // ---------- PROFILE (its own screen) ----------
  if (view === "profile") {
    const gamesPlayed = progress.history.length;
    const bestLevel = progress.unlocked - 1;
    return (
      <main className="shell has-tabbar">
        <header className="top">
          <div className="wordmark display" style={{ fontSize: 22 }}>Profile</div>
          <button className="icon-btn" onClick={() => setView("home")} aria-label="home">🏠</button>
        </header>

        <div className="profile-hero">
          <div className="profile-avatar-lg">{(name || "?").slice(0, 1).toUpperCase()}</div>
          {editingName ? (
            <div className="profile-edit-row">
              <input
                className="name-in"
                placeholder="Your name"
                maxLength={16}
                value={nameDraft}
                autoFocus
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && nameDraft.trim()) { setName(nameDraft); setEditingName(false); } }}
              />
              <div className="actions" style={{ marginTop: 10 }}>
                <button className="btn ghost" onClick={() => setEditingName(false)}>Cancel</button>
                <button className="btn primary" disabled={!nameDraft.trim()}
                  onClick={() => { setName(nameDraft); setEditingName(false); }}>Save</button>
              </div>
            </div>
          ) : (
            <>
              <div className="profile-name display">{name || "Unnamed player"}</div>
              <button className="set-btn" onClick={() => { setNameDraft(name); setEditingName(true); }}>
                {name ? "Edit name" : "Set your name"}
              </button>
            </>
          )}
          <div className="profile-addr mono">{account ? shortAddr(account) : "Wallet not connected"}</div>
        </div>

        <div className="pool-stats" style={{ marginBottom: 4 }}>
          <div className="pstat"><div className="pn">{totalStars(progress)}</div><div className="pk">stars</div></div>
          <div className="pstat"><div className="pn">{Math.max(bestLevel, 0)}</div><div className="pk">best level</div></div>
          <div className="pstat"><div className="pn">{gamesPlayed}</div><div className="pk">games</div></div>
        </div>

        <div className="settings-body">
          <div className="set-row">
            <span>cUSD balance</span>
            <span className="set-btn">
              {account ? (balance !== null ? `${Number(formatUnits(balance, 18)).toFixed(2)} cUSD` : "…") : "connect first"}
            </span>
          </div>
          <div className="set-row">
            <span>Wallet</span>
            {account ? (
              <button className="set-btn" onClick={disconnect}>{shortAddr(account)} · Disconnect</button>
            ) : (
              <button className="set-btn" onClick={doConnect} disabled={connecting}>
                {connecting ? "Connecting…" : "Connect"}
              </button>
            )}
          </div>
          {connectErr && <p className="tx-note err">{connectErr}</p>}
        </div>
        {tabs("profile")}
      </main>
    );
  }

  // ---------- SETTINGS ----------
  if (view === "settings") {
    return (
      <main className="shell has-tabbar">
        <header className="top">
          <div className="wordmark display" style={{ fontSize: 22 }}>Settings</div>
        </header>
        <div className="settings-body">
          <div className="set-row" onClick={() => setView("profile")} role="button">
            <span>👤 Profile · {name || "not set"}</span><span className="mode-go">→</span>
          </div>
          <div className="set-row">
            <span>Music &amp; sound</span>
            <button className="set-btn" onClick={toggleMusic}>{musicOn ? "🔊 On" : "🔇 Off"}</button>
          </div>
          <div className="set-row" onClick={() => setShowAbout(true)} role="button">
            <span>About WordBreak</span><span className="mode-go">→</span>
          </div>
          <div className="set-row danger" onClick={resetProgress} role="button">
            <span>Reset progress</span><span className="mode-go">⟲</span>
          </div>
        </div>
        {showAbout && (
          <div className="overlay" onClick={() => setShowAbout(false)}>
            <div className="card" onClick={(e) => e.stopPropagation()} style={{ boxShadow: "0 10px 0 var(--blue)" }}>
              <h1 style={{ fontSize: 30 }}>About</h1>
              <p className="tag" style={{ textAlign: "left" }}>
                WordBreak is a word game for MiniPay. Spell words to smash bricks and climb levels,
                race friends in multiplayer, or enter the daily cUSD pool. Built on Celo.
              </p>
              <button className="btn" onClick={() => setShowAbout(false)}>Got it</button>
            </div>
          </div>
        )}
        {tabs("settings")}
      </main>
    );
  }

  // ---------- MAP ----------
  if (view === "map") {
    const shown = Math.max(8, progress.unlocked + 2);
    const nodes = Array.from({ length: shown }, (_, i) => i + 1);
    return (
      <main className="shell">
        <header className="top">
          <div className="wordmark display">WORD<span className="brk">BREAK</span><span className="dot">.</span></div>
          <div className="top-ctrls">
            <span className="stars-total mono">⭐ {totalStars(progress)}</span>
            <button className="icon-btn" onClick={() => setView("home")} aria-label="home">🏠</button>
            <button className="icon-btn" onClick={toggleMusic} aria-label="music">{musicOn ? "🔊" : "🔇"}</button>
          </div>
        </header>

        {error && <div className="tx-note err">{error}</div>}

        <div className="map">
          {nodes.map((n) => {
            const locked = n > progress.unlocked;
            const st = progress.stars[n] || 0;
            return (
              <button key={n} className={`node ${locked ? "locked" : ""} ${n % 2 ? "l" : "r"}`}
                disabled={locked} onClick={() => startLevel(n)}>
                <span className="node-n display">{locked ? "🔒" : n}</span>
                {!locked && <span className="node-stars">{"★".repeat(st)}{"☆".repeat(3 - st)}</span>}
              </button>
            );
          })}
        </div>
      </main>
    );
  }

  if (view === "loading") return <div className="loading">DEALING TILES…</div>;

  // ---------- TRACK (Solo: Rack vs Grid) ----------
  if (view === "track") {
    return (
      <main className="shell">
        <header className="top">
          <div className="wordmark display" style={{ fontSize: 22 }}>Solo</div>
          <div className="top-ctrls">
            <button className="icon-btn" onClick={() => setView("home")} aria-label="home">🏠</button>
            <button className="icon-btn" onClick={toggleMusic} aria-label="music">{musicOn ? "🔊" : "🔇"}</button>
          </div>
        </header>
        <div className="modes">
          <button className="mode-card" onClick={() => setView("map")}>
            <span className="mode-emoji">🔤</span>
            <span className="mode-text"><b>Rack</b><i>Tap letters, any order</i></span>
            <span className="mode-go">→</span>
          </button>
          <button className="mode-card" onClick={() => setView("gmap")}>
            <span className="mode-emoji">🧩</span>
            <span className="mode-text"><b>Grid</b><i>Drag to connect adjacent letters</i></span>
            <span className="mode-go">→</span>
          </button>
        </div>
      </main>
    );
  }

  // ---------- GMAP (Grid track level picker) ----------
  if (view === "gmap") {
    const shown = Math.max(8, gridProgress.unlocked + 2);
    const nodes = Array.from({ length: shown }, (_, i) => i + 1);
    return (
      <main className="shell">
        <header className="top">
          <div className="wordmark display">WORD<span className="brk">BREAK</span><span className="dot">.</span></div>
          <div className="top-ctrls">
            <span className="stars-total mono">⭐ {totalGridStars(gridProgress)}</span>
            <button className="icon-btn" onClick={() => setView("home")} aria-label="home">🏠</button>
            <button className="icon-btn" onClick={toggleMusic} aria-label="music">{musicOn ? "🔊" : "🔇"}</button>
          </div>
        </header>

        {gridError && <div className="tx-note err">{gridError}</div>}

        <div className="map">
          {nodes.map((n) => {
            const locked = n > gridProgress.unlocked;
            const st = gridProgress.stars[n] || 0;
            return (
              <button key={n} className={`node ${locked ? "locked" : ""} ${n % 2 ? "l" : "r"}`}
                disabled={locked} onClick={() => startGridLevel(n)}>
                <span className="node-n display">{locked ? "🔒" : n}</span>
                {!locked && <span className="node-stars">{"★".repeat(st)}{"☆".repeat(3 - st)}</span>}
              </button>
            );
          })}
        </div>
      </main>
    );
  }

  // ---------- GPLAYING / GRESULT (Grid track) ----------
  if (view === "gplaying" || view === "gresult") {
    const gbroken = Math.min(WALL_BRICKS, Math.round((gridScore / gdef.goal) * WALL_BRICKS));
    const greached = gridScore >= gdef.goal;
    const gmm = String(Math.floor(gridTimeLeft / 60));
    const gss = String(gridTimeLeft % 60).padStart(2, "0");
    const currentWord = gridPath.map((i) => gridLetters[i]).join("");
    const slotCount = Math.max(currentWord.length, 3);

    return (
      <main className="shell">
        <header className="top">
          <div className="wordmark display">WORD<span className="brk">BREAK</span><span className="dot">.</span></div>
          <div className="top-ctrls">
            <button className="icon-btn" onClick={toggleMusic} aria-label="music">{musicOn ? "🔊" : "🔇"}</button>
            <div className={`timer ${gridTimeLeft <= 10 ? "low" : ""}`}><span className="lbl">TIME</span>{gmm}:{gss}</div>
          </div>
        </header>

        <section className="wall-wrap">
          <div className="wall-head">
            <span className="lvl display">LEVEL {gridLevel}</span>
            <span className="left">{greached ? "GOAL! keep going ★★★" : `goal ${gridScore}/${gdef.goal}`}</span>
          </div>
          <div className="wall">
            {Array.from({ length: WALL_BRICKS }).map((_, i) => (
              <div key={i} className={`brick c${i % 3} ${i < gbroken ? "broken" : ""}`} />
            ))}
          </div>
        </section>

        <div className="found">
          {gridFound.map((f) => (<span className="chip" key={f.word}>{f.word} <span className="pts">+{f.pts}</span></span>))}
        </div>

        <div className="stage">
          <div className={`input-row ${gridFx ?? ""}`}>
            {Array.from({ length: slotCount }).map((_, i) => (
              <div key={i} className={`slot ${i >= currentWord.length ? "empty" : ""}`}>{currentWord[i] ?? ""}</div>
            ))}
          </div>
          <div
            className="grid-board"
            style={{ gridTemplateColumns: `repeat(${gridWidth}, 1fr)` }}
            onPointerDown={(e) => {
              const idx = cellIndexFromPoint(e.clientX, e.clientY);
              if (idx === null) return;
              setGridPath([idx]);
              (e.target as Element).setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (gridPath.length === 0) return;
              const idx = cellIndexFromPoint(e.clientX, e.clientY);
              if (idx === null || gridPath.includes(idx)) return;
              if (!isAdjacent(gridPath[gridPath.length - 1], idx, gridWidth)) return;
              setGridPath((p) => [...p, idx]);
            }}
            onPointerUp={() => gridSubmit()}
          >
            {gridLetters.map((l, i) => (
              <div key={i} data-idx={i} className={`grid-cell ${gridPath.includes(i) ? "sel" : ""}`}>
                {l}<span className="val">{LETTER_VALUE[l] ?? ""}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="scorebar">
          <span>SCORE <b>{String(gridScore).padStart(4, "0")}</b></span>
          <span>{gridFound.length} words</span>
        </div>

        {/* out of time → buy more time */}
        {gridBuyOpen && (
          <div className="overlay">
            <div className="card" style={{ boxShadow: "0 10px 0 var(--pink)" }}>
              <h1 style={{ fontSize: 34 }}>Out of time</h1>
              <p className="tag">{gridScore}/{gdef.goal} — so close. Keep your progress and push for the goal?</p>
              {gridError && <p className="tx-note err">{gridError}</p>}
              {gridBuying && <p className="tx-note">{gridBuying}</p>}
              <button className="btn" style={{ background: "var(--green)", color: "var(--paper)" }} onClick={gridBuyTime} disabled={!!gridBuying}>
                Buy +{CONTINUE_SECONDS}s · {Number(CONTINUE_PRICE) / 1e18} cUSD
              </button>
              <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                <button className="btn ghost" style={{ flex: 1 }} onClick={() => { setGridBuyOpen(false); startGridLevel(gridLevel); }}>Retry</button>
                <button className="btn ghost" style={{ flex: 1 }} onClick={() => { setGridBuyOpen(false); setView("gmap"); }}>Map</button>
              </div>
            </div>
          </div>
        )}

        {/* result */}
        {view === "gresult" && gridResult && (
          <div className="overlay">
            <div className="card" style={{ boxShadow: "0 10px 0 var(--amber)" }}>
              <h1>LEVEL {gridLevel}</h1>
              <div className="big-stars">{"★".repeat(gridResult.stars)}{"☆".repeat(3 - gridResult.stars)}</div>
              <div className="big">{gridScore}</div>
              <div className="big-lbl">score · goal {gdef.goal}</div>
              <button className="btn" onClick={() => startGridLevel(gridLevel + 1)}>Next level →</button>
              <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                <button className="btn ghost" style={{ flex: 1 }} onClick={() => startGridLevel(gridLevel)}>Retry</button>
                <button className="btn ghost" style={{ flex: 1 }} onClick={() => setView("gmap")}>Map</button>
              </div>
            </div>
          </div>
        )}
      </main>
    );
  }

  // ---------- PLAYING / RESULT ----------
  return (
    <main className="shell">
      <header className="top">
        <div className="wordmark display">WORD<span className="brk">BREAK</span><span className="dot">.</span></div>
        <div className="top-ctrls">
          <button className="icon-btn" onClick={toggleMusic} aria-label="music">{musicOn ? "🔊" : "🔇"}</button>
          <div className={`timer ${timeLeft <= 10 ? "low" : ""}`}><span className="lbl">TIME</span>{mm}:{ss}</div>
        </div>
      </header>

      <section className="wall-wrap">
        <div className="wall-head">
          <span className="lvl display">LEVEL {level}</span>
          <span className="left">{reached ? "GOAL! keep going ★★★" : `goal ${score}/${def.goal}`}</span>
        </div>
        <div className="wall">
          {Array.from({ length: WALL_BRICKS }).map((_, i) => (
            <div key={i} className={`brick c${i % 3} ${i < broken ? "broken" : ""}`} />
          ))}
        </div>
      </section>

      <div className="found">
        {found.map((f) => (<span className="chip" key={f.word}>{f.word} <span className="pts">+{f.pts}</span></span>))}
      </div>

      {hintText && <div className="hint-pill mono">💡 {hintText}</div>}

      <div className="stage">
        <div className={`input-row ${fx ?? ""}`}>
          {Array.from({ length: maxSlots }).map((_, i) => (
            <div key={i} className={`slot ${i >= picks.length ? "empty" : ""}`}>{i < picks.length ? letters[picks[i]] : ""}</div>
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
        <div className="actions3">
          <button className="btn ghost hint" onClick={useHint} disabled={hints <= 0}>💡 {hints}</button>
          <button className="btn ghost" onClick={() => setPicks((p) => p.slice(0, -1))} disabled={picks.length === 0}>Del</button>
          <button className="btn primary" onClick={submit} disabled={picks.length < 3}>Smash</button>
        </div>
      </div>

      <div className="scorebar">
        <span>SCORE <b>{String(score).padStart(4, "0")}</b></span>
        <span>{found.length} words</span>
      </div>

      {/* out of time → buy more time */}
      {buyOpen && (
        <div className="overlay">
          <div className="card" style={{ boxShadow: "0 10px 0 var(--pink)" }}>
            <h1 style={{ fontSize: 34 }}>Out of time</h1>
            <p className="tag">{score}/{def.goal} — so close. Keep your progress and push for the goal?</p>
            {error && <p className="tx-note err">{error}</p>}
            {buying && <p className="tx-note">{buying}</p>}
            <button className="btn" style={{ background: "var(--green)", color: "var(--paper)" }} onClick={buyTime} disabled={!!buying}>
              Buy +{CONTINUE_SECONDS}s · {Number(CONTINUE_PRICE) / 1e18} cUSD
            </button>
            <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
              <button className="btn ghost" style={{ flex: 1 }} onClick={() => { setBuyOpen(false); startLevel(level); }}>Retry</button>
              <button className="btn ghost" style={{ flex: 1 }} onClick={() => { setBuyOpen(false); setView("map"); }}>Map</button>
            </div>
          </div>
        </div>
      )}

      {/* result */}
      {view === "result" && result && (
        <div className="overlay">
          <div className="card" style={{ boxShadow: "0 10px 0 var(--amber)" }}>
            <h1>LEVEL {level}</h1>
            <div className="big-stars">{"★".repeat(result.stars)}{"☆".repeat(3 - result.stars)}</div>
            <div className="big">{score}</div>
            <div className="big-lbl">score · goal {def.goal}</div>
            <button className="btn" onClick={() => startLevel(level + 1)}>Next level →</button>
            <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
              <button className="btn ghost" style={{ flex: 1 }} onClick={() => startLevel(level)}>Retry</button>
              <button className="btn ghost" style={{ flex: 1 }} onClick={() => setView("map")}>Map</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function errMsg(e: any): string {
  const m = e?.shortMessage || e?.message || String(e);
  if (/user rejected/i.test(m)) return "Cancelled.";
  return m.length > 130 ? m.slice(0, 130) + "…" : m;
}
