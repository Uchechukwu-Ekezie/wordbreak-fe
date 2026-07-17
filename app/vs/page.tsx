"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { API, POOLS_ADDRESS, CUSD_ADDRESS, isConfigured } from "@/lib/config";
import { POOLS_ABI, ERC20_ABI } from "@/lib/contracts";
import { publicClient, sendWrite } from "@/lib/wallet";
import { music, sfxGood, sfxBad, sfxWin } from "@/lib/audio";
import { useWallet } from "../wallet-provider";

type PlayerView = { id: string; name: string; score: number; words: number };
type RoomView = {
  code: string;
  state: "lobby" | "racing" | "done";
  host: string;
  public: boolean;
  letters: string;
  timeLeft: number;
  players: PlayerView[];
  winner: string;
  you: string;
  stake: string; // wei decimal string, "0" = free
  pot: string;
  roundId?: string;
  stakeEndsIn?: number;
  settleStatus?: string; // "" | "pending" | "settled" | "failed"
  settleErr?: string;
};

const LETTER_VALUE: Record<string, number> = {
  A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8, K: 5, L: 1, M: 3,
  N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1, U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10,
};

function short(a: string) {
  return a.startsWith("0x") && a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function cusd(wei: string) {
  try { return `${Number(formatUnits(BigInt(wei), 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })} cUSD`; }
  catch { return "0 cUSD"; }
}

// Player identity: wallet address if connected, else a persisted guest id. Guests can only
// play free rooms — staked rooms require a real wallet since the stake is a real transaction.
function guestId(): string {
  if (typeof window === "undefined") return "guest";
  let id = localStorage.getItem("wb_pid");
  if (!id) {
    id = "guest-" + Math.random().toString(36).slice(2, 8);
    localStorage.setItem("wb_pid", id);
  }
  return id;
}

function saveSession(code: string, pid: string) {
  if (typeof window !== "undefined") localStorage.setItem("wb_room", JSON.stringify({ code, pid }));
}
function clearSession() {
  if (typeof window !== "undefined") localStorage.removeItem("wb_room");
}
function loadSession(): { code: string; pid: string } | null {
  if (typeof window === "undefined") return null;
  try { return JSON.parse(localStorage.getItem("wb_room") || "null"); } catch { return null; }
}

export default function Versus() {
  const { account, name: profileName, connect: doConnect } = useWallet();
  const [pid, setPid] = useState("");
  const [room, setRoom] = useState<RoomView | null>(null);
  const [restoring, setRestoring] = useState(true);

  const [codeInput, setCodeInput] = useState("");
  const [publicRooms, setPublicRooms] = useState<RoomView[]>([]);
  const [wantPublic, setWantPublic] = useState(true);
  const [wantStake, setWantStake] = useState(false);
  const [stakeInput, setStakeInput] = useState("0.5");

  const [picks, setPicks] = useState<number[]>([]);
  const [attempts, setAttempts] = useState<string[]>([]);
  const [fx, setFx] = useState<"pop" | "shake" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const attemptsRef = useRef<string[]>([]);
  attemptsRef.current = attempts;
  const wonRef = useRef(false);

  useEffect(() => { setPid(account || guestId()); }, [account]);
  const name = profileName || (account ? short(account) : `Player-${pid.slice(-4)}`);

  const post = useCallback(async (path: string, body: object) => {
    const res = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  }, []);

  // Restore an in-progress room on mount (so "play solo while waiting" doesn't lose your seat).
  useEffect(() => {
    const s = loadSession();
    if (!s) { setRestoring(false); return; }
    fetch(`${API}/api/room/${s.code}?you=${s.pid}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((v: RoomView | null) => {
        if (v && v.players.some((p) => p.id === s.pid)) { setPid(s.pid); setRoom(v); }
        else clearSession();
      })
      .catch(() => {})
      .finally(() => setRestoring(false));
  }, []);

  // Poll the public room list on the entry screen.
  useEffect(() => {
    if (room || restoring) return;
    const load = () => fetch(`${API}/api/room/list`, { cache: "no-store" })
      .then((r) => r.json()).then((d) => setPublicRooms(d.rooms ?? [])).catch(() => {});
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [room, restoring]);

  // Stake a fixed amount of cUSD into a room's on-chain round: approve then enter.
  const stakeOnChain = async (roundId: string, stakeWei: bigint) => {
    if (!account) throw new Error("Connect your wallet to stake.");
    if (!isConfigured()) throw new Error("Staking isn't configured on this build.");
    setBusy("Approving cUSD…");
    const allowance = (await publicClient.readContract({
      address: CUSD_ADDRESS, abi: ERC20_ABI, functionName: "allowance", args: [account, POOLS_ADDRESS],
    })) as bigint;
    if (allowance < stakeWei) {
      const ah = await sendWrite(account, { address: CUSD_ADDRESS, abi: ERC20_ABI, functionName: "approve", args: [POOLS_ADDRESS, stakeWei] });
      await publicClient.waitForTransactionReceipt({ hash: ah });
    }
    setBusy("Staking on-chain…");
    const eh = await sendWrite(account, { address: POOLS_ADDRESS, abi: POOLS_ABI, functionName: "enter", args: [BigInt(roundId)] });
    await publicClient.waitForTransactionReceipt({ hash: eh });
  };

  const createRoom = async () => {
    setError(null);
    const stakeWei = wantStake ? parseUnits(stakeInput || "0", 18) : 0n;
    if (wantStake && stakeWei <= 0n) { setError("Enter a stake amount above 0."); return; }
    if (wantStake && !account) { doConnect(); return; }
    setBusy(wantStake ? "Opening stake on-chain…" : "Creating room…");
    try {
      music.start();
      const myId = wantStake ? account! : pid;
      const v: RoomView = await post("/api/room/create", {
        playerId: myId, name, public: wantPublic, stake: wantStake ? stakeWei.toString() : "0",
      });
      if (wantStake) {
        // Host stakes too — everyone in a staked room, including the host, must have entered.
        await stakeOnChain(v.roundId!, stakeWei);
        const joined: RoomView = await post("/api/room/join", { code: v.code, playerId: myId, name });
        setRoom(joined); saveSession(v.code, myId);
      } else {
        setRoom(v); saveSession(v.code, myId);
      }
    } catch (e) { setError(msg(e)); } finally { setBusy(null); }
  };

  const joinRoomByCode = async (code: string) => {
    setError(null); setBusy("Checking room…");
    try {
      music.start();
      // Peek at the room first — staked rooms need on-chain entry before /join will accept us.
      const info: RoomView = await fetch(`${API}/api/room/${code}`, { cache: "no-store" }).then((r) => r.json());
      const isStaked = info?.stake && info.stake !== "0";
      const myId = isStaked ? account : pid;
      if (isStaked && !account) { setBusy(null); doConnect(); return; }
      if (isStaked) await stakeOnChain(info.roundId!, BigInt(info.stake));
      setBusy("Joining room…");
      const v: RoomView = await post("/api/room/join", { code, playerId: myId, name });
      setRoom(v); saveSession(code, myId!);
    } catch (e) { setError(msg(e)); } finally { setBusy(null); }
  };

  const startRace = async () => {
    setError(null);
    try { setRoom(await post("/api/room/start", { code: room!.code, playerId: pid })); setAttempts([]); }
    catch (e) { setError(msg(e)); }
  };

  // Poll room state while in a room (until done, then a few more times to catch settlement).
  useEffect(() => {
    if (!room) return;
    const id = setInterval(async () => {
      try {
        const res = await fetch(`${API}/api/room/${room.code}?you=${pid}`, { cache: "no-store" });
        if (res.ok) setRoom(await res.json());
      } catch { /* transient */ }
    }, 1500);
    return () => clearInterval(id);
  }, [room?.code, pid]);

  // Win chime once, when the race ends and you're the winner.
  useEffect(() => {
    if (room?.state === "done" && room.winner === pid && !wonRef.current) {
      wonRef.current = true;
      sfxWin();
    }
    if (room?.state !== "done") wonRef.current = false;
  }, [room?.state, room?.winner, pid]);

  const flash = (k: "pop" | "shake") => { setFx(k); setTimeout(() => setFx(null), 400); };

  const submitWord = async () => {
    if (!room || room.state !== "racing") return;
    const letters = room.letters.split("");
    const word = picks.map((i) => letters[i]).join("").toUpperCase();
    setPicks([]);
    if (word.length < 3 || attemptsRef.current.includes(word)) { sfxBad(); return flash("shake"); }
    setAttempts((a) => [...a, word]);
    try {
      const data = await post("/api/room/submit", { code: room.code, playerId: pid, word });
      setRoom(data.room);
      if (data.accepted) { if (navigator.vibrate) navigator.vibrate(22); sfxGood(); flash("pop"); }
      else { sfxBad(); flash("shake"); }
    } catch { sfxBad(); flash("shake"); }
  };

  const claim = async () => {
    if (!account) return;
    setBusy("Claiming…"); setError(null);
    try {
      const h = await sendWrite(account, { address: POOLS_ADDRESS, abi: POOLS_ABI, functionName: "claim", args: [] });
      await publicClient.waitForTransactionReceipt({ hash: h });
      setBusy(null);
    } catch (e) { setBusy(null); setError(msg(e)); }
  };

  const leave = () => { setRoom(null); setPicks([]); setAttempts([]); setError(null); clearSession(); };

  if (restoring) return <div className="loading">RECONNECTING…</div>;

  // ---------- ENTRY ----------
  if (!room) {
    return (
      <main className="shell">
        <header className="top">
          <div className="wordmark display">WORD<span className="brk">BREAK</span><span className="dot">.</span></div>
          <Link href="/" className="about-link">HOME</Link>
        </header>
        <div className="vs-entry-scroll">
          <div className="gate-inner" style={{ padding: "8px 0" }}>
            <div className="vs-badge">⚔️</div>
            <h1 className="vs-title display">Multiplayer</h1>
            <p className="gate-tag">Up to 5 players, same letters, 60 seconds.<br /><b>Highest score wins.</b></p>

            <div className="vs-create-card">
              <div className="vs-toggle-row">
                <button className={`vs-toggle ${wantPublic ? "on" : ""}`} onClick={() => setWantPublic(true)}>🌍 Public</button>
                <button className={`vs-toggle ${!wantPublic ? "on" : ""}`} onClick={() => setWantPublic(false)}>🔒 Private</button>
              </div>
              <label className="vs-stake-check">
                <input type="checkbox" checked={wantStake} onChange={(e) => setWantStake(e.target.checked)} />
                💰 Stake cUSD — winner takes all
              </label>
              {wantStake && (
                <div className="vs-stake-input-row">
                  <input className="vs-stake-in mono" type="number" min="0" step="0.05"
                    value={stakeInput} onChange={(e) => setStakeInput(e.target.value)} />
                  <span className="mono">cUSD each</span>
                </div>
              )}
              <button className="btn primary gate-btn" onClick={createRoom} disabled={!!busy}>
                {busy || (wantStake ? "Create staked room" : "Create a room")}
              </button>
            </div>

            <div className="vs-join">
              <input className="vs-code-in mono" placeholder="CODE" maxLength={4}
                value={codeInput} onChange={(e) => setCodeInput(e.target.value.toUpperCase())} />
              <button className="btn ghost" onClick={() => joinRoomByCode(codeInput.trim())} disabled={!!busy || codeInput.length < 4}>Join</button>
            </div>
            {error && <p className="tx-note err">{error}</p>}
            <p className="gate-note mono">{account ? `Playing as ${short(account)}` : "Playing free as a guest — connect to stake cUSD."}</p>
          </div>

          <div className="vs-public-list">
            <p className="gate-note mono" style={{ marginBottom: 8 }}>🌍 OPEN PUBLIC ROOMS</p>
            {publicRooms.length === 0 ? (
              <div className="lb-empty">No open rooms right now — create one!</div>
            ) : (
              publicRooms.map((r) => (
                <div className="vs-pub-row" key={r.code}>
                  <div className="vs-pub-meta">
                    <span className="vs-pub-code mono">{r.code}</span>
                    <span className="vs-pub-players">{r.players.length}/5 players{r.stake !== "0" ? ` · 💰 ${cusd(r.stake)} stake` : ""}</span>
                  </div>
                  <button className="btn ghost" onClick={() => joinRoomByCode(r.code)} disabled={!!busy}>Join</button>
                </div>
              ))
            )}
          </div>
        </div>
      </main>
    );
  }

  const isHost = room.host === pid;
  const you = room.players.find((p) => p.id === pid);
  const staked = room.stake !== "0";

  // ---------- LOBBY ----------
  if (room.state === "lobby") {
    return (
      <main className="shell">
        <header className="top">
          <div className="wordmark display">WORD<span className="brk">BREAK</span><span className="dot">.</span></div>
          <button className="about-link" onClick={leave}>LEAVE</button>
        </header>
        <div className="gate-inner">
          <p className="gate-note mono">{room.public ? "🌍 PUBLIC" : "🔒 PRIVATE"} ROOM CODE</p>
          <div className="vs-code display">{room.code}</div>
          {staked && (
            <div className="vs-stake-banner">
              💰 {cusd(room.stake)} each · pot {cusd(room.pot)}
              {room.stakeEndsIn ? ` · staking closes in ${Math.floor(room.stakeEndsIn / 60)}:${String(room.stakeEndsIn % 60).padStart(2, "0")}` : ""}
            </div>
          )}
          <div className="vs-players">
            {room.players.map((p) => (
              <div className="vs-player" key={p.id}>
                <span>{p.name}{p.id === room.host ? " 👑" : ""}</span>
                {p.id === pid && <span className="vs-you">YOU</span>}
              </div>
            ))}
            {Array.from({ length: 5 - room.players.length }).map((_, i) => (
              <div className="vs-player empty" key={`e${i}`}>waiting…</div>
            ))}
          </div>
          {isHost ? (
            <button className="btn primary gate-btn" onClick={startRace}>Start race</button>
          ) : (
            <p className="tx-note">Waiting for the host to start…</p>
          )}
          {error && <p className="tx-note err">{error}</p>}
          <Link href="/" className="daily-link">🧩 Play Solo while you wait →</Link>
        </div>
      </main>
    );
  }

  // ---------- RACE / DONE ----------
  const letters = room.letters.split("");
  const maxSlots = Math.max(letters.length, 5);
  const racing = room.state === "racing";

  return (
    <main className="shell">
      <header className="top">
        <div className="wordmark display">WORD<span className="brk">BREAK</span><span className="dot">.</span></div>
        <div className={`timer ${room.timeLeft <= 10 && racing ? "low" : ""}`}>
          <span className="lbl">TIME</span>0:{String(room.timeLeft).padStart(2, "0")}
        </div>
      </header>

      {/* live standings */}
      <div className="vs-board">
        {room.players.map((p, i) => (
          <div className={`vs-row ${p.id === pid ? "me" : ""} ${room.state === "done" && p.id === room.winner ? "win" : ""}`} key={p.id}>
            <span className="vs-rank mono">{room.state === "done" && i === 0 ? "🏆" : i + 1}</span>
            <span className="vs-name">{p.name}{p.id === pid ? " (you)" : ""}</span>
            <span className="vs-score mono">{p.score}</span>
          </div>
        ))}
      </div>

      {room.state === "done" ? (
        <div className="gate-inner">
          <div className="big-stars">🏆</div>
          <h1 className="vs-title display">{room.winner === pid ? "You win!" : `${room.players[0]?.name || ""} wins`}</h1>
          <div className="big">{you?.score ?? 0}</div>
          <div className="big-lbl">your score</div>

          {staked && (
            <div className="vs-stake-banner" style={{ marginTop: 12 }}>
              {room.settleStatus === "pending" && "⏳ Payout processing on-chain…"}
              {room.settleStatus === "failed" && `⚠️ Payout failed: ${room.settleErr || "unknown error"}`}
              {room.settleStatus === "settled" && room.winner === pid && "✅ Payout sent — claim it below"}
              {room.settleStatus === "settled" && room.winner !== pid && "✅ Winner has been paid"}
              {!room.settleStatus && "Waiting for the stake window to close…"}
            </div>
          )}
          {staked && room.settleStatus === "settled" && room.winner === pid && (
            <button className="btn win gate-btn" onClick={claim} disabled={!!busy}>
              {busy || `Claim ${cusd(room.pot)}`}
            </button>
          )}
          {error && <p className="tx-note err">{error}</p>}

          <button className="btn primary gate-btn" style={{ marginTop: 12 }} onClick={leave}>Play again</button>
          <Link href="/" className="daily-link">← Home</Link>
        </div>
      ) : (
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
          <div className="actions">
            <button className="btn ghost" onClick={() => setPicks((p) => p.slice(0, -1))} disabled={picks.length === 0}>Del</button>
            <button className="btn primary" onClick={submitWord} disabled={picks.length < 3}>Smash</button>
          </div>
        </div>
      )}
    </main>
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function msg(e: any): string {
  const m = e?.shortMessage || e?.message || String(e);
  if (/user rejected/i.test(m)) return "Cancelled.";
  return m.length > 130 ? m.slice(0, 130) + "…" : m;
}
