"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";
const START_SECONDS = 90;
const LEVEL_BONUS = 12; // seconds added for clearing a wall
const WALL_BRICKS = 24; // bricks per level

// Mirrors the backend's game.WordPoints so the client scores identically.
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

function rackSizeFor(level: number): number {
  return Math.min(4 + level, 8); // L1=5, L2=6, L3=7, L4+=8
}

type Found = { word: string; pts: number };
type Status = "start" | "loading" | "playing" | "over";

export default function Game() {
  const [status, setStatus] = useState<Status>("start");
  const [level, setLevel] = useState(1);
  const [letters, setLetters] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Set<string>>(new Set());
  const [picks, setPicks] = useState<number[]>([]); // ordered tile indices
  const [found, setFound] = useState<Found[]>([]);
  const [broken, setBroken] = useState(0);
  const [score, setScore] = useState(0);
  const [totalWords, setTotalWords] = useState(0);
  const [timeLeft, setTimeLeft] = useState(START_SECONDS);
  const [fx, setFx] = useState<"pop" | "shake" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const foundRef = useRef(found);
  foundRef.current = found;

  const current = picks.map((i) => letters[i]).join("");

  const loadRack = useCallback(async (lvl: number) => {
    const res = await fetch(`${API}/api/solo/rack?size=${rackSizeFor(lvl)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`rack ${res.status}`);
    const data: { letters: string; words: string[] } = await res.json();
    setLetters(data.letters.split(""));
    setAnswers(new Set(data.words.map((w) => w.toUpperCase())));
    setPicks([]);
    setFound([]);
    setBroken(0);
  }, []);

  const start = useCallback(async () => {
    setStatus("loading");
    setError(null);
    setLevel(1);
    setScore(0);
    setTotalWords(0);
    setTimeLeft(START_SECONDS);
    try {
      await loadRack(1);
      setStatus("playing");
    } catch {
      setError("Can't reach the game server. Is the backend running?");
      setStatus("start");
    }
  }, [loadRack]);

  // Countdown.
  useEffect(() => {
    if (status !== "playing") return;
    const id = setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) {
          clearInterval(id);
          setStatus("over");
          return 0;
        }
        return t - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [status]);

  const flash = (kind: "pop" | "shake") => {
    setFx(kind);
    setTimeout(() => setFx(null), 400);
  };

  const clearPicks = () => setPicks([]);

  const tapTile = (i: number) => {
    if (status !== "playing" || picks.includes(i)) return;
    setPicks((p) => [...p, i]);
  };

  const removeLast = () => setPicks((p) => p.slice(0, -1));

  const submit = useCallback(() => {
    if (status !== "playing") return;
    const word = picks.map((i) => letters[i]).join("").toUpperCase();
    if (word.length < 3) return flash("shake");
    if (foundRef.current.some((f) => f.word === word)) {
      clearPicks();
      return flash("shake");
    }
    if (!answers.has(word)) {
      clearPicks();
      return flash("shake");
    }

    const pts = wordPoints(word.length);
    setFound((f) => [{ word, pts }, ...f]);
    setScore((s) => s + pts);
    setTotalWords((n) => n + 1);
    if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(28);
    flash("pop");
    clearPicks();

    setBroken((b) => {
      const nb = Math.min(WALL_BRICKS, b + pts);
      if (nb >= WALL_BRICKS) {
        // Wall cleared → next level.
        setTimeout(() => {
          setLevel((lv) => {
            const next = lv + 1;
            setTimeLeft((t) => t + LEVEL_BONUS);
            loadRack(next).catch(() => setStatus("over"));
            return next;
          });
        }, 450);
      }
      return nb;
    });
  }, [answers, letters, picks, status, loadRack]);

  // Physical keyboard (desktop testing): type letters, Enter submits, Backspace deletes.
  useEffect(() => {
    if (status !== "playing") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") return submit();
      if (e.key === "Backspace") return removeLast();
      const k = e.key.toUpperCase();
      if (k.length === 1 && k >= "A" && k <= "Z") {
        const idx = letters.findIndex((l, i) => l === k && !picks.includes(i));
        if (idx >= 0) setPicks((p) => [...p, idx]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status, letters, picks, submit]);

  if (status === "loading") {
    return <div className="loading">DEALING TILES…</div>;
  }

  const maxSlots = Math.max(letters.length, 5);
  const mm = String(Math.floor(timeLeft / 60));
  const ss = String(timeLeft % 60).padStart(2, "0");

  return (
    <main className="shell">
      <header className="top">
        <div className="wordmark display">
          WORD<span className="brk">BREAK</span>
          <span className="dot">.</span>
        </div>
        <div className={`timer ${timeLeft <= 10 && status === "playing" ? "low" : ""}`}>
          <span className="lbl">TIME</span>
          {mm}:{ss}
        </div>
      </header>

      <section className="wall-wrap">
        <div className="wall-head">
          <span className="lvl display">LEVEL {level}</span>
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
          <span className="chip" key={f.word}>
            {f.word} <span className="pts">+{f.pts}</span>
          </span>
        ))}
      </div>

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
            <button
              key={i}
              className={`tile ${picks.includes(i) ? "used" : ""}`}
              onClick={() => tapTile(i)}
              aria-label={`letter ${l}`}
            >
              {l}
              <span className="val">{LETTER_VALUE[l] ?? ""}</span>
            </button>
          ))}
        </div>

        <div className="actions">
          <button className="btn ghost" onClick={removeLast} disabled={picks.length === 0}>
            Delete
          </button>
          <button className="btn primary" onClick={submit} disabled={picks.length < 3}>
            Smash
          </button>
        </div>
      </div>

      <div className="scorebar">
        <span>
          SCORE <b>{String(score).padStart(4, "0")}</b>
        </span>
        <span>{totalWords} words</span>
      </div>

      {status === "start" && (
        <div className="overlay">
          <div className="card">
            <h1>
              WORD<span className="brk">BREAK</span>
            </h1>
            <p className="tag">Spell words from the tiles to smash the wall. Longer words hit harder. Beat the clock.</p>
            {error && <p style={{ color: "var(--pink)", marginBottom: 14, fontSize: 14 }}>{error}</p>}
            <button className="btn" onClick={start}>
              Play
            </button>
            <Link href="/daily" className="daily-link">Daily pool for cUSD →</Link>
          </div>
        </div>
      )}

      {status === "over" && (
        <div className="overlay">
          <div className="card">
            <h1>TIME&apos;S UP</h1>
            <p className="tag">Nice spelling.</p>
            <div className="big">{score}</div>
            <div className="big-lbl">final score</div>
            <div className="row2">
              <div className="stat">
                <div className="n">{level}</div>
                <div className="k">level</div>
              </div>
              <div className="stat">
                <div className="n">{totalWords}</div>
                <div className="k">words</div>
              </div>
            </div>
            <button className="btn" onClick={start}>
              Play again
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
