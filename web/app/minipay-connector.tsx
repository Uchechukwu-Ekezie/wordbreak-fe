"use client";

import { useEffect } from "react";
import { useConnect, useAccount } from "wagmi";

// Auto-connects the injected wagmi connector whenever the app is loaded inside Opera
// MiniPay. Detection is `window.ethereum?.isMiniPay === true`, the standard check for
// MiniPay's injected provider.
//
// Two things this owns:
//   1. Uses the wagmi-registered connector (connectors[0]), not a fresh injected()
//      instance — a new instance would bypass the shimDisconnect setting from
//      lib/wagmiConfig.ts.
//   2. Polls briefly for window.ethereum — some MiniPay builds inject the provider
//      after DOMContentLoaded, so an on-mount-only check can miss it.
export default function MiniPayConnector() {
  const { connect, connectors } = useConnect();
  const { isConnected } = useAccount();

  useEffect(() => {
    if (typeof window === "undefined" || isConnected) return;

    const tryConnect = () => {
      const eth = (window as Window & { ethereum?: { isMiniPay?: boolean } }).ethereum;
      if (!eth?.isMiniPay) return false;
      const injectedConnector = connectors.find((c) => c.id === "injected") || connectors[0];
      if (!injectedConnector) return false;
      connect({ connector: injectedConnector });
      return true;
    };

    if (tryConnect()) return;

    let tries = 0;
    const id = window.setInterval(() => {
      tries += 1;
      if (tryConnect() || tries > 6) window.clearInterval(id);
    }, 250);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, connectors]);

  return null;
}
