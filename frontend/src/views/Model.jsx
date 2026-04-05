import { useEffect, useRef, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";

const PROVE_SERVER = "http://localhost:5001";
const CANVAS_SIZE  = 280;   // display canvas (10× MNIST)
const DIGIT_SIZE   = 28;    // actual MNIST resolution

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatCard({ label, value, color }) {
  return (
    <div style={S.statCard}>
      <div style={{ ...S.statValue, color: color || "#a0b0ff" }}>{value}</div>
      <div style={S.statLabel}>{label}</div>
    </div>
  );
}

function ConfidenceBar({ digit, prob, isTop }) {
  return (
    <div style={S.confRow}>
      <div style={{ ...S.confDigit, color: isTop ? "#a0b0ff" : "#666" }}>{digit}</div>
      <div style={S.confBarBg}>
        <div style={{
          ...S.confBarFill,
          width: `${(prob * 100).toFixed(1)}%`,
          background: isTop ? "#a0b0ff" : "#2a2a4a",
        }} />
      </div>
      <div style={{ ...S.confPct, color: isTop ? "#a0b0ff" : "#555" }}>
        {(prob * 100).toFixed(1)}%
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Digit canvas
// ---------------------------------------------------------------------------

function DigitCanvas({ onPredict, predicting }) {
  const canvasRef  = useRef(null);
  const drawing    = useRef(false);
  const lastPos    = useRef(null);

  function getPos(e) {
    const rect = canvasRef.current.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  }

  function startDraw(e) {
    e.preventDefault();
    drawing.current = true;
    lastPos.current = getPos(e);
  }

  function draw(e) {
    if (!drawing.current) return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext("2d");
    const pos = getPos(e);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth   = 20;
    ctx.lineCap     = "round";
    ctx.lineJoin    = "round";
    ctx.beginPath();
    ctx.moveTo(lastPos.current.x, lastPos.current.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    lastPos.current = pos;
  }

  function endDraw() {
    drawing.current = false;
    lastPos.current = null;
  }

  function clearCanvas() {
    const ctx = canvasRef.current.getContext("2d");
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  }

  function extractPixels() {
    // Step 1: downsample 280×280 → 28×28 by averaging each 10×10 block
    const ctx   = canvasRef.current.getContext("2d");
    const scale = CANVAS_SIZE / DIGIT_SIZE;   // 10
    const raw   = new Float32Array(DIGIT_SIZE * DIGIT_SIZE);
    for (let r = 0; r < DIGIT_SIZE; r++) {
      for (let c = 0; c < DIGIT_SIZE; c++) {
        const px = ctx.getImageData(c * scale, r * scale, scale, scale).data;
        let sum  = 0;
        for (let i = 0; i < px.length; i += 4) sum += px[i];  // R channel
        raw[r * DIGIT_SIZE + c] = sum / (px.length / 4) / 255;
      }
    }

    // Step 2: find bounding box of ink pixels (threshold 5%)
    let minR = DIGIT_SIZE, maxR = -1, minC = DIGIT_SIZE, maxC = -1;
    for (let r = 0; r < DIGIT_SIZE; r++) {
      for (let c = 0; c < DIGIT_SIZE; c++) {
        if (raw[r * DIGIT_SIZE + c] > 0.05) {
          if (r < minR) minR = r;  if (r > maxR) maxR = r;
          if (c < minC) minC = c;  if (c > maxC) maxC = c;
        }
      }
    }

    // No ink drawn — return zeros
    if (maxR < 0) return Array.from(raw);

    // Step 3: scale content to fit 20×20, center in 28×28 (MNIST style)
    const h      = maxR - minR + 1;
    const w      = maxC - minC + 1;
    const scaleF = Math.min(20 / h, 20 / w);
    const newH   = Math.max(1, Math.round(h * scaleF));
    const newW   = Math.max(1, Math.round(w * scaleF));
    const offR   = Math.round((DIGIT_SIZE - newH) / 2);
    const offC   = Math.round((DIGIT_SIZE - newW) / 2);

    const out = new Float32Array(DIGIT_SIZE * DIGIT_SIZE);
    for (let r = 0; r < newH; r++) {
      for (let c = 0; c < newW; c++) {
        const srcR = minR + Math.floor(r / scaleF);
        const srcC = minC + Math.floor(c / scaleF);
        out[(offR + r) * DIGIT_SIZE + (offC + c)] = raw[srcR * DIGIT_SIZE + srcC];
      }
    }

    return Array.from(out);
  }

  // Init black canvas
  useEffect(() => {
    clearCanvas();
  }, []);

  async function handlePredict() {
    const pixels = extractPixels();
    onPredict(pixels);
  }

  return (
    <div style={S.canvasWrapper}>
      <canvas
        ref={canvasRef}
        width={CANVAS_SIZE}
        height={CANVAS_SIZE}
        style={S.canvas}
        onMouseDown={startDraw}
        onMouseMove={draw}
        onMouseUp={endDraw}
        onMouseLeave={endDraw}
        onTouchStart={startDraw}
        onTouchMove={draw}
        onTouchEnd={endDraw}
      />
      <div style={S.canvasBtns}>
        <button style={S.clearBtn} onClick={clearCanvas}>Clear</button>
        <button
          style={{ ...S.predictBtn, opacity: predicting ? 0.5 : 1 }}
          onClick={handlePredict}
          disabled={predicting}
        >
          {predicting ? "Predicting…" : "Predict Digit"}
        </button>
      </div>
      <div style={S.canvasHint}>Draw a digit (0–9) on the canvas above</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Model view
// ---------------------------------------------------------------------------

export default function Model() {
  const [accuracyLog, setAccuracyLog] = useState([]);   // [{task_id, accuracy, score}]
  const [serverUp,    setServerUp]    = useState(null);
  const [prediction,  setPrediction]  = useState(null); // {digit, confidence, confidences}
  const [predicting,  setPredicting]  = useState(false);
  const [predErr,     setPredErr]     = useState("");

  // ── Load full history on mount ────────────────────────────────────────────
  // Uses a generous 8s timeout so a busy prove server (mid-training) doesn't
  // abort before returning the log. Runs once; the poll below keeps it fresh.
  useEffect(() => {
    let cancelled = false;
    async function loadHistory() {
      try {
        const r = await fetch(`${PROVE_SERVER}/accuracy`,
          { signal: AbortSignal.timeout(8000) });
        const d = await r.json();
        if (!cancelled && d.ok) {
          setAccuracyLog(d.log || []);
          setServerUp(true);
        }
      } catch {
        if (!cancelled) setServerUp(false);
      }
    }
    loadHistory();
    return () => { cancelled = true; };
  }, []);

  // ── Poll for new entries every 10s ────────────────────────────────────────
  // Short timeout is fine here — we already have history; a missed poll just
  // means we wait another 10s for the next entry.
  useEffect(() => {
    async function poll() {
      try {
        const r = await fetch(`${PROVE_SERVER}/accuracy`,
          { signal: AbortSignal.timeout(3000) });
        const d = await r.json();
        if (d.ok) {
          setAccuracyLog(d.log || []);
          setServerUp(true);
        }
      } catch { /* non-fatal — history is already loaded */ }
    }
    const id = setInterval(poll, 10_000);
    return () => clearInterval(id);
  }, []);

  // ── Predict ───────────────────────────────────────────────────────────────
  async function handlePredict(pixels) {
    setPredicting(true);
    setPredErr("");
    setPrediction(null);
    try {
      const r = await fetch(`${PROVE_SERVER}/predict`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ pixels }),
        signal:  AbortSignal.timeout(5000),
      });
      const d = await r.json();
      if (d.ok) {
        setPrediction(d);
      } else {
        setPredErr(d.error || "Prediction failed");
      }
    } catch (e) {
      setPredErr(e.message.includes("abort") ? "Server timeout" : e.message);
    }
    setPredicting(false);
  }

  // ── Derived stats (skip reset markers) ───────────────────────────────────
  const dataEntries = accuracyLog.filter((e) => !e.reset);
  const latestAcc   = dataEntries.length > 0
    ? dataEntries[dataEntries.length - 1].accuracy
    : null;
  const bestScore   = dataEntries.length > 0
    ? Math.max(...dataEntries.map((e) => e.winner_score))
    : null;

  // Chart data: last 20 entries (including reset markers), x-axis = sequential
  // entry number so data from multiple training sessions plots continuously.
  // Reset entries get null accuracy/score so the line breaks at that point.
  const sliceOffset = Math.max(0, accuracyLog.length - 20);
  const chartData   = accuracyLog.slice(-20).map((e, i) => ({
    entryNum:    sliceOffset + i + 1,
    taskLabel:   e.reset ? null : `#${e.task_id}`,
    accuracy:    e.reset ? null : +(e.accuracy * 100).toFixed(2),
    winnerScore: e.reset ? null : (e.winner_score ?? null),
    isReset:     !!e.reset,
  }));

  // Vertical lines at each reset entry
  const resetPoints = chartData.filter((d) => d.isReset).map((d) => d.entryNum);

  // Y-axis floor: computed from non-reset points only.
  const nonResetChart = chartData.filter((d) => !d.isReset);
  const yMin = nonResetChart.length > 0
    ? Math.max(0, Math.floor(Math.min(...nonResetChart.map((d) => d.accuracy)) - 5))
    : 0;

  return (
    <div>
      <h2 style={S.heading}>MNIST Model</h2>

      {serverUp === false && (
        <div style={S.warn}>
          ⚠ Prove server not reachable — run: <code style={S.code}>npm run prove-server</code>
        </div>
      )}

      {/* ── Stats bar ─────────────────────────────────────────────────── */}
      <div style={S.statsRow}>
        <StatCard
          label="Global Accuracy"
          value={latestAcc !== null ? `${(latestAcc * 100).toFixed(1)}%` : "—"}
          color="#3ddc84"
        />
        <StatCard
          label="Blocks Processed"
          value={dataEntries.length || "—"}
          color="#a0b0ff"
        />
        <StatCard
          label="Best Miner Score"
          value={bestScore !== null ? `${bestScore}/100` : "—"}
          color="#f0c040"
        />
        <StatCard
          label="Architecture"
          value="784→128→64→10"
          color="#b07fff"
        />
      </div>

      <div style={S.layout}>
        {/* ── Left column: accuracy chart + recent blocks ─────────────── */}
        <div style={S.leftCol}>
          <div style={S.card}>
            <div style={S.cardTitle}>Global Accuracy Over Blocks</div>
            {chartData.length === 0 ? (
              <div style={S.empty}>
                No data yet — accuracy updates after each block is finalized.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={chartData}
                  margin={{ top: 8, right: 12, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e1e30" />
                  <XAxis
                    dataKey="entryNum"
                    tick={{ fill: "#555", fontSize: 9 }}
                    interval="preserveStartEnd"
                    label={{ value: "entry", position: "insideBottomRight", offset: -4, fill: "#333", fontSize: 8 }}
                  />
                  <YAxis
                    domain={[yMin, 100]}
                    tick={{ fill: "#555", fontSize: 9 }}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "#0e0e1a", border: "1px solid #2e3666",
                      borderRadius: 4, fontSize: 11,
                    }}
                    labelStyle={{ color: "#a0b0ff" }}
                    itemStyle={{ color: "#3ddc84" }}
                    labelFormatter={(label, payload) => {
                      const taskLabel = payload?.[0]?.payload?.taskLabel ?? "";
                      return `Entry ${label}${taskLabel ? `  ·  Block ${taskLabel}` : ""}`;
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="accuracy"
                    stroke="#3ddc84"
                    strokeWidth={2}
                    dot={false}
                    connectNulls={false}
                    activeDot={{ r: 4, fill: "#3ddc84" }}
                    name="Accuracy %"
                  />
                  <Line
                    type="monotone"
                    dataKey="winnerScore"
                    stroke="#a0b0ff"
                    strokeWidth={1.5}
                    strokeDasharray="4 2"
                    dot={false}
                    connectNulls={false}
                    name="Winner Score"
                  />
                  {resetPoints.map((x) => (
                    <ReferenceLine
                      key={x}
                      x={x}
                      stroke="#f0c040"
                      strokeDasharray="4 2"
                      label={{ value: "Reset", position: "insideTopRight", fill: "#f0c040", fontSize: 8 }}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            )}
            <div style={S.chartLegend}>
              <span style={{ color: "#3ddc84" }}>— global accuracy %</span>
              <span style={{ color: "#a0b0ff" }}>- - winner score</span>
            </div>
          </div>

          {/* Recent blocks table */}
          <div style={S.card}>
            <div style={S.cardTitle}>Recent Blocks</div>
            {dataEntries.length === 0 ? (
              <div style={S.empty}>No blocks finalized yet.</div>
            ) : (
              <table style={S.table}>
                <thead>
                  <tr>
                    {["Block", "Global Acc", "Score", "Winner Score"].map((h) => (
                      <th key={h} style={S.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...dataEntries].reverse().slice(0, 10).map((row) => (
                    <tr key={row.task_id} style={S.tr}>
                      <td style={S.td}>#{row.task_id}</td>
                      <td style={{ ...S.td, color: "#3ddc84" }}>
                        {(row.accuracy * 100).toFixed(1)}%
                      </td>
                      <td style={S.td}>{row.score}/100</td>
                      <td style={{ ...S.td, color: "#f0c040" }}>
                        {row.winner_score}/100
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* ── Right column: digit recognizer ──────────────────────────── */}
        <div style={S.rightCol}>
          <div style={S.card}>
            <div style={S.cardTitle}>Live Digit Recognition</div>

            <DigitCanvas onPredict={handlePredict} predicting={predicting} />

            {predErr && <div style={S.errMsg}>{predErr}</div>}

            {prediction && (
              <div style={S.predResult}>
                <div style={S.predDigit}>{prediction.digit}</div>
                <div style={S.predConf}>
                  {(prediction.confidence * 100).toFixed(1)}% confidence
                </div>
                <div style={S.barsLabel}>All digit probabilities:</div>
                <div style={S.barsContainer}>
                  {prediction.confidences.map((p, i) => (
                    <ConfidenceBar
                      key={i}
                      digit={i}
                      prob={p}
                      isTop={i === prediction.digit}
                    />
                  ))}
                </div>
              </div>
            )}

            <div style={S.modelNote}>
              Using the global FedAvg model aggregated from all 4 miners'
              MNIST shards. The model improves every block as new rounds
              of federated training complete.
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

  warn: {
    background: "#1a0e08", border: "1px solid #4a2a10", borderRadius: 6,
    padding: "10px 16px", color: "#f0a040", fontSize: 12, marginBottom: 20,
  },
  code: { fontFamily: "monospace", color: "#888", fontSize: 11 },

  statsRow: {
    display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap",
  },
  statCard: {
    flex: "1 1 140px",
    background: "#0e0e1a", border: "1px solid #1e1e30", borderRadius: 6,
    padding: "14px 16px",
  },
  statValue: { fontSize: 22, fontWeight: "bold", fontFamily: "monospace" },
  statLabel: { fontSize: 10, color: "#555", marginTop: 4, letterSpacing: 0.5, textTransform: "uppercase" },

  layout:   { display: "flex", gap: 16, alignItems: "flex-start" },
  leftCol:  { flex: 1, display: "flex", flexDirection: "column", gap: 16, minWidth: 0 },
  rightCol: { width: 320, flexShrink: 0 },

  card: {
    background: "#0e0e1a", border: "1px solid #1e1e30", borderRadius: 6,
    padding: "18px 20px",
  },
  cardTitle: {
    fontSize: 11, color: "#555", letterSpacing: 1.5, textTransform: "uppercase",
    marginBottom: 14, fontFamily: "monospace",
  },

  empty: { color: "#333", fontStyle: "italic", fontSize: 11, padding: "20px 0" },

  chartLegend: {
    display: "flex", gap: 16, marginTop: 10,
    fontSize: 9, color: "#555", fontFamily: "monospace",
  },

  table:  { width: "100%", borderCollapse: "collapse" },
  th:     { fontSize: 9, color: "#444", textAlign: "left", padding: "4px 8px", letterSpacing: 0.5, borderBottom: "1px solid #1a1a2a" },
  tr:     { borderBottom: "1px solid #0e0e18" },
  td:     { fontSize: 11, color: "#888", padding: "6px 8px", fontFamily: "monospace" },

  // Canvas
  canvasWrapper: { display: "flex", flexDirection: "column", alignItems: "center", gap: 10 },
  canvas: {
    cursor: "crosshair",
    border: "1px solid #2e3666",
    borderRadius: 4,
    display: "block",
    touchAction: "none",
  },
  canvasBtns: { display: "flex", gap: 8 },
  clearBtn: {
    background: "#1a1a2a", border: "1px solid #2a2a4a",
    color: "#666", padding: "6px 16px", borderRadius: 4, fontSize: 12,
  },
  predictBtn: {
    background: "#1a2a4a", border: "1px solid #2a3a7a",
    color: "#a0b0ff", padding: "6px 20px", borderRadius: 4, fontSize: 12,
    fontWeight: "bold",
  },
  canvasHint: { fontSize: 9, color: "#333", fontFamily: "monospace" },

  // Prediction result
  errMsg: { color: "#ff6b6b", fontSize: 11, marginTop: 10, textAlign: "center" },

  predResult: {
    marginTop: 16, display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
  },
  predDigit: {
    fontSize: 64, fontWeight: "bold", color: "#a0b0ff", lineHeight: 1,
    fontFamily: "monospace",
  },
  predConf: { fontSize: 13, color: "#3ddc84" },
  barsLabel: { fontSize: 10, color: "#444", alignSelf: "flex-start", marginTop: 8, width: "100%" },
  barsContainer: { width: "100%" },

  confRow: { display: "flex", alignItems: "center", gap: 6, marginBottom: 4 },
  confDigit: { fontSize: 10, fontFamily: "monospace", width: 14, textAlign: "right", flexShrink: 0 },
  confBarBg: { flex: 1, height: 8, background: "#0e0e18", borderRadius: 2, overflow: "hidden" },
  confBarFill: { height: "100%", borderRadius: 2, transition: "width 0.3s" },
  confPct: { fontSize: 9, fontFamily: "monospace", width: 36, textAlign: "right", flexShrink: 0 },

  modelNote: {
    marginTop: 16, fontSize: 9, color: "#333", lineHeight: 1.6,
    borderTop: "1px solid #0e0e18", paddingTop: 12,
  },
};
