import { useEffect, useRef, useState } from "react";

const API = "http://localhost:3001";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SERVICES = [
  { key: "loop",     label: "Mining Loop",  sub: "miningLoop.js"     },
  { key: "miner",    label: "Auto Miner",   sub: "autoMiner.js"      },
  { key: "flask",    label: "Prove Server", sub: "Flask · port 5001" },
  { key: "frontend", label: "Frontend",     sub: "Vite · port 5173", alwaysOn: true },
];

const ACTIONS = [
  { key: "post-task",    label: "Post New Task",        sub: "Posts a new 30s task immediately"           },
  { key: "finalize",     label: "Finalize Current Task", sub: "Finalizes any expired tasks"               },
  { key: "redeploy",     label: "Redeploy TaskManager",  sub: "Deploys fresh contract (~30s)"             },
  { key: "reset-model",  label: "Reset Model",           sub: "Resets MNIST model to random weights for a fresh demo", destructive: true },
];

// ---------------------------------------------------------------------------
// Log line colorizer — matches server broadcast labels
// ---------------------------------------------------------------------------
function parseLine(text) {
  if (/\[loop\]/.test(text))            return { color: "#6b8fff", dim: false };
  if (/\[miner\]/.test(text))           return { color: "#3ddc84", dim: false };
  if (/\[action\]/.test(text))          return { color: "#f0c040", dim: false };
  if (/\[server\]/.test(text))          return { color: "#a0b0ff", dim: false };
  if (/:err\]|error|Error/i.test(text)) return { color: "#ff6b6b", dim: false };
  return { color: "#484860", dim: true };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------
function StatusDot({ on }) {
  return (
    <div style={{
      width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
      background:  on ? "#3ddc84" : "#3a1a1a",
      boxShadow:   on ? "0 0 6px #3ddc8488" : "none",
      border:      on ? "none" : "1px solid #2a1a1a",
      transition:  "all 0.4s",
    }} />
  );
}

function ServiceRow({ service, on, onToggle, toggling }) {
  return (
    <div style={S.serviceRow}>
      <StatusDot on={on} />
      <div style={{ flex: 1 }}>
        <div style={{ ...S.serviceLabel, color: on ? "#c0c0d8" : "#555" }}>{service.label}</div>
        <div style={S.serviceSub}>{service.sub}</div>
      </div>
      {onToggle ? (
        <button
          style={{
            ...S.actionBtn,
            padding: "4px 10px", fontSize: 10,
            background:  on ? "#1a0808" : "#0a1a0a",
            borderColor: on ? "#4a1a1a" : "#1a4a1a",
            color:       on ? "#ff6b6b" : "#3ddc84",
            opacity:     toggling ? 0.5 : 1,
            cursor:      toggling ? "not-allowed" : "pointer",
          }}
          onClick={onToggle}
          disabled={toggling}
        >
          {toggling ? "…" : on ? "Stop" : "Start"}
        </button>
      ) : (
        <div style={{ ...S.servicePill, color: on ? "#3ddc84" : "#444", borderColor: on ? "#1a4a2a" : "#222" }}>
          {on ? "RUNNING" : "STOPPED"}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Admin component
// ---------------------------------------------------------------------------
export default function Admin() {
  const [status,        setStatus]        = useState(null);
  const [mining,        setMining]        = useState(false);
  const [toggling,      setToggling]      = useState(false);
  const [flaskToggling, setFlaskToggling] = useState(false);
  const [logs,          setLogs]          = useState([]);    // string[]
  const [actState,      setActState]      = useState({});    // { [key]: "idle"|"loading"|"ok"|"err" }
  const [serverUp,      setServerUp]      = useState(null);  // null=unknown, true, false

  const logBoxRef = useRef(null);
  const esRef     = useRef(null);

  // ── Status polling (3s) ───────────────────────────────────────────────────
  useEffect(() => {
    async function poll() {
      try {
        const r = await fetch(`${API}/api/status`, { signal: AbortSignal.timeout(2000) });
        const s = await r.json();
        setStatus(s);
        setMining(s.loop || s.miner);
        setServerUp(true);
      } catch {
        setServerUp(false);
        setStatus(null);
      }
    }
    poll();
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, []);

  // ── SSE log stream ────────────────────────────────────────────────────────
  useEffect(() => {
    function connect() {
      const es = new EventSource(`${API}/api/logs`);
      esRef.current = es;
      es.onmessage = (e) => {
        try {
          const { line } = JSON.parse(e.data);
          setLogs((prev) => {
            const next = [...prev, line];
            return next.length > 200 ? next.slice(-200) : next;
          });
        } catch { /* malformed event */ }
      };
      es.onerror = () => {
        es.close();
        // Reconnect after 3s if server was up
        setTimeout(connect, 3000);
      };
    }
    connect();
    return () => esRef.current?.close();
  }, []);

  // ── Auto-scroll log ───────────────────────────────────────────────────────
  useEffect(() => {
    const el = logBoxRef.current;
    if (!el) return;
    // Only auto-scroll if already near the bottom
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [logs]);

  // ── Toggle Flask prove server ─────────────────────────────────────────────
  async function toggleFlask() {
    setFlaskToggling(true);
    try {
      const on = status?.flask ?? false;
      const ep = on ? "/api/prove-server/stop" : "/api/prove-server/start";
      await fetch(`${API}${ep}`, { method: "POST" });
    } catch { /* server down */ }
    setFlaskToggling(false);
  }

  // ── Toggle mining ─────────────────────────────────────────────────────────
  async function toggleMining() {
    setToggling(true);
    try {
      const ep = mining ? "/api/mining/stop" : "/api/mining/start";
      await fetch(`${API}${ep}`, { method: "POST" });
      setMining((m) => !m);
    } catch { /* server down */ }
    setToggling(false);
  }

  // ── Quick action ──────────────────────────────────────────────────────────
  async function runAction(key) {
    setActState((s) => ({ ...s, [key]: "loading" }));
    try {
      const r = await fetch(`${API}/api/actions/${key}`, { method: "POST" });
      const d = await r.json();
      setActState((s) => ({ ...s, [key]: d.ok ? "ok" : "err" }));
    } catch {
      setActState((s) => ({ ...s, [key]: "err" }));
    }
    setTimeout(() => setActState((s) => ({ ...s, [key]: "idle" })), 4000);
  }

  // ── Derived state ─────────────────────────────────────────────────────────
  const statusMap = {
    loop:     status?.loop     ?? false,
    miner:    status?.miner    ?? false,
    flask:    status?.flask    ?? false,
    frontend: true,
  };

  // Last 20 visible log lines
  const visibleLogs = logs.slice(-20);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div>
      <h2 style={S.heading}>Admin</h2>

      {serverUp === false && (
        <div style={S.serverWarn}>
          ⚠ Admin server not reachable on port 3001 — run: <code style={S.code}>npm run server</code>
        </div>
      )}

      <div style={S.layout}>
        {/* ── Left column ──────────────────────────────────────── */}
        <div style={S.leftCol}>

          {/* Mining Control */}
          <div style={S.card}>
            <div style={S.cardTitle}>Mining Control</div>

            <div style={S.miningStatus}>
              <StatusDot on={mining} />
              <span style={{ color: mining ? "#3ddc84" : "#555", fontSize: 12 }}>
                {mining ? "Mining active" : "Mining stopped"}
              </span>
            </div>

            <button
              style={{
                ...S.toggleBtn,
                background:   mining ? "#1a0808" : "#0a1a0a",
                borderColor:  mining ? "#4a1a1a" : "#1a4a1a",
                color:        mining ? "#ff6b6b" : "#3ddc84",
                opacity:      (toggling || serverUp === false) ? 0.5 : 1,
                cursor:       (toggling || serverUp === false) ? "not-allowed" : "pointer",
              }}
              onClick={toggleMining}
              disabled={toggling || serverUp === false}
            >
              {toggling ? "…" : mining ? "⏹  Stop Mining" : "▶  Start Mining"}
            </button>

            <div style={S.toggleNote}>
              Starts <code style={S.code}>miningLoop.js</code> + <code style={S.code}>autoMiner.js</code>
            </div>
          </div>

          {/* Server Status */}
          <div style={S.card}>
            <div style={S.cardTitle}>Server Status</div>
            {SERVICES.map((svc) => (
              <ServiceRow
                key={svc.key}
                service={svc}
                on={statusMap[svc.key]}
                onToggle={svc.key === "flask" ? toggleFlask : undefined}
                toggling={svc.key === "flask" ? flaskToggling : false}
              />
            ))}
          </div>

          {/* Quick Actions */}
          <div style={S.card}>
            <div style={S.cardTitle}>Quick Actions</div>
            {ACTIONS.map((act) => {
              const state = actState[act.key] ?? "idle";
              const idleColor  = act.destructive ? "#ff6b6b" : "#a0b0ff";
              const idleBorder = act.destructive ? "#4a1a1a" : "#2e3666";
              const idleBg     = act.destructive ? "#1a0808" : "#1a1e3a";
              return (
                <div key={act.key} style={S.actionRow}>
                  <div style={{ flex: 1 }}>
                    <div style={S.actionLabel}>{act.label}</div>
                    <div style={S.actionSub}>{act.sub}</div>
                  </div>
                  <button
                    style={{
                      ...S.actionBtn,
                      background:  state === "idle" ? idleBg : "#1a1e3a",
                      opacity:     (state === "loading" || serverUp === false) ? 0.5 : 1,
                      cursor:      (state === "loading" || serverUp === false) ? "not-allowed" : "pointer",
                      color:       state === "ok" ? "#3ddc84" : state === "err" ? "#ff6b6b" : idleColor,
                      borderColor: state === "ok" ? "#1a4a2a" : state === "err" ? "#4a1a1a" : idleBorder,
                    }}
                    onClick={() => runAction(act.key)}
                    disabled={state === "loading" || serverUp === false}
                  >
                    {state === "loading" ? "Running…"
                      : state === "ok"  ? "Done ✓"
                      : state === "err" ? "Error ✗"
                      : "Run"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Right column — live log feed ──────────────────────── */}
        <div style={S.rightCol}>
          <div style={S.card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div style={S.cardTitle}>Live Log</div>
              <div style={S.logLegend}>
                {[["#6b8fff","loop"],["#3ddc84","miner"],["#f0c040","action"],["#ff6b6b","error"]].map(([c,l])=>(
                  <span key={l} style={{ color: c, fontSize: 9, letterSpacing: 0.5 }}>{l}</span>
                ))}
              </div>
            </div>

            <div ref={logBoxRef} style={S.logBox}>
              {logs.length === 0 ? (
                <div style={{ color: "#333", fontStyle: "italic", fontSize: 10 }}>
                  Waiting for log output…
                </div>
              ) : (
                visibleLogs.map((line, i) => {
                  const { color } = parseLine(line);
                  return (
                    <div key={i} style={{ ...S.logLine, color }}>
                      {line}
                    </div>
                  );
                })
              )}
            </div>

            <div style={S.logFooter}>
              {logs.length} lines received · showing last 20
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const S = {
  heading: { color: "#a0b0ff", marginBottom: 20, fontSize: 16, letterSpacing: 1 },

  serverWarn: {
    background: "#1a0e08", border: "1px solid #4a2a10", borderRadius: 6,
    padding: "10px 16px", color: "#f0a040", fontSize: 12, marginBottom: 20,
  },

  layout:   { display: "flex", gap: 16, alignItems: "flex-start" },
  leftCol:  { display: "flex", flexDirection: "column", gap: 16, width: 280, flexShrink: 0 },
  rightCol: { flex: 1 },

  card: {
    background: "#0e0e1a", border: "1px solid #1e1e30", borderRadius: 6,
    padding: "18px 20px",
  },
  cardTitle: {
    fontSize: 11, color: "#555", letterSpacing: 1.5, textTransform: "uppercase",
    marginBottom: 14, fontFamily: "monospace",
  },

  // Mining control
  miningStatus: { display: "flex", alignItems: "center", gap: 8, marginBottom: 14 },
  toggleBtn: {
    width: "100%", padding: "10px 0", borderRadius: 5, border: "1px solid",
    fontSize: 13, fontWeight: "bold", letterSpacing: 0.5, transition: "all 0.2s",
    marginBottom: 10,
  },
  toggleNote: { fontSize: 10, color: "#333", lineHeight: 1.6 },
  code: { fontFamily: "monospace", color: "#666", fontSize: 10 },

  // Service rows
  serviceRow: {
    display: "flex", alignItems: "center", gap: 10,
    paddingBottom: 10, marginBottom: 10,
    borderBottom: "1px solid #0e0e18",
  },
  serviceLabel: { fontSize: 12, fontWeight: "bold" },
  serviceSub:   { fontSize: 9,  color: "#444", marginTop: 1, fontFamily: "monospace" },
  servicePill: {
    marginLeft: "auto", fontSize: 8, border: "1px solid", borderRadius: 3,
    padding: "1px 6px", letterSpacing: 0.8, fontFamily: "monospace",
  },

  // Quick actions
  actionRow: {
    display: "flex", alignItems: "center", gap: 12,
    paddingBottom: 12, marginBottom: 12,
    borderBottom: "1px solid #0e0e18",
  },
  actionLabel: { fontSize: 12, color: "#c0c0d0", fontWeight: "bold", marginBottom: 2 },
  actionSub:   { fontSize: 9, color: "#444", fontFamily: "monospace" },
  actionBtn: {
    background: "#1a1e3a", border: "1px solid #2e3666",
    padding: "6px 12px", borderRadius: 4, fontSize: 11,
    whiteSpace: "nowrap", transition: "all 0.2s",
  },

  // Log feed
  logLegend: { display: "flex", gap: 10 },
  logBox: {
    background: "#06060e", border: "1px solid #111120", borderRadius: 4,
    padding: "12px 14px", height: 420, overflowY: "auto",
    fontFamily: "'Courier New', Courier, monospace",
    scrollbarWidth: "thin", scrollbarColor: "#1e1e30 transparent",
  },
  logLine:   { fontSize: 10, lineHeight: 1.65, wordBreak: "break-all" },
  logFooter: { fontSize: 9, color: "#333", marginTop: 8, textAlign: "right", fontFamily: "monospace" },
};
