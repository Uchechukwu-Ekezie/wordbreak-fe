"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useLogin, useLogout, usePrivy } from "@privy-io/react-auth";
import { useAccount, useDisconnect as useWagmiDisconnect } from "wagmi";
import { PRIVY_APP_ID } from "@/lib/config";

type WalletState = {
  account: `0x${string}` | null;
  name: string;
  setName: (n: string) => void;
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
};

const Ctx = createContext<WalletState | null>(null);

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet must be used inside <WalletProvider>");
  return v;
}

// Full wallet provider — requires Privy + Wagmi in the tree.
function WalletProviderInner({ children }: { children: React.ReactNode }) {
  const { ready } = usePrivy();
  const { address, isConnected } = useAccount();
  const { disconnect: wagmiDisconnect } = useWagmiDisconnect();

  const [name, setNameState] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const { login } = useLogin({
    onComplete: () => setConnecting(false),
    onError: (e) => {
      setConnecting(false);
      setError(e === "exited_auth_flow" ? "Connection cancelled." : e);
    },
  });
  const { logout } = useLogout();

  const account = isConnected && address ? (address as `0x${string}`) : null;

  const setName = useCallback((n: string) => {
    const t = n.trim().slice(0, 16);
    setNameState(t);
    if (typeof window !== "undefined") localStorage.setItem("wb_name", t);
  }, []);

  const connect = useCallback(async () => {
    if (!ready) return;
    setError(null);
    setConnecting(true);
    login();
  }, [ready, login]);

  const disconnect = useCallback(() => {
    void logout();
    wagmiDisconnect();
  }, [logout, wagmiDisconnect]);

  useEffect(() => {
    if (typeof window !== "undefined") setNameState(localStorage.getItem("wb_name") || "");
  }, []);

  const needsName = Boolean(account) && !name;

  return (
    <Ctx.Provider value={{ account, name, setName, connecting, error, connect, disconnect }}>
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

// Stub provider when Privy is not configured — app renders but wallet features are inert.
function WalletProviderStub({ children }: { children: React.ReactNode }) {
  return (
    <Ctx.Provider value={{ account: null, name: "", setName: () => {}, connecting: false, error: null, connect: async () => {}, disconnect: () => {} }}>
      {children}
    </Ctx.Provider>
  );
}

const hasPrivy = PRIVY_APP_ID.length > 8 && /^[a-zA-Z0-9]+$/.test(PRIVY_APP_ID);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  if (!hasPrivy) return <WalletProviderStub>{children}</WalletProviderStub>;
  return <WalletProviderInner>{children}</WalletProviderInner>;
}
