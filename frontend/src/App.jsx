import { useState } from "react";
import { connectWallet, shortAddress } from "./wallet";
import Dashboard from "./views/Dashboard";
import SubmitGradient from "./views/SubmitGradient";
import Leaderboard from "./views/Leaderboard";
import TaskHistory from "./views/TaskHistory";

const VIEWS = ["Dashboard", "Submit", "Leaderboard", "History"];

const S = {
  app: { maxWidth: 860, margin: "0 auto", padding: "0 16px 48px" },
  header: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    borderBottom: "1px solid #1e1e2e", padding: "16px 0", marginBottom: 24,
  },
  logo: { fontSize: 18, fontWeight: "bold", color: "#a0b0ff", letterSpacing: 2 },
  sub: { fontSize: 11, color: "#555", marginTop: 2 },
  nav: { display: "flex", gap: 4, margin: "0 auto" },
  navBtn: (active) => ({
    background: active ? "#1a1e3a" : "transparent",
    color: active ? "#a0b0ff" : "#666",
    border: active ? "1px solid #2e3666" : "1px solid transparent",
    padding: "6px 14px", borderRadius: 4, transition: "all 0.15s",
  }),
  connectBtn: {
    background: "#1a2a4a", color: "#6b8fff", border: "1px solid #2a3a6a",
    padding: "6px 14px", borderRadius: 4,
  },
  address: {
    background: "#111820", color: "#3ddc84", border: "1px solid #1a3a2a",
    padding: "6px 14px", borderRadius: 4, fontSize: 12,
  },
  err: { color: "#ff6b6b", fontSize: 12, marginTop: 8 },
};

export default function App() {
  const [view, setView] = useState("Dashboard");
  const [wallet, setWallet] = useState(null); // { signer, address, ethersProvider }
  const [connecting, setConnecting] = useState(false);
  const [connErr, setConnErr] = useState("");

  async function handleConnect() {
    setConnecting(true);
    setConnErr("");
    try {
      const w = await connectWallet();
      setWallet(w);
    } catch (e) {
      setConnErr(e.message);
    } finally {
      setConnecting(false);
    }
  }

  const viewProps = { wallet };

  return (
    <div style={S.app}>
      <header style={S.header}>
        <div>
          <div style={S.logo}>POL CHAIN</div>
          <div style={S.sub}>Securing AI with Proof of Learning · Base Sepolia</div>
        </div>

        <nav style={S.nav}>
          {VIEWS.map((v) => (
            <button key={v} style={S.navBtn(view === v)} onClick={() => setView(v)}>
              {v}
            </button>
          ))}
        </nav>

        {wallet ? (
          <div style={S.address}>
            <span style={{ color: "#555", fontSize: 10, marginRight: 6 }}>
              {wallet.walletType === "metamask" ? "MetaMask" : "Coinbase"}
            </span>
            {shortAddress(wallet.address)}
          </div>
        ) : (
          <button style={S.connectBtn} onClick={handleConnect} disabled={connecting}>
            {connecting ? "Connecting…" : "Connect Wallet"}
          </button>
        )}
      </header>

      {connErr && <div style={S.err}>{connErr}</div>}

      {view === "Dashboard"  && <Dashboard  {...viewProps} />}
      {view === "Submit"     && <SubmitGradient {...viewProps} />}
      {view === "Leaderboard"&& <Leaderboard {...viewProps} />}
      {view === "History"    && <TaskHistory {...viewProps} />}
    </div>
  );
}
