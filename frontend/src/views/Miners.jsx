import { useEffect, useState, useCallback } from "react";
import { LineChart, Line, ResponsiveContainer, Tooltip } from "recharts";
import { ADMIN_API as API } from "../config";

// ---------------------------------------------------------------------------
// Miner profiles — must stay in sync with server.py AUGMENTATION_STRATEGIES
// ---------------------------------------------------------------------------
const MINER_PROFILES = [
  {
    id: 0, name: "Miner Alpha", color: "#6b8fff",
    aug:  "Random Rotation ±15°",
    desc: "Rotates each digit image by a random angle up to ±15° every epoch — trains the model to be rotation-invariant.",
    icon: "⟳",
  },
  {
    id: 1, name: "Miner Beta", color: "#f0c040",
    aug:  "Gaussian Noise σ=0.1",
    desc: "Adds Gaussian noise (σ=0.1) to pixel values each epoch — improves robustness to noisy or corrupted inputs.",
    icon: "≋",
  },
  {
    id: 2, name: "Miner Gamma", color: "#3ddc84",
    aug:  "Random Erasing 10–20%",
    desc: "Zeros out a random rectangular patch covering 10–20% of pixels each epoch — trains the model to handle occlusion.",
    icon: "▪",
  },
  {
    id: 3, name: "Miner Delta", color: "#b07fff",
    aug:  "Clean Training",
    desc: "No augmentation — pure gradient descent on the MNIST shard. Provides a clean baseline for comparison.",
    icon: "◆",
  },
];

const ZERO_STATS = { wins: 0, submissions: 0, totalScore: 0, bestScore: 0, lastScores: [] };

// ---------------------------------------------------------------------------
// Data loading — reads from local autoMiner stats API
// ---------------------------------------------------------------------------
async function loadMinerStats() {
  const res = await fetch(`${API}/api/miner-stats`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Sparkline component
// ---------------------------------------------------------------------------
function Sparkline({ data, color }) {
  if (data.length < 2) {
    return (
      <div style={S.sparkEmpty}>
        {data.length === 1 ? `${data[0].score}/100` : "No data yet"}
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={44}>
      <LineChart data={data} margin={{ top: 4, right: 4, left: 4, bottom: 4 }}>
        <Line
          type="monotone"
          dataKey="score"
          stroke={color}
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
        <Tooltip
          contentStyle={{
            background: "#0a0a14", border: `1px solid ${color}44`,
            borderRadius: 3, fontSize: 10, padding: "3px 8px",
          }}
          labelStyle={{ display: "none" }}
          itemStyle={{ color }}
          formatter={(v) => [`${v}/100`, ""]}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// Miner card
// ---------------------------------------------------------------------------
function MinerCard({ miner }) {
  const { wins, submissions, totalScore, bestScore, lastScores, winRate } = miner;
  const avgScore = submissions > 0 ? Math.round(totalScore / submissions) : null;
  const last10   = lastScores.slice(-10).map((score, i) => ({ i, score }));

  return (
    <div style={S.card}>
      {/* Header */}
      <div style={S.cardHeader}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ ...S.dot, background: miner.color, boxShadow: `0 0 8px ${miner.color}66` }} />
          <span style={{ ...S.minerName, color: miner.color }}>{miner.name}</span>
        </div>
        <span style={{ ...S.iconBadge, borderColor: `${miner.color}44`, color: miner.color }}>
          {miner.icon}
        </span>
      </div>

      {/* Augmentation strategy */}
      <div style={S.augLabel}>{miner.aug}</div>
      <div style={S.augDesc}>{miner.desc}</div>

      {/* Stats grid */}
      <div style={S.statsGrid}>
        <div style={S.stat}>
          <div style={{ ...S.statVal, color: miner.color }}>{wins}</div>
          <div style={S.statLabel}>Blocks Won</div>
        </div>
        <div style={S.stat}>
          <div style={{ ...S.statVal, color: "#d0d0e0" }}>{submissions}</div>
          <div style={S.statLabel}>Submissions</div>
        </div>
        <div style={S.stat}>
          <div style={{ ...S.statVal, color: "#a0b0ff" }}>
            {avgScore !== null ? `${avgScore}` : "—"}
          </div>
          <div style={S.statLabel}>Avg Score</div>
        </div>
        <div style={S.stat}>
          <div style={{ ...S.statVal, color: "#f0c040" }}>
            {bestScore > 0 ? `${bestScore}` : "—"}
          </div>
          <div style={S.statLabel}>Best Score</div>
        </div>
      </div>

      {/* Win rate */}
      <div style={S.winRateRow}>
        <span style={S.winRateLabel}>Win rate</span>
        <span style={{ ...S.winRateVal, color: winRate !== null && winRate > 0 ? "#3ddc84" : "#555" }}>
          {winRate !== null ? `${winRate}%` : "—"}
        </span>
      </div>

      {/* Sparkline */}
      <div style={S.sparkLabel}>Last {last10.length} scores</div>
      <Sparkline data={last10} color={miner.color} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------
export default function Miners() {
  const [minerData, setMinerData] = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState("");

  const refresh = useCallback(async () => {
    try {
      const stats     = await loadMinerStats();
      const totalWins = [0, 1, 2, 3].reduce((s, id) => s + (stats[id]?.wins ?? 0), 0);
      const merged    = MINER_PROFILES.map((profile) => {
        const s       = { ...ZERO_STATS, ...(stats[profile.id] ?? {}) };
        const winRate = totalWins > 0 ? Math.round((s.wins / totalWins) * 100) : null;
        return { ...profile, ...s, winRate };
      });
      setMinerData(merged);
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <div>
      <div style={S.topRow}>
        <div>
          <h2 style={S.heading}>Miners</h2>
          <p style={S.subheading}>
            Four miners, each with a distinct data augmentation strategy — competing to mine each block
          </p>
        </div>
        <div style={S.refreshRow}>
          {loading && <span style={S.loadingDot}>●</span>}
          <span style={S.pollNote}>Polls every 10s</span>
        </div>
      </div>

      {error && <div style={S.errBox}>{error}</div>}

      <div style={S.grid}>
        {(minerData ?? MINER_PROFILES.map((m) => ({ ...m, ...ZERO_STATS, winRate: null }))).map((miner) => (
          <MinerCard key={miner.id} miner={miner} />
        ))}
      </div>

      <div style={S.note}>
        Stats tracked locally by autoMiner.js and persisted to server/miner-stats.json.
        Win rate = share of total blocks won across all miners. Reset via POST /api/miner-stats/reset.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const S = {
  notice:     { color: "#666", padding: "40px 0", textAlign: "center" },
  heading:    { color: "#a0b0ff", marginBottom: 4, fontSize: 16, letterSpacing: 1 },
  subheading: { color: "#555", fontSize: 11, margin: 0 },
  topRow:     { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 },
  refreshRow: { display: "flex", alignItems: "center", gap: 8 },
  loadingDot: { color: "#a0b0ff", fontSize: 10, animation: "none" },
  pollNote:   { fontSize: 10, color: "#444", fontFamily: "monospace" },

  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
    gap: 16,
    marginBottom: 24,
  },

  card: {
    background: "#0e0e1a", border: "1px solid #1e1e30", borderRadius: 6,
    padding: "18px 20px", fontFamily: "'Courier New', Courier, monospace",
  },

  cardHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  dot: { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 },
  minerName: { fontSize: 12, fontWeight: "bold", letterSpacing: 0.5 },
  iconBadge: {
    fontSize: 13, border: "1px solid", borderRadius: 4,
    padding: "2px 7px", lineHeight: 1.4,
  },

  augLabel: { fontSize: 11, color: "#a0b0ff", marginBottom: 6, letterSpacing: 0.3 },
  augDesc:  {
    fontSize: 10, color: "#555", lineHeight: 1.6, marginBottom: 16,
    borderBottom: "1px solid #111120", paddingBottom: 14,
  },

  statsGrid: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginBottom: 14 },
  stat:      { textAlign: "center" },
  statVal:   { fontSize: 18, fontWeight: "bold", lineHeight: 1, marginBottom: 3, fontFamily: "monospace" },
  statLabel: { fontSize: 8, color: "#444", letterSpacing: 0.6, textTransform: "uppercase" },

  winRateRow:  { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  winRateLabel:{ fontSize: 9, color: "#444", letterSpacing: 0.8, textTransform: "uppercase" },
  winRateVal:  { fontSize: 14, fontWeight: "bold", fontFamily: "monospace" },

  sparkLabel: { fontSize: 8, color: "#333", letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 2 },
  sparkEmpty: { fontSize: 10, color: "#444", fontStyle: "italic", padding: "10px 0", textAlign: "center" },

  errBox: {
    background: "#1a0808", border: "1px solid #3a1010", borderRadius: 6,
    padding: "10px 16px", color: "#ff6b6b", fontSize: 11, marginBottom: 16,
  },
  note: {
    fontSize: 10, color: "#333", lineHeight: 1.65, fontFamily: "monospace",
    borderTop: "1px solid #111120", paddingTop: 16,
  },
};
