"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import {
  connect as rawConnect,
  connectInjected as rawConnectInjected,
  connectWalletConnect as rawConnectWalletConnect,
  injectedProvider,
  disconnectActive,
  subscribeActiveProviderEvents,
  restoreWalletConnectSession,
} from "@/lib/wallet";

type WalletState = {
  account: `0x${string}` | null;
  name: string;
  setName: (n: string) => void;
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  connectInjected: () => Promise<void>;
  connectWalletConnect: () => Promise<void>;
  disconnect: () => void;
};

const Ctx = createContext<WalletState | null>(null);

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet must be used inside <WalletProvider>");
  return v;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [name, setNameState] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const setName = useCallback((n: string) => {
    const t = n.trim().slice(0, 16);
    setNameState(t);
    if (typeof window !== "undefined") localStorage.setItem("wb_name", t);
  }, []);

  const finishConnect = useCallback(async (fn: () => Promise<`0x${string}`>) => {
    setError(null);
    setConnecting(true);
    try {
      const addr = await fn();
      setAccount(addr);
      // fn() activated either the injected or the WalletConnect provider — (re)subscribe now
      // that it's known which one.
      subscribeActiveProviderEvents(
        (a) => setAccount(a?.[0] ? (a[0] as `0x${string}`) : null),
        () => setAccount(null),
      );
    } catch (e: any) {
      const m = e?.shortMessage || e?.message || String(e);
      setError(/user rejected/i.test(m) ? "Connection cancelled." : m);
    } finally {
      setConnecting(false);
    }
  }, []);

  // Smart default (injected first, WalletConnect fallback) — used by deep call sites
  // (buy-time, staked-room gates, settings) that just need "get connected, whatever works".
  const connect = useCallback(() => finishConnect(rawConnect), [finishConnect]);
  // Explicit choices — used by primary connect entry points so a user with both an injected
  // wallet AND WalletConnect available can pick, instead of always silently getting injected.
  const connectInjected = useCallback(() => finishConnect(rawConnectInjected), [finishConnect]);
  const connectWalletConnect = useCallback(() => finishConnect(rawConnectWalletConnect), [finishConnect]);

  const disconnect = useCallback(() => {
    void disconnectActive(); // best-effort session teardown (WalletConnect); no-op for injected
    setAccount(null);
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") setNameState(localStorage.getItem("wb_name") || "");

    const onAccounts = (a: string[]) => setAccount(a?.[0] ? (a[0] as `0x${string}`) : null);
    const onDisconnect = () => setAccount(null);

    const eth = injectedProvider();
    if (eth) {
      eth
        .request?.({ method: "eth_accounts" })
        .then((a: string[]) => {
          if (a?.[0]) setAccount(a[0] as `0x${string}`);
        })
        .catch(() => {});
      return subscribeActiveProviderEvents(onAccounts, onDisconnect);
    }

    // No injected wallet — silently restore a previous WalletConnect session, if any.
    let unsubscribe: (() => void) | undefined;
    restoreWalletConnectSession().then((addr) => {
      if (addr) {
        setAccount(addr);
        unsubscribe = subscribeActiveProviderEvents(onAccounts, onDisconnect);
      }
    });
    return () => unsubscribe?.();
  }, []);

  // First time a wallet connects without a name → simple registration.
  const needsName = Boolean(account) && !name;

  return (
    <Ctx.Provider
      value={{ account, name, setName, connecting, error, connect, connectInjected, connectWalletConnect, disconnect }}
    >
      {children}
      {needsName && (
        <div className="overlay">
          <div className="card" style={{ boxShadow: "0 10px 0 var(--blue)" }}>
            <h1 style={{ fontSize: 30 }}>Welcome! 👋</h1>
            <p className="tag">Pick a name — it&apos;s how you show up on leaderboards and in multiplayer.</p>
            <input
              className="name-in"
              placeholder="Your name"
              maxLength={16}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && draft.trim()) setName(draft); }}
              autoFocus
            />
            <button className="btn primary" style={{ width: "100%", marginTop: 14 }}
              onClick={() => setName(draft)} disabled={!draft.trim()}>
              Start playing
            </button>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}
