"use client";

import { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PrivyProvider } from "@privy-io/react-auth";
import { WagmiProvider } from "@privy-io/wagmi";
import { wagmiConfig, supportedChains } from "@/lib/wagmiConfig";
import { PRIVY_APP_ID, WC_PROJECT_ID } from "@/lib/config";
import MiniPayConnector from "./minipay-connector";
import ActiveWalletSync from "./active-wallet-sync";

const queryClient = new QueryClient();

export function Providers({ children }: { children: ReactNode }) {
  if (!PRIVY_APP_ID) return <>{children}</>;
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        appearance: { theme: "dark", showWalletLoginFirst: false },
        loginMethods: ["wallet", "email", "google", "twitter", "discord"],
        defaultChain: supportedChains[0],
        supportedChains: [...supportedChains],
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
        ...(WC_PROJECT_ID ? { walletConnectCloudProjectId: WC_PROJECT_ID } : {}),
      }}
    >
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig}>
          <MiniPayConnector />
          <ActiveWalletSync />
          {children}
        </WagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  );
}
