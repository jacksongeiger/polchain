import { useState, useRef, useEffect } from "react";
import { connectWallet, shortAddress } from "./wallet";
// import Dashboard from "./views/Dashboard";
// import SubmitGradient from "./views/SubmitGradient";
// import Leaderboard from "./views/Leaderboard";
import Chain from "./views/Chain";
import Miners from "./views/Miners";
import TaskHistory from "./views/TaskHistory";
import Model from "./views/Model";
import Admin from "./views/Admin";

// Nav structure — dropdowns have a `children` array
const NAV = [
  // { label: "Dashboard", children: ["Dashboard", "Leaderboard"] },
  // { label: "Submit" },
  { label: "Chain", children: ["Chain", "Miners"] },
  { label: "Model" },
  { label: "Admin", children: ["Admin", "History"] },
];

// Which top-level label is "active" given the current view
function activeGroup(view) {
  for (const item of NAV) {
    if (item.children) {
      if (item.children.includes(view)) return item.label;
    } else {
      if (item.label === view) return item.label;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// NavItem — standalone button or hover dropdown
// ---------------------------------------------------------------------------
function NavItem({ item, view, setView }) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef(null);
  const isGroupActive = activeGroup(view) === item.label;

  // Clear any pending close when entering the wrapper or dropdown
  function handleEnter() {
    clearTimeout(closeTimer.current);
    setOpen(true);
  }

  // Delay close by 200ms so the cursor can travel across the 2px gap
  // between the trigger button and the dropdown without it vanishing.
  function handleLeave() {
    closeTimer.current = setTimeout(() => setOpen(false), 200);
  }

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  if (!item.children) {
    return (
      <button
        style={S.navBtn(view === item.label)}
        onClick={() => setView(item.label)}
      >
        {item.label}
      </button>
    );
  }

  return (
    <div
      style={{ position: "relative" }}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <button style={{ ...S.navBtn(isGroupActive), display: "flex", alignItems: "center", gap: 4 }}>
        {item.label}
        <span style={{ fontSize: 8, opacity: 0.6, marginTop: 1 }}>▾</span>
      </button>

      {open && (
        <div style={S.dropdown}>
          {item.children.map((child) => (
            <button
              key={child}
              style={S.dropdownItem(view === child)}
              onClick={() => { setView(child); setOpen(false); }}
            >
              {child}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

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
    padding: "6px 14px", borderRadius: 4, transition: "all 0.15s", cursor: "pointer",
  }),
  dropdown: {
    position: "absolute", top: "calc(100% - 1px)", left: 0, zIndex: 100,
    background: "#0e0e1a", border: "1px solid #1e1e30", borderRadius: 4,
    minWidth: "100%", overflow: "hidden",
    boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
  },
  dropdownItem: (active) => ({
    display: "block", width: "100%", textAlign: "left",
    padding: "8px 14px", border: "none", cursor: "pointer",
    background: active ? "#1a1e3a" : "transparent",
    color: active ? "#a0b0ff" : "#888",
    fontSize: 13, transition: "all 0.1s",
    borderBottom: "1px solid #111120",
  }),
  connectBtn: {
    background: "#1a2a4a", color: "#6b8fff", border: "1px solid #2a3a6a",
    padding: "6px 14px", borderRadius: 4, cursor: "pointer",
  },
  address: {
    background: "#111820", color: "#3ddc84", border: "1px solid #1a3a2a",
    padding: "6px 14px", borderRadius: 4, fontSize: 12,
  },
  err: { color: "#ff6b6b", fontSize: 12, marginTop: 8 },
};

export default function App() {
  const [view, setView] = useState("Chain");
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
          {NAV.map((item) => (
            <NavItem key={item.label} item={item} view={view} setView={setView} />
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

      {/* {view === "Dashboard"  && <Dashboard  {...viewProps} />} */}
      {/* {view === "Submit"     && <SubmitGradient {...viewProps} />} */}
      {/* {view === "Leaderboard"&& <Leaderboard {...viewProps} />} */}
      {view === "Chain"      && <Chain      {...viewProps} />}
      {view === "Miners"     && <Miners     {...viewProps} />}
      {view === "Model"      && <Model      {...viewProps} />}
      {view === "History"    && <TaskHistory {...viewProps} />}
      {view === "Admin"      && <Admin      {...viewProps} />}
    </div>
  );
}
