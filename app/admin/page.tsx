"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { parseUnits } from "viem";
import { API } from "@/lib/config";

type CreatePoolResult = {
  roundId: string;
  entryFee: string;
  endTime: number;
  dateKeys: string[];
};

type Pool = {
  dateKey: string;
  letters: string;
  roundId: string;
  endTime: number;
};

// Not a real auth system -- the backend's X-Admin-Token gate is the actual security boundary
// (see backend/internal/api/api.go adminOK). This is just a convenience form around the same
// POST /api/admin/pool/create call we were previously making by hand with curl. Token lives in
// sessionStorage only (cleared when the tab closes), never sent anywhere but this one endpoint.
export default function Admin() {
  const [token, setToken] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");

  const [entryFee, setEntryFee] = useState("0.01");
  const [days, setDays] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreatePoolResult | null>(null);

  const [pools, setPools] = useState<Pool[] | null>(null);
  const [poolsError, setPoolsError] = useState<string | null>(null);

  useEffect(() => {
    setToken(sessionStorage.getItem("wb_admin_token") || "");
  }, []);

  const fetchPools = async (t: string) => {
    setPoolsError(null);
    try {
      const res = await fetch(`${API}/api/admin/pool/list`, { headers: { "X-Admin-Token": t }, cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      setPools(data.pools ?? []);
    } catch (e) {
      setPoolsError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    if (token) fetchPools(token);
  }, [token]);

  const saveToken = () => {
    const t = tokenDraft.trim();
    if (!t) return;
    sessionStorage.setItem("wb_admin_token", t);
    setToken(t);
  };

  const createPool = async () => {
    setError(null);
    setResult(null);
    let feeWei: bigint;
    try {
      feeWei = parseUnits(entryFee || "0", 18);
    } catch {
      setError("Entry fee must be a number.");
      return;
    }
    if (feeWei <= 0n) {
      setError("Entry fee must be greater than 0.");
      return;
    }
    if (days < 1 || days > 90) {
      setError("Days must be between 1 and 90.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${API}/api/admin/pool/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Admin-Token": token },
        body: JSON.stringify({ entryFee: feeWei.toString(), days }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      setResult(data);
      fetchPools(token);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <main className="shell">
        <div className="gate-inner">
          <h1 className="vs-title display">Admin</h1>
          <p className="gate-tag">Enter the admin token to manage pools.</p>
          <input
            className="name-in"
            type="password"
            placeholder="Admin token"
            value={tokenDraft}
            onChange={(e) => setTokenDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && tokenDraft.trim()) saveToken(); }}
            autoFocus
          />
          <button className="btn primary gate-btn" style={{ marginTop: 14 }}
            onClick={saveToken} disabled={!tokenDraft.trim()}>
            Continue
          </button>
          <Link href="/" className="daily-link">← Home</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="shell">
      <div className="gate-inner">
        <h1 className="vs-title display">Create a pool</h1>
        <p className="gate-tag">
          Opens a round on-chain and registers it as visible starting today, for however many
          days you choose.
        </p>

        <div className="vs-create-card">
          <label className="gate-note mono" style={{ display: "block", marginBottom: 4 }}>
            Entry fee (cUSD)
          </label>
          <input
            className="vs-stake-in mono"
            type="number" min="0" step="0.01"
            value={entryFee}
            onChange={(e) => setEntryFee(e.target.value)}
            style={{ width: "100%", marginBottom: 14 }}
          />

          <label className="gate-note mono" style={{ display: "block", marginBottom: 4 }}>
            Runs for how many days (starting today)
          </label>
          <input
            className="vs-stake-in mono"
            type="number" min="1" max="90" step="1"
            value={days}
            onChange={(e) => setDays(Math.max(1, Math.min(90, Number(e.target.value) || 1)))}
            style={{ width: "100%" }}
          />

          <button className="btn primary gate-btn" style={{ marginTop: 14, width: "100%" }}
            onClick={createPool} disabled={busy}>
            {busy ? "Creating…" : "Create pool"}
          </button>
        </div>

        {error && <p className="tx-note err">{error}</p>}

        {result && (
          <div className="pool-card" style={{ marginTop: 14 }}>
            <div className="pool-top">
              <span className="pool-title display">POOL CREATED</span>
            </div>
            <p className="gate-note mono">Round {result.roundId}</p>
            <p className="gate-note mono">
              Ends {new Date(result.endTime * 1000).toUTCString()}
            </p>
            <p className="gate-note mono">
              Visible: {result.dateKeys[0]} → {result.dateKeys[result.dateKeys.length - 1]}
              {" "}({result.dateKeys.length} day{result.dateKeys.length === 1 ? "" : "s"})
            </p>
          </div>
        )}

        <div className="pool-card" style={{ marginTop: 20 }}>
          <div className="pool-top">
            <span className="pool-title display">ACTIVE POOLS</span>
            <button className="btn ghost" style={{ padding: "4px 10px" }} onClick={() => fetchPools(token)}>
              ↻
            </button>
          </div>
          {poolsError && <p className="tx-note err">{poolsError}</p>}
          {!poolsError && pools === null && <p className="gate-note mono">Loading…</p>}
          {!poolsError && pools && pools.length === 0 && (
            <p className="gate-note mono">No pools registered.</p>
          )}
          {!poolsError && pools && pools.length > 0 && (
            <div className="lb">
              {groupByRound(pools).map((g) => (
                <div className="lb-row" key={g.roundId}>
                  <span className="lb-rank mono" style={{ width: "auto" }}>{g.roundId}</span>
                  <span className="lb-addr mono">
                    {g.dateKeys[g.dateKeys.length - 1]} → {g.dateKeys[0]}
                    {" · ends "}{new Date(g.endTime * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <button className="btn ghost" style={{ marginTop: 14 }}
          onClick={() => { sessionStorage.removeItem("wb_admin_token"); setToken(""); }}>
          Log out
        </button>
        <Link href="/" className="daily-link">← Home</Link>
      </div>
    </main>
  );
}

// The backend lists one row per dateKey; a single pool spans many dateKeys sharing one
// roundId (see /api/admin/pool/create), so group them back into one row per actual pool.
function groupByRound(pools: Pool[]): { roundId: string; dateKeys: string[]; endTime: number }[] {
  const byRound = new Map<string, { roundId: string; dateKeys: string[]; endTime: number }>();
  for (const p of pools) {
    const g = byRound.get(p.roundId);
    if (g) g.dateKeys.push(p.dateKey);
    else byRound.set(p.roundId, { roundId: p.roundId, dateKeys: [p.dateKey], endTime: p.endTime });
  }
  return Array.from(byRound.values()).sort((a, b) => b.endTime - a.endTime);
}
