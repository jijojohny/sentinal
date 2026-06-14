import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import "@solana/wallet-adapter-react-ui/styles.css";
import App from "./App";
import { CLUSTERS, ClusterKey } from "./config";

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { err: any }> {
  state = { err: null as any };
  static getDerivedStateFromError(err: any) { return { err }; }
  componentDidCatch(err: any) { console.error("Sentinel UI error:", err); }
  render() {
    if (this.state.err) {
      return (
        <div style={{ color: "#f87171", fontFamily: "monospace", padding: 24, whiteSpace: "pre-wrap" }}>
          <h2>UI error</h2>
          <p>{String(this.state.err?.message ?? this.state.err)}</p>
          <pre style={{ color: "#94a3b8", fontSize: 12 }}>{this.state.err?.stack}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

function Root() {
  // Public (production) build opens on devnet against the deployed programs;
  // `npm run dev` stays on localnet for local validator work.
  const [cluster, setCluster] = useState<ClusterKey>(import.meta.env.PROD ? "devnet" : "local");
  const endpoint = CLUSTERS[cluster].rpc;
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);
  return (
    <ConnectionProvider endpoint={endpoint} key={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <App cluster={cluster} setCluster={setCluster} />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </React.StrictMode>,
);
