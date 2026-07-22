"use client";

import { useEffect, useRef } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useSetActiveWallet } from "@privy-io/wagmi";
import { useAccount } from "wagmi";

// Bridges Privy's wallet list into wagmi's active connector. @privy-io/wagmi does NOT
// activate a wallet in wagmi automatically after login -- without this, a fresh login
// (no prior wagmi reconnect-cache entry) leaves useAccount().address empty even though
// Privy reports authenticated: true, and the app would treat the player as disconnected.
//
// Prefers an external wallet (MetaMask, MiniPay's injected provider) over the Privy
// embedded one when both are present, since a player who connected an external wallet
// is that address, not the empty auto-created embedded one.
export default function ActiveWalletSync() {
  const { ready, authenticated } = usePrivy();
  const { wallets } = useWallets();
  const { setActiveWallet } = useSetActiveWallet();
  const { address } = useAccount();
  const attempting = useRef(false);

  useEffect(() => {
    if (!ready || !authenticated || address || attempting.current) return;
    const external = wallets.find((w) => w.walletClientType !== "privy");
    const wallet = external ?? wallets[0];
    if (!wallet) return;

    attempting.current = true;
    setActiveWallet(wallet)
      .catch(() => {})
      .finally(() => {
        setTimeout(() => {
          attempting.current = false;
        }, 1500);
      });
  }, [ready, authenticated, address, wallets, setActiveWallet]);

  return null;
}
