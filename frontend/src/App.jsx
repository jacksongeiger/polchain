import { useState, useEffect } from "react";
import { connectWallet, shortAddress } from "./wallet";
import Chain from "./views/Chain";
import Mine from "./views/Mine";
import Model from "./views/Model";
import Science from "./views/Science";
import Admin from "./views/Admin";
import { ADMIN_API } from "./config";

// Era 2 information architecture: four views, one thesis. Admin is an
// operator tool, reachable only via ?admin=1 — it is not part of the story.
const NAV = ["Chain", "Mine", "Model", "Science"];

// ---------------------------------------------------------------------------
// EraBadge — replaces the retired Basic/Advanced ModeToggle. Eras are contract
// generations; the badge reads the registry so it can never lie about which
// contract the UI is mining against.
// ---------------------------------------------------------------------------
function EraBadge() {
  const [era, setEra] = useState(null);

  useEffect(() => {
    fetch(`${ADMIN_API}/api/addresses`)
      .then((r) => r.json())
      .then((d) => {
        const eras = d.eras || [];
        const current = eras.find((e) => !e.sealed) || eras[eras.length - 1];
        if (current) setEra(current);
      })
      .catch(() => {});
  }, []);

  if (!era) return null;
  return (
    <div style={S.eraBadge} title={era.label}>
      <span style={S.eraDot} />
      ERA {era.era} · LIVE
    </div>
  );
}

function Wordmark() {
  return (
    <div style={S.brand}>
      <div style={S.brandRow}>
        <span style={S.brandPol}>POL</span>
        <span style={S.brandSpace} />
        <span style={S.brandChain}>CHAIN</span>
      </div>
      <div style={S.brandSub}>
        <span style={S.brandSubDot} />
        Proof of Learning Protocol · Base Sepolia
      </div>
    </div>
  );
}

const S = {
  app: {
    maxWidth: 1180,
    margin: "0 auto",
    padding: "0 28px 80px",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 32,
    borderBottom: "1px solid var(--border)",
    padding: "24px 0 22px",
    marginBottom: 32,
    position: "relative",
  },
  brand: { display: "flex", flexDirection: "column", gap: 4, flexShrink: 0 },
  brandRow: {
    display: "flex",
    alignItems: "baseline",
    gap: 0,
    fontFamily: "var(--font-sans)",
    fontWeight: 800,
    fontSize: 22,
    letterSpacing: "-0.02em",
    lineHeight: 1,
  },
  brandPol:    { color: "var(--text-primary)" },
  brandSpace:  { display: "inline-block", width: 10 },
  brandChain:  { color: "var(--text-primary)" },
  brandSub: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontFamily: "var(--font-mono)",
    fontSize: 9.5,
    letterSpacing: "0.14em",
    color: "var(--text-tertiary)",
    textTransform: "uppercase",
    marginTop: 6,
  },
  brandSubDot: {
    display: "inline-block",
    width: 6, height: 6, borderRadius: "50%",
    background: "var(--accent)",
    boxShadow: "0 0 10px var(--accent)",
    animation: "pulse-glow 2.4s ease-in-out infinite",
  },
  nav: {
    display: "flex",
    gap: 2,
    margin: "0 auto",
    padding: "4px",
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
  },
  navBtn: (active) => ({
    position: "relative",
    background: active ? "var(--bg-overlay)" : "transparent",
    color:      active ? "var(--text-primary)" : "var(--text-tertiary)",
    border: "none",
    padding: "9px 18px",
    borderRadius: "var(--radius-sm)",
    transition: "all 220ms var(--ease-out)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontFamily: "var(--font-sans)",
    fontWeight: 500,
    fontSize: 12,
    letterSpacing: "0.04em",
  }),
  navUnderline: {
    position: "absolute",
    bottom: 4,
    left: "50%",
    transform: "translateX(-50%)",
    width: 16,
    height: 1.5,
    background: "var(--accent)",
    boxShadow: "0 0 10px var(--accent)",
    borderRadius: 1,
  },
  rightSide: { display: "flex", alignItems: "center", gap: 12, flexShrink: 0 },
  eraBadge: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "7px 12px",
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    letterSpacing: "0.14em",
    fontWeight: 600,
    color: "var(--text-secondary)",
    whiteSpace: "nowrap",
  },
  eraDot: {
    width: 6, height: 6, borderRadius: "50%",
    background: "var(--success)",
    boxShadow: "0 0 8px var(--success-glow)",
    animation: "pulse-glow 2.4s ease-in-out infinite",
  },
  connectBtn: {
    background: "var(--accent)",
    color: "var(--bg-base)",
    border: "1px solid var(--accent)",
    padding: "9px 18px",
    borderRadius: "var(--radius-sm)",
    cursor: "pointer",
    fontFamily: "var(--font-sans)",
    fontWeight: 600,
    fontSize: 11,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    transition: "all 200ms var(--ease-out)",
    boxShadow: "0 0 24px var(--accent-glow-md)",
  },
  address: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    background: "var(--bg-elevated)",
    border: "1px solid var(--miner-you)",
    padding: "8px 14px",
    borderRadius: "var(--radius-sm)",
    fontSize: 12,
    fontFamily: "var(--font-mono)",
    color: "var(--text-primary)",
  },
  addressType: {
    color: "var(--text-tertiary)",
    fontSize: 9,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    paddingRight: 8,
    marginRight: 2,
    borderRight: "1px solid var(--border)",
  },
  addressDot: {
    width: 6, height: 6, borderRadius: "50%",
    background: "var(--miner-you)",
    boxShadow: "0 0 8px var(--miner-you)",
  },
  err: {
    color: "var(--danger)",
    fontSize: 12,
    marginTop: 12,
    padding: "10px 14px",
    background: "rgba(255, 77, 109, 0.06)",
    border: "1px solid rgba(255, 77, 109, 0.2)",
    borderRadius: "var(--radius-sm)",
    fontFamily: "var(--font-mono)",
  },
};

export default function App() {
  const isAdmin = new URLSearchParams(window.location.search).get("admin") === "1";
  const [view, setView] = useState(isAdmin ? "Admin" : "Chain");
  const [wallet, setWallet] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [connErr, setConnErr] = useState("");

  async function handleConnect() {
    setConnecting(true);
    setConnErr("");
    try {
      const w = await connectWallet();
      setWallet(w);
      return w;
    } catch (e) {
      setConnErr(e.message);
      return null;
    } finally {
      setConnecting(false);
    }
  }

  const viewProps = { wallet, onConnect: handleConnect, connecting };

  return (
    <div style={S.app}>
      <header style={S.header}>
        <Wordmark />

        <nav style={S.nav}>
          {NAV.map((label) => (
            <button key={label} style={S.navBtn(view === label)} onClick={() => setView(label)}>
              <span>{label}</span>
              {view === label && <span style={S.navUnderline} />}
            </button>
          ))}
        </nav>

        <div style={S.rightSide}>
          <EraBadge />
          {wallet ? (
            <div style={S.address}>
              <span style={S.addressType}>MINER</span>
              <span style={S.addressDot} />
              {shortAddress(wallet.address)}
            </div>
          ) : (
            <button style={S.connectBtn} onClick={handleConnect} disabled={connecting}>
              {connecting ? "Connecting…" : "Connect Wallet"}
            </button>
          )}
        </div>
      </header>

      {connErr && <div style={S.err}>{connErr}</div>}

      {view === "Chain"   && <Chain   {...viewProps} />}
      {view === "Mine"    && <Mine    {...viewProps} />}
      {view === "Model"   && <Model   {...viewProps} />}
      {view === "Science" && <Science {...viewProps} />}
      {view === "Admin"   && isAdmin && <Admin {...viewProps} />}
    </div>
  );
}
