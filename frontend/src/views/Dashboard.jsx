import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { ADDRESSES, TASK_MANAGER_ABI } from "../contracts";
import { getReadProvider, formatPOL, formatDeadline, timeLeft } from "../wallet";

function getManager(provider) {
  return new ethers.Contract(ADDRESSES.TaskManager, TASK_MANAGER_ABI, provider);
}

// ---------------------------------------------------------------------------
// Stage display config — shared by MinerCard
// ---------------------------------------------------------------------------
const STAGE_INFO = {
  waiting:  { label: "Waiting",          color: "#444"    },
  loading:  { label: "Loading Data",     color: "#888"    },
  training: { label: "Training",         color: "#b07fff" },
  proving:  { label: "Generating Proof", color: "#6b8fff" },
  verifying:{ label: "Verifying",        color: "#f0c040" },
  done:     { label: "Complete",         color: "#3ddc84" },
  error:    { label: "Error",            color: "#ff6b6b" },
};

const STAGE_ORDER = ["loading", "training", "proving", "verifying", "done"];

// ---------------------------------------------------------------------------
// Block card (existing task display)
// ---------------------------------------------------------------------------
function TaskCard({ task }) {
  const expired = Date.now() > Number(task.deadline) * 1000;
  return (
    <div style={S.card}>
      <div style={S.cardHeader}>
        <span style={S.taskId}>BLOCK #{task.id.toString()}</span>
        <span style={expired ? S.badgeExpired : S.badge}>
          {expired ? "EXPIRED" : timeLeft(task.deadline)}
        </span>
      </div>
      <p style={S.desc}>{task.description}</p>
      <div style={S.meta}>
        <div style={S.metaItem}>
          <span style={S.metaLabel}>Min Score</span>
          <span style={S.metaVal}>{task.threshold.toString()} / 100</span>
        </div>
        <div style={S.metaItem}>
          <span style={S.metaLabel}>Block Reward</span>
          <span style={{ ...S.metaVal, color: "#3ddc84" }}>{formatPOL(task.reward)} POL</span>
        </div>
        <div style={S.metaItem}>
          <span style={S.metaLabel}>Deadline</span>
          <span style={S.metaVal}>{formatDeadline(task.deadline)}</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Miner card — live status during simulation
// ---------------------------------------------------------------------------
function MinerCard({ miner, isWinner }) {
  const info   = STAGE_INFO[miner.stage] || { label: miner.stage, color: "#888" };
  const active = miner.stage !== "waiting" && miner.stage !== "done" && miner.stage !== "error";
  const stageIdx = STAGE_ORDER.indexOf(miner.stage);

  return (
    <div style={{
      ...S.minerCard,
      border:     isWinner ? "1px solid #8a6a00"  : miner.stage === "done" ? "1px solid #1a3a2a" : "1px solid #1e1e30",
      background: isWinner ? "#14100a"             : miner.stage === "done" ? "#0a120a"           : "#0e0e1a",
    }}>
      {/* Name */}
      <div style={{ ...S.minerName, color: isWinner ? "#f0c040" : "#d0d0e0" }}>
        {isWinner && "⛏ "}{miner.name}
      </div>

      {/* Stage pill */}
      <div style={{ ...S.minerStagePill, color: info.color, borderColor: info.color + "44" }}>
        {info.label}{active ? " …" : ""}
      </div>

      {/* Step dots */}
      <div style={S.stepDots}>
        {STAGE_ORDER.map((s, i) => (
          <div key={s} style={{
            ...S.dot,
            background: i < stageIdx ? STAGE_INFO[s].color
                      : i === stageIdx ? info.color
                      : "#222",
            boxShadow: i === stageIdx && active ? `0 0 6px ${info.color}` : "none",
          }} />
        ))}
      </div>

      {/* Score */}
      {miner.score !== null && (
        <div style={S.minerScore}>
          <span style={{ color: isWinner ? "#f0c040" : "#a0f0a0" }}>{miner.score}</span>
          <span style={S.minerScoreDenom}>/100</span>
        </div>
      )}

      {/* Message */}
      {miner.message && miner.stage !== "done" && (
        <div style={S.minerMsg}>{miner.message}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Dashboard component
// ---------------------------------------------------------------------------
export default function Dashboard() {
  const [tasks,   setTasks]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState("");

  // Simulation state
  const [simRunning,  setSimRunning]  = useState(false);
  const [simDone,     setSimDone]     = useState(false);
  const [simError,    setSimError]    = useState("");
  const [simTaskId,   setSimTaskId]   = useState(null);
  const [minerCards,  setMinerCards]  = useState(null); // null = not started

  useEffect(() => {
    if (!ADDRESSES.TaskManager) { setLoading(false); return; }
    const manager = getManager(getReadProvider());
    (async () => {
      try {
        const total = await manager.totalTasks();
        const all = [];
        for (let i = 1n; i <= total; i++) all.push(await manager.getTask(i));
        setTasks(all.filter((t) => !t.finalized && Date.now() < Number(t.deadline) * 1000));
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // ── Simulation runner ──────────────────────────────────────────────────────
  async function runSimulation() {
    if (tasks.length === 0) return;
    const latestTask = tasks[tasks.length - 1];
    const taskId     = Number(latestTask.id);

    const MINER_NAMES = ["Miner Alpha", "Miner Beta", "Miner Gamma", "Miner Delta"];
    const initial = Object.fromEntries(
      MINER_NAMES.map((name, i) => [i, { name, stage: "waiting", message: "", score: null }])
    );
    setMinerCards(initial);
    setSimRunning(true);
    setSimDone(false);
    setSimError("");
    setSimTaskId(taskId);

    let res;
    try {
      res = await fetch("http://localhost:5001/simulate", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ task_id: taskId }),
      });
    } catch {
      setSimError("Cannot reach prove-server on localhost:5001 — run: npm run prove-server");
      setSimRunning(false);
      return;
    }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = "";

    try {
      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let ev;
          try { ev = JSON.parse(line.slice(6)); } catch { continue; }

          if (ev.stage === "simulation_done") {
            setSimDone(true);
            break outer;
          }

          const mid = ev.miner_id;
          if (mid === undefined) continue;

          setMinerCards((prev) => ({
            ...prev,
            [mid]: {
              ...prev[mid],
              stage:   ev.stage,
              message: ev.message || "",
              score:   ev.score !== undefined ? ev.score : prev[mid].score,
            },
          }));
        }
      }
    } catch (e) {
      setSimError("Stream error: " + e.message);
    } finally {
      setSimRunning(false);
      setSimDone(true);
    }
  }

  function resetSim() {
    setMinerCards(null);
    setSimDone(false);
    setSimError("");
    setSimTaskId(null);
  }

  // Derive winner once all miners are done
  const winner = (() => {
    if (!minerCards) return null;
    const done = Object.values(minerCards).filter(
      (m) => m.stage === "done" && m.score !== null
    );
    if (done.length === 0) return null;
    return done.reduce((best, m) => (m.score > best.score ? m : best));
  })();

  // ── Render ─────────────────────────────────────────────────────────────────
  if (!ADDRESSES.TaskManager) {
    return <Notice msg="Contract not deployed yet. Run npm run deploy:baseSepolia and update ADDRESSES in contracts.js." />;
  }
  if (loading) return <Notice msg="Loading tasks…" />;
  if (error)   return <Notice msg={`Error: ${error}`} color="#ff6b6b" />;

  return (
    <div>
      <h2 style={S.heading}>Blocks to Mine</h2>

      {tasks.length === 0
        ? <Notice msg="No blocks to mine. The owner hasn't posted any tasks yet." />
        : tasks.map((t) => <TaskCard key={t.id.toString()} task={t} />)
      }

      {/* ── Mining Simulation ─────────────────────────────────────────── */}
      {tasks.length > 0 && (
        <div style={S.simSection}>
          <div style={S.simHeader}>
            <div>
              <div style={S.simTitle}>Mining Simulation</div>
              <div style={S.simSubtitle}>
                Watch 4 miners race to prove gradient quality on Block #{tasks[tasks.length - 1].id.toString()}
              </div>
            </div>
            {!simRunning && (
              <button
                style={minerCards ? S.btnReset : S.btnRun}
                onClick={minerCards ? resetSim : runSimulation}
              >
                {minerCards ? "Reset" : "Run Mining Simulation"}
              </button>
            )}
            {simRunning && (
              <button style={S.btnRunning} disabled>
                Mining…
              </button>
            )}
          </div>

          {simError && <p style={S.simError}>{simError}</p>}

          {/* Miner cards grid */}
          {minerCards && (
            <>
              <div style={S.minerGrid}>
                {Object.values(minerCards).map((miner, i) => (
                  <MinerCard
                    key={i}
                    miner={miner}
                    isWinner={simDone && winner?.name === miner.name}
                  />
                ))}
              </div>

              {/* Winner banner */}
              {simDone && winner && (
                <div style={S.winnerBanner}>
                  ⛏ Block Mined by {winner.name} — {winner.score}/100
                </div>
              )}
              {simDone && !winner && (
                <div style={{ ...S.winnerBanner, background: "#1a0a0a", borderColor: "#3a1a1a", color: "#ff6b6b" }}>
                  No miners completed successfully.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Notice({ msg, color = "#666" }) {
  return <p style={{ color, padding: "40px 0", textAlign: "center" }}>{msg}</p>;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const S = {
  heading: { color: "#a0b0ff", marginBottom: 20, fontSize: 16, letterSpacing: 1 },

  // Block cards
  card: {
    background: "#0e0e1a", border: "1px solid #1e1e30", borderRadius: 6,
    padding: "20px 24px", marginBottom: 16,
  },
  cardHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  taskId:     { color: "#555", fontSize: 11, letterSpacing: 2 },
  badge: {
    fontSize: 11, padding: "3px 8px", borderRadius: 3, letterSpacing: 1,
    background: "#0a1a10", color: "#3ddc84", border: "1px solid #1a3a20",
  },
  badgeExpired: {
    fontSize: 11, padding: "3px 8px", borderRadius: 3, letterSpacing: 1,
    background: "#1a0a0a", color: "#ff6b6b", border: "1px solid #3a1a1a",
  },
  desc:      { color: "#c0c0d8", marginBottom: 16, lineHeight: 1.6 },
  meta:      { display: "flex", gap: 32 },
  metaItem:  { display: "flex", flexDirection: "column", gap: 4 },
  metaLabel: { fontSize: 10, color: "#444", letterSpacing: 1, textTransform: "uppercase" },
  metaVal:   { fontSize: 14, color: "#d0d0e0" },

  // Simulation section wrapper
  simSection: {
    marginTop: 32, borderTop: "1px solid #1a1a28", paddingTop: 28,
  },
  simHeader: {
    display: "flex", justifyContent: "space-between", alignItems: "flex-start",
    marginBottom: 20,
  },
  simTitle:    { color: "#a0b0ff", fontSize: 15, fontWeight: "bold", letterSpacing: 0.5 },
  simSubtitle: { color: "#555", fontSize: 11, marginTop: 4 },
  simError:    { color: "#ff6b6b", fontSize: 12, marginBottom: 16 },

  btnRun: {
    background: "#1a0e2a", color: "#b07fff", border: "1px solid #3a1a6a",
    padding: "8px 20px", borderRadius: 4, fontSize: 13, cursor: "pointer",
    whiteSpace: "nowrap",
  },
  btnRunning: {
    background: "#0e0e1a", color: "#444", border: "1px solid #222",
    padding: "8px 20px", borderRadius: 4, fontSize: 13,
    whiteSpace: "nowrap",
  },
  btnReset: {
    background: "transparent", color: "#444", border: "1px solid #222",
    padding: "8px 20px", borderRadius: 4, fontSize: 12, cursor: "pointer",
    whiteSpace: "nowrap",
  },

  // Miner cards
  minerGrid: {
    display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20,
  },
  minerCard: {
    borderRadius: 6, padding: "16px 14px", minHeight: 140,
    transition: "border-color 0.3s, background 0.3s",
  },
  minerName: {
    fontSize: 12, fontWeight: "bold", marginBottom: 10, letterSpacing: 0.5,
  },
  minerStagePill: {
    display: "inline-block", fontSize: 10, letterSpacing: 0.8,
    textTransform: "uppercase", border: "1px solid", borderRadius: 3,
    padding: "2px 7px", marginBottom: 10,
  },
  stepDots: { display: "flex", gap: 4, marginBottom: 10 },
  dot:      { width: 6, height: 6, borderRadius: "50%", transition: "background 0.3s, box-shadow 0.3s" },
  minerScore: {
    fontSize: 28, fontWeight: "bold", lineHeight: 1, marginBottom: 6,
  },
  minerScoreDenom: { fontSize: 11, color: "#555", marginLeft: 1 },
  minerMsg: { fontSize: 10, color: "#555", lineHeight: 1.4, marginTop: 4 },

  // Winner banner
  winnerBanner: {
    background: "#14100a", border: "1px solid #8a6a00", borderRadius: 6,
    padding: "14px 20px", color: "#f0c040", fontSize: 15, fontWeight: "bold",
    textAlign: "center", letterSpacing: 0.5,
  },
};
