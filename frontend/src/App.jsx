import { useState, useRef, useEffect, useCallback } from "react";
import { connectWallet, shortAddress } from "./wallet";
import Chain from "./views/Chain";
import Miners from "./views/Miners";
import TaskHistory from "./views/TaskHistory";
import Model from "./views/Model";
import Admin from "./views/Admin";
import { ADMIN_API } from "./config";

// Nav structure — dropdowns have a `children` array
const NAV = [
  { label: "Chain", children: ["Chain", "Miners"] },
  { label: "Model" },
  { label: "Admin", children: ["Admin", "History"] },
];

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

  function handleEnter() {
    clearTimeout(closeTimer.current);
    setOpen(true);
  }
  function handleLeave() {
    closeTimer.current = setTimeout(() => setOpen(false), 220);
  }

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  if (!item.children) {
    return (
      <button
        style={S.navBtn(view === item.label)}
        onClick={() => setView(item.label)}
      >
        <span style={S.navLabel}>{item.label}</span>
        {view === item.label && <span style={S.navUnderline} />}
      </button>
    );
  }

  return (
    <div
      style={{ position: "relative" }}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <button style={S.navBtn(isGroupActive)}>
        <span style={S.navLabel}>{item.label}</span>
        <span style={S.navCaret}>▾</span>
        {isGroupActive && <span style={S.navUnderline} />}
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

// ---------------------------------------------------------------------------
// ModeToggle — Basic / Advanced segmented control
// ---------------------------------------------------------------------------
function ModeToggle() {
  const [mode,      setMode]      = useState("advanced");
  const [switching, setSwitching] = useState(false);
  const [stepMsg,   setStepMsg]   = useState("");

  useEffect(() => {
    fetch(`${ADMIN_API}/api/mode`)
      .then((r) => r.json())
      .then((d) => { if (d.mode) setMode(d.mode); })
      .catch(() => {});
  }, []);

  const handleSwitch = useCallback(async (newMode) => {
    if (newMode === mode || switching) return;
    setSwitching(true);
    setStepMsg("Switching…");
    const prevMode = mode;
    setMode(newMode);

    try {
      const response = await fetch(`${ADMIN_API}/api/mode`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ mode: newMode }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("text/event-stream")) {
        const reader  = response.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let errored = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop();
          for (const part of parts) {
            for (const raw of part.split("\n")) {
              if (!raw.startsWith("data: ")) continue;
              try {
                const { step, message } = JSON.parse(raw.slice(6));
                setStepMsg(message);
                if (step === "error") { errored = true; setMode(prevMode); }
                if (step === "done") {
                  setStepMsg("Reloading…");
                  setTimeout(() => window.location.reload(), 500);
                  return;
                }
              } catch { /* ignore */ }
            }
          }
        }
        if (errored) setMode(prevMode);
      } else {
        const d = await response.json();
        if (!d.ok) setMode(prevMode);
      }
    } catch {
      setMode(prevMode);
      setStepMsg("");
    }
    setSwitching(false);
    setStepMsg("");
  }, [mode, switching]);

  return (
    <div style={SM.wrap}>
      {switching && stepMsg && (
        <span style={SM.stepMsg}>{stepMsg}</span>
      )}
      <div style={SM.pills}>
        {["basic", "advanced"].map((m) => (
          <button
            key={m}
            style={{
              ...SM.pill,
              color:      mode === m ? "var(--text-primary)" : "var(--text-tertiary)",
              background: mode === m ? "var(--bg-overlay)"   : "transparent",
              borderRight: m === "basic" ? "1px solid var(--border)" : "none",
            }}
            onClick={() => handleSwitch(m)}
            disabled={switching}
          >
            {switching && mode === m ? "…" : m === "basic" ? "BASIC" : "ADVANCED"}
            {mode === m && <span style={SM.pillDot} />}
          </button>
        ))}
      </div>
    </div>
  );
}

const SM = {
  wrap:    { display: "flex", alignItems: "center", gap: 10 },
  stepMsg: {
    fontSize: 10, color: "var(--text-tertiary)", fontFamily: "var(--font-mono)",
    maxWidth: 130, textAlign: "right", lineHeight: 1.4, letterSpacing: "0.02em",
  },
  pills: {
    display: "flex",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    overflow: "hidden",
    flexShrink: 0,
    background: "var(--bg-elevated)",
  },
  pill: {
    position: "relative",
    padding: "6px 14px",
    border: "none",
    fontSize: 10,
    letterSpacing: "0.14em",
    fontWeight: 600,
    cursor: "pointer",
    transition: "all 200ms var(--ease-out)",
    fontFamily: "var(--font-mono)",
    whiteSpace: "nowrap",
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  pillDot: {
    width: 5, height: 5, borderRadius: "50%",
    background: "var(--accent)",
    boxShadow: "0 0 8px var(--accent)",
  },
};

// ---------------------------------------------------------------------------
// Wordmark
// ---------------------------------------------------------------------------
function Wordmark() {
  return (
    <div style={S.brand}>
      <div style={S.brandRow}>
        <span style={S.brandPol}>POL</span>
        <span style={S.brandSlash}>//</span>
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

  // ── Header ─────────────────────────────────────────────────────────────
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

  // ── Wordmark ────────────────────────────────────────────────────────────
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
  brandSlash:  {
    color: "var(--accent)",
    margin: "0 4px",
    textShadow: "0 0 18px var(--accent-glow-md)",
    fontFamily: "var(--font-mono)",
    fontWeight: 700,
    fontSize: 20,
  },
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

  // ── Nav ────────────────────────────────────────────────────────────────
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
  navLabel: { display: "inline-block" },
  navCaret: { fontSize: 8, opacity: 0.7, marginTop: 1 },
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

  dropdown: {
    position: "absolute",
    top: "calc(100% + 6px)",
    left: 0,
    zIndex: 100,
    background: "var(--bg-elevated)",
    border: "1px solid var(--border-strong)",
    borderRadius: "var(--radius-md)",
    minWidth: 140,
    overflow: "hidden",
    boxShadow: "var(--shadow-deep)",
    padding: 4,
  },
  dropdownItem: (active) => ({
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "9px 14px",
    border: "none",
    cursor: "pointer",
    background: active ? "var(--bg-overlay)" : "transparent",
    color:      active ? "var(--text-primary)" : "var(--text-secondary)",
    fontSize: 12,
    fontFamily: "var(--font-sans)",
    fontWeight: 500,
    borderRadius: "var(--radius-sm)",
    transition: "all 160ms var(--ease-out)",
  }),

  // ── Wallet button ──────────────────────────────────────────────────────
  rightSide: { display: "flex", alignItems: "center", gap: 12, flexShrink: 0 },
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
    border: "1px solid var(--border)",
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
    background: "var(--success)",
    boxShadow: "0 0 8px var(--success-glow)",
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
  const [view, setView] = useState("Chain");
  const [wallet, setWallet] = useState(null);
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
        <Wordmark />

        <nav style={S.nav}>
          {NAV.map((item) => (
            <NavItem key={item.label} item={item} view={view} setView={setView} />
          ))}
        </nav>

        <div style={S.rightSide}>
          <ModeToggle />
          {wallet ? (
            <div style={S.address}>
              <span style={S.addressType}>
                {wallet.walletType === "metamask" ? "META" : "CB"}
              </span>
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

      {view === "Chain"      && <Chain      {...viewProps} />}
      {view === "Miners"     && <Miners     {...viewProps} />}
      {view === "Model"      && <Model      {...viewProps} />}
      {view === "History"    && <TaskHistory {...viewProps} />}
      {view === "Admin"      && <Admin      {...viewProps} />}
    </div>
  );
}
