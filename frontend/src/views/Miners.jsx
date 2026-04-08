import { useEffect, useState, useCallback } from "react";
import { LineChart, Line, ResponsiveContainer, Tooltip } from "recharts";
import { ADMIN_API as API } from "../config";

// ---------------------------------------------------------------------------
// Miner profiles — keep in sync with server.py AUGMENTATION_STRATEGIES
// ---------------------------------------------------------------------------
const MINER_PROFILES = [
  {
    id: 0, name: "ALPHA", callsign: "Miner Alpha",
    color: "var(--miner-alpha)", colorRaw: "#00f5ff",
    aug:  "Random Rotation ±15°",
    desc: "Rotates each digit image by a random angle up to ±15° every epoch — trains the model to be rotation-invariant.",
    glyph: "⟳",
    spec: "ROT-15",
  },
  {
    id: 1, name: "BETA", callsign: "Miner Beta",
    color: "var(--miner-beta)", colorRaw: "#ffd84d",
    aug:  "Gaussian Noise σ=0.1",
    desc: "Adds Gaussian noise (σ=0.1) to pixel values each epoch — improves robustness to noisy or corrupted inputs.",
    glyph: "≋",
    spec: "GN-010",
  },
  {
    id: 2, name: "GAMMA", callsign: "Miner Gamma",
    color: "var(--miner-gamma)", colorRaw: "#4ade80",
    aug:  "Random Erasing 10–20%",
    desc: "Zeros out a random rectangular patch covering 10–20% of pixels each epoch — trains the model to handle occlusion.",
    glyph: "▪",
    spec: "RE-1020",
  },
  {
    id: 3, name: "DELTA", callsign: "Miner Delta",
    color: "var(--miner-delta)", colorRaw: "#c084fc",
    aug:  "Clean Training",
    desc: "No augmentation — pure gradient descent on the MNIST shard. Provides a clean baseline for comparison.",
    glyph: "◆",
    spec: "BASE",
  },
];

const ZERO_STATS = { wins: 0, submissions: 0, totalScore: 0, bestScore: 0, lastScores: [] };

async function loadMinerStats() {
  const res = await fetch(`${API}/api/miner-stats`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Sparkline
// ---------------------------------------------------------------------------
function Sparkline({ data, color }) {
  if (data.length < 2) {
    return (
      <div style={S.sparkEmpty}>
        {data.length === 1 ? `${data[0].score}/100` : "NO DATA"}
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={64}>
      <LineChart data={data} margin={{ top: 6, right: 6, left: 6, bottom: 6 }}>
        <defs>
          <linearGradient id={`spark-${color}`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={color} stopOpacity="0.3" />
            <stop offset="100%" stopColor={color} stopOpacity="1" />
          </linearGradient>
        </defs>
        <Line
          type="monotone"
          dataKey="score"
          stroke={`url(#spark-${color})`}
          strokeWidth={1.8}
          dot={false}
          isAnimationActive={false}
        />
        <Tooltip
          contentStyle={{
            background: "var(--bg-elevated)",
            border: `1px solid ${color}`,
            borderRadius: 4,
            fontSize: 10,
            padding: "4px 9px",
            fontFamily: "var(--font-mono)",
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
// Miner card — fighter card style
// ---------------------------------------------------------------------------
function MinerCard({ miner }) {
  const { wins, submissions, totalScore, bestScore, lastScores, winRate } = miner;
  const avgScore = submissions > 0 ? Math.round(totalScore / submissions) : null;
  const last10   = lastScores.slice(-10).map((score, i) => ({ i, score }));
  const [hover, setHover] = useState(false);

  return (
    <div
      style={{
        ...S.card,
        borderColor: hover ? miner.colorRaw : "var(--border)",
        boxShadow:   hover ? `0 0 36px ${miner.colorRaw}33, inset 0 0 0 1px ${miner.colorRaw}22` : "none",
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {/* Top accent stripe */}
      <div style={{ ...S.cardStripe, background: miner.colorRaw, boxShadow: `0 0 16px ${miner.colorRaw}88` }} />

      {/* Header — name + callsign + glyph */}
      <div style={S.cardHeader}>
        <div>
          <div style={S.cardCallsign}>UNIT</div>
          <div style={{ ...S.cardName, color: miner.colorRaw }}>{miner.name}</div>
        </div>
        <div style={{
          ...S.cardGlyph,
          color: miner.colorRaw,
          borderColor: `${miner.colorRaw}55`,
          textShadow: `0 0 12px ${miner.colorRaw}88`,
        }}>
          {miner.glyph}
        </div>
      </div>

      {/* Spec line */}
      <div style={S.specLine}>
        <span style={S.specEyebrow}>STRATEGY</span>
        <span style={{ ...S.specTag, color: miner.colorRaw, borderColor: `${miner.colorRaw}33` }}>
          {miner.spec}
        </span>
      </div>
      <div style={S.augTitle}>{miner.aug}</div>
      <div style={S.augDesc}>{miner.desc}</div>

      {/* Divider */}
      <div style={S.divider} />

      {/* Stats grid — 2x2 with hero stat */}
      <div style={S.statsGrid}>
        <div style={S.statBlock}>
          <div style={S.statLabel}>BLOCKS WON</div>
          <div style={{ ...S.statBig, color: miner.colorRaw, textShadow: wins > 0 ? `0 0 24px ${miner.colorRaw}66` : "none" }}>
            {String(wins).padStart(2, "0")}
          </div>
        </div>
        <div style={S.statBlock}>
          <div style={S.statLabel}>WIN RATE</div>
          <div style={S.statBig}>
            {winRate !== null ? `${winRate}` : "—"}
            <span style={S.statUnit}>%</span>
          </div>
        </div>
        <div style={S.statBlockSmall}>
          <div style={S.statLabel}>SUBMISSIONS</div>
          <div style={S.statSmall}>{String(submissions).padStart(3, "0")}</div>
        </div>
        <div style={S.statBlockSmall}>
          <div style={S.statLabel}>BEST</div>
          <div style={S.statSmall}>
            {bestScore > 0 ? `${bestScore}` : "—"}
            {bestScore > 0 && <span style={S.statSmallUnit}>/100</span>}
          </div>
        </div>
        <div style={S.statBlockSmall}>
          <div style={S.statLabel}>AVERAGE</div>
          <div style={S.statSmall}>
            {avgScore !== null ? `${avgScore}` : "—"}
            {avgScore !== null && <span style={S.statSmallUnit}>/100</span>}
          </div>
        </div>
      </div>

      {/* Sparkline */}
      <div style={S.sparkSection}>
        <div style={S.sparkHeader}>
          <span style={S.sparkLabel}>LAST {last10.length} SCORES</span>
          <span style={{ ...S.sparkAxis, color: miner.colorRaw }}>● LIVE</span>
        </div>
        <Sparkline data={last10} color={miner.colorRaw} />
      </div>
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
      {/* Hero */}
      <div style={S.hero}>
        <div style={S.heroEyebrow}>
          <span style={S.heroEyebrowBar} />
          ACTIVE MINER FLEET
        </div>
        <h1 style={S.heroTitle}>MINERS</h1>
        <p style={S.heroSub}>
          Four miners. Four data augmentation strategies. One global model. Each unit competes
          to mine every block by submitting the highest-quality gradient.
        </p>
      </div>

      {/* Status strip */}
      <div style={S.statusStrip}>
        <div style={S.statusItem}>
          <span style={S.statusDot} />
          <span style={S.statusLabel}>POLLING</span>
          <span style={S.statusVal}>10s</span>
        </div>
        <div style={S.statusItem}>
          <span style={S.statusLabel}>UNITS</span>
          <span style={S.statusVal}>04 / 04</span>
        </div>
        <div style={S.statusItem}>
          <span style={S.statusLabel}>SOURCE</span>
          <span style={S.statusVal}>server/miner-stats.json</span>
        </div>
        {loading && (
          <div style={S.statusItem}>
            <span style={S.statusVal}>SYNCING…</span>
          </div>
        )}
      </div>

      {error && <div style={S.errBox}>⚠ {error}</div>}

      {/* Grid */}
      <div style={S.grid}>
        {(minerData ?? MINER_PROFILES.map((m) => ({ ...m, ...ZERO_STATS, winRate: null }))).map((miner) => (
          <MinerCard key={miner.id} miner={miner} />
        ))}
      </div>

      <div style={S.note}>
        Stats are tracked locally by autoMiner.js and persisted to server/miner-stats.json.
        Win rate = share of total blocks won across all units. Reset via POST /api/miner-stats/reset.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const S = {
  hero: { paddingTop: 12, marginBottom: 28 },
  heroEyebrow: {
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    fontWeight: 500,
    letterSpacing: "0.18em",
    textTransform: "uppercase",
    color: "var(--text-tertiary)",
    marginBottom: 14,
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  heroEyebrowBar: {
    width: 24, height: 1,
    background: "var(--accent)",
    boxShadow: "0 0 8px var(--accent)",
  },
  heroTitle: {
    fontFamily: "var(--font-sans)",
    fontSize: 56,
    fontWeight: 800,
    letterSpacing: "-0.04em",
    color: "var(--text-primary)",
    lineHeight: 0.95,
    margin: 0,
  },
  heroSub: {
    color: "var(--text-tertiary)",
    fontSize: 13,
    margin: "14px 0 0",
    maxWidth: 600,
    lineHeight: 1.6,
  },

  // Status strip
  statusStrip: {
    display: "flex",
    alignItems: "center",
    gap: 24,
    padding: "14px 20px",
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
    marginBottom: 24,
    fontFamily: "var(--font-mono)",
  },
  statusItem: { display: "flex", alignItems: "center", gap: 8 },
  statusDot: {
    width: 7, height: 7, borderRadius: "50%",
    background: "var(--accent)",
    boxShadow: "0 0 10px var(--accent)",
    animation: "pulse-glow 2.4s ease-in-out infinite",
  },
  statusLabel: {
    fontSize: 9,
    letterSpacing: "0.16em",
    color: "var(--text-tertiary)",
    textTransform: "uppercase",
  },
  statusVal: {
    fontSize: 10,
    color: "var(--text-primary)",
    letterSpacing: "0.04em",
  },

  // Grid
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
    gap: 18,
    marginBottom: 32,
  },

  // ── Card ─────────────────────────────────────────────────────────
  card: {
    position: "relative",
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-lg)",
    padding: "26px 24px 22px",
    fontFamily: "var(--font-sans)",
    transition: "all 240ms var(--ease-out)",
    overflow: "hidden",
  },
  cardStripe: {
    position: "absolute",
    top: 0, left: 0, right: 0,
    height: 2,
  },
  cardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 16,
  },
  cardCallsign: {
    fontFamily: "var(--font-mono)",
    fontSize: 9,
    color: "var(--text-tertiary)",
    letterSpacing: "0.18em",
    marginBottom: 4,
  },
  cardName: {
    fontFamily: "var(--font-sans)",
    fontSize: 28,
    fontWeight: 800,
    letterSpacing: "-0.02em",
    lineHeight: 1,
  },
  cardGlyph: {
    width: 36, height: 36,
    border: "1px solid",
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 16,
    fontFamily: "var(--font-mono)",
    flexShrink: 0,
  },

  // Spec
  specLine: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  specEyebrow: {
    fontFamily: "var(--font-mono)",
    fontSize: 9,
    color: "var(--text-tertiary)",
    letterSpacing: "0.14em",
  },
  specTag: {
    fontFamily: "var(--font-mono)",
    fontSize: 9,
    fontWeight: 600,
    border: "1px solid",
    borderRadius: 2,
    padding: "2px 6px",
    letterSpacing: "0.1em",
  },
  augTitle: {
    fontFamily: "var(--font-sans)",
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-primary)",
    marginBottom: 6,
  },
  augDesc: {
    fontFamily: "var(--font-sans)",
    fontSize: 11,
    color: "var(--text-tertiary)",
    lineHeight: 1.6,
    marginBottom: 18,
  },

  divider: {
    height: 1,
    background: "var(--border)",
    marginBottom: 18,
  },

  // Stats
  statsGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 16,
    marginBottom: 18,
  },
  statBlock: { display: "flex", flexDirection: "column", gap: 6 },
  statBlockSmall: { display: "flex", flexDirection: "column", gap: 4 },
  statLabel: {
    fontFamily: "var(--font-mono)",
    fontSize: 8,
    color: "var(--text-tertiary)",
    letterSpacing: "0.18em",
    textTransform: "uppercase",
  },
  statBig: {
    fontFamily: "var(--font-mono)",
    fontSize: 36,
    fontWeight: 600,
    color: "var(--text-primary)",
    lineHeight: 1,
    letterSpacing: "-0.03em",
    fontVariantNumeric: "tabular-nums",
    display: "flex",
    alignItems: "baseline",
    gap: 2,
  },
  statUnit: {
    fontSize: 14,
    color: "var(--text-dim)",
    fontWeight: 500,
  },
  statSmall: {
    fontFamily: "var(--font-mono)",
    fontSize: 18,
    fontWeight: 500,
    color: "var(--text-secondary)",
    letterSpacing: "-0.01em",
    fontVariantNumeric: "tabular-nums",
    display: "flex",
    alignItems: "baseline",
    gap: 2,
  },
  statSmallUnit: {
    fontSize: 10,
    color: "var(--text-dim)",
  },

  // Spark
  sparkSection: {
    paddingTop: 14,
    borderTop: "1px solid var(--border)",
  },
  sparkHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  sparkLabel: {
    fontFamily: "var(--font-mono)",
    fontSize: 8,
    color: "var(--text-tertiary)",
    letterSpacing: "0.18em",
    textTransform: "uppercase",
  },
  sparkAxis: {
    fontFamily: "var(--font-mono)",
    fontSize: 8,
    letterSpacing: "0.18em",
    textTransform: "uppercase",
  },
  sparkEmpty: {
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    color: "var(--text-dim)",
    padding: "20px 0",
    textAlign: "center",
    letterSpacing: "0.1em",
  },

  errBox: {
    background: "rgba(255, 77, 109, 0.06)",
    border: "1px solid rgba(255, 77, 109, 0.2)",
    borderRadius: "var(--radius-sm)",
    padding: "10px 16px",
    color: "#ff7a8e",
    fontSize: 11,
    marginBottom: 16,
    fontFamily: "var(--font-mono)",
  },
  note: {
    fontSize: 11,
    color: "var(--text-tertiary)",
    lineHeight: 1.7,
    fontFamily: "var(--font-mono)",
    borderTop: "1px solid var(--border)",
    paddingTop: 18,
  },
};
