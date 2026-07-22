"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { formatUnits, parseUnits } from "viem";
import { ARENA_ADDRESS, isArenaConfigured } from "@/lib/config";
import { ARENA_ABI, ERC20_ABI } from "@/lib/contracts";
import { publicClient, sendWrite } from "@/lib/wallet";
import { useWallet } from "../wallet-provider";

// RoomState enum, matching WordBreakArena.sol exactly.
const OPEN = 1;

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

type OpenRoom = { id: bigint; room: RoomTuple };

function short(a: string) {
  return a.startsWith("0x") && a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export default function ArenaLobby() {
  const { account, connect: doConnect } = useWallet();
  const router = useRouter();

  const [symbol, setSymbol] = useState("");
  const [decimals, setDecimals] = useState(18);

  const [entryFee, setEntryFee] = useState("0.01");
  const [maxPlayers, setMaxPlayers] = useState("4");
  const [minPlayers, setMinPlayers] = useState("2");
  const [joinMinutes, setJoinMinutes] = useState("15");
  const [roundSeconds, setRoundSeconds] = useState("120");

  const [joinIdInput, setJoinIdInput] = useState("");
  const [openRooms, setOpenRooms] = useState<OpenRoom[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The entry token is whatever this deployment was constructed with -- read it live rather
  // than assuming cUSD (this session's testnet deployment uses native CELO's ERC-20 wrapper).
  useEffect(() => {
    if (!isArenaConfigured()) return;
    (async () => {
      try {
        const token = (await publicClient.readContract({
          address: ARENA_ADDRESS, abi: ARENA_ABI, functionName: "token",
        })) as `0x${string}`;
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

  const loadOpenRooms = useCallback(async () => {
    if (!isArenaConfigured()) return;
    try {
      const next = (await publicClient.readContract({
        address: ARENA_ADDRESS, abi: ARENA_ABI, functionName: "nextRoomId",
      })) as bigint;
      // nextRoomId is 1-indexed and monotonically increasing -- scan the most recent ~20
      // rooms and keep the ones still Open. The contract has no room-listing view, so this
      // is the practical substitute; fine at this scale, not meant to scale past a few
      // hundred rooms.
      const last = next > 1n ? next - 1n : 0n;
      const first = last > 20n ? last - 20n + 1n : 1n;
      const ids: bigint[] = [];
      for (let id = first; id <= last; id++) ids.push(id);

      const rooms = await Promise.all(
        ids.map((id) =>
          publicClient.readContract({
            address: ARENA_ADDRESS, abi: ARENA_ABI, functionName: "getRoom", args: [id],
          }) as Promise<RoomTuple>,
        ),
      );
      setOpenRooms(
        ids.map((id, i) => ({ id, room: rooms[i] })).filter((r) => r.room.state === OPEN).reverse(),
      );
    } catch {
      /* transient RPC hiccup -- next poll picks it up */
    }
  }, []);

  useEffect(() => {
    loadOpenRooms();
    const id = setInterval(loadOpenRooms, 4000);
    return () => clearInterval(id);
  }, [loadOpenRooms]);

  const createRoom = async () => {
    setError(null);
    if (!account) { doConnect(); return; }
    const fee = parseUnits(entryFee || "0", decimals);
    const max = Number(maxPlayers);
    const min = Number(minPlayers);
    if (fee <= 0n) return setError("Entry fee must be above 0.");
    if (min < 2 || max < min) return setError("Need at least 2 players, and max ≥ min.");
    const joinDeadline = BigInt(Math.floor(Date.now() / 1000) + Number(joinMinutes) * 60);

    setBusy("Creating room…");
    try {
      const hash = await sendWrite(account, {
        address: ARENA_ADDRESS, abi: ARENA_ABI, functionName: "createRoom",
        args: [fee, max, min, joinDeadline, Number(roundSeconds)],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      // createRoom returns roomId, but sendWrite only gives us the hash -- decode the
      // RoomCreated event's indexed roomId from the receipt instead of a second round-trip.
      const log = receipt.logs.find((l) => l.address.toLowerCase() === ARENA_ADDRESS.toLowerCase());
      const roomId = log?.topics[1] ? BigInt(log.topics[1]) : null;
      if (roomId) router.push(`/arena/${roomId}`);
      else await loadOpenRooms();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(null);
    }
  };

  const joinById = () => {
    const id = joinIdInput.trim();
    if (!/^\d+$/.test(id)) return setError("Enter a numeric room ID.");
    router.push(`/arena/${id}`);
  };

  if (!isArenaConfigured()) {
    return (
      <main className="shell">
        <Header />
        <div className="card" style={{ margin: "auto", boxShadow: "0 10px 0 var(--red, #ff5c5c)" }}>
          <h1 style={{ fontSize: 26 }}>Not configured</h1>
          <p className="tag">Battle Royale isn&apos;t set up on this build yet.</p>
          <Link href="/" className="btn" style={{ display: "block", textDecoration: "none", marginTop: 12 }}>
            Back home
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="shell">
      <Header />
      <div className="vs-entry-scroll">
        <div className="gate-inner" style={{ padding: "8px 0" }}>
          <div className="vs-badge">☠️</div>
          <h1 className="vs-title display">Battle Royale</h1>
          <p className="gate-tag">
            Stake in, submit one word a round.<br /><b>Lowest score is eliminated — last one standing wins.</b>
          </p>

          <div className="vs-create-card">
            <div className="vs-stake-input-row">
              <input className="vs-stake-in mono" type="number" min="0" step="0.001"
                value={entryFee} onChange={(e) => setEntryFee(e.target.value)} />
              <span className="mono">{symbol || "…"} entry</span>
            </div>
            <div className="vs-stake-input-row">
              <input className="vs-stake-in mono" type="number" min="2" step="1"
                value={minPlayers} onChange={(e) => setMinPlayers(e.target.value)} />
              <span className="mono">min players</span>
            </div>
            <div className="vs-stake-input-row">
              <input className="vs-stake-in mono" type="number" min="2" step="1"
                value={maxPlayers} onChange={(e) => setMaxPlayers(e.target.value)} />
              <span className="mono">max players</span>
            </div>
            <div className="vs-stake-input-row">
              <input className="vs-stake-in mono" type="number" min="1" step="1"
                value={joinMinutes} onChange={(e) => setJoinMinutes(e.target.value)} />
              <span className="mono">min to join</span>
            </div>
            <div className="vs-stake-input-row">
              <input className="vs-stake-in mono" type="number" min="30" step="10"
                value={roundSeconds} onChange={(e) => setRoundSeconds(e.target.value)} />
              <span className="mono">sec per round</span>
            </div>
            <button className="btn primary gate-btn" onClick={createRoom} disabled={!!busy}>
              {busy || "Create room"}
            </button>
          </div>

          <div className="vs-join">
            <input className="vs-code-in mono" placeholder="ROOM ID" inputMode="numeric"
              value={joinIdInput} onChange={(e) => setJoinIdInput(e.target.value.replace(/\D/g, ""))} />
            <button className="btn ghost" onClick={joinById} disabled={!joinIdInput}>Join</button>
          </div>
          {error && <p className="tx-note err">{error}</p>}
          <p className="gate-note mono">{account ? `Playing as ${short(account)}` : "Connect a wallet to create or join a staked room."}</p>
        </div>

        <div className="vs-public-list">
          <p className="gate-note mono" style={{ marginBottom: 8 }}>🌍 OPEN ROOMS</p>
          {openRooms.length === 0 ? (
            <div className="lb-empty">No open rooms right now — create one!</div>
          ) : (
            openRooms.map(({ id, room }) => (
              <div className="vs-pub-row" key={id.toString()}>
                <div className="vs-pub-meta">
                  <span className="vs-pub-code mono">#{id.toString()}</span>
                  <span className="vs-pub-players">
                    {formatUnits(room.entryFee, decimals)} {symbol} entry · min {room.minPlayers}, max {room.maxPlayers}
                  </span>
                </div>
                <Link href={`/arena/${id}`} className="btn ghost">Open</Link>
              </div>
            ))
          )}
        </div>
      </div>
    </main>
  );
}

function Header() {
  return (
    <header className="top">
      <div className="wordmark display">WORD<span className="brk">BREAK</span><span className="dot">.</span></div>
      <Link href="/" className="about-link">HOME</Link>
    </header>
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function msg(e: any): string {
  const m = e?.shortMessage || e?.message || String(e);
  if (/user rejected/i.test(m)) return "Cancelled.";
  return m.length > 130 ? m.slice(0, 130) + "…" : m;
}
