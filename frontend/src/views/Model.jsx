import { useEffect, useRef, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import { ADMIN_API, PROVE_SERVER } from "../config";

const CANVAS_SIZE  = 320;   // display canvas (~11.4× MNIST)
const DIGIT_SIZE   = 28;    // actual MNIST resolution

// ---------------------------------------------------------------------------
// Confidence bar (for prediction result)
// ---------------------------------------------------------------------------
function ConfidenceBar({ digit, prob, isTop }) {
  return (
    <div style={S.confRow}>
      <div style={{ ...S.confDigit, color: isTop ? "var(--accent)" : "var(--text-tertiary)" }}>
        {digit}
      </div>
      <div style={S.confBarBg}>
        <div style={{
          ...S.confBarFill,
          width: `${(prob * 100).toFixed(1)}%`,
          background: isTop ? "var(--accent)" : "var(--border-bright)",
          boxShadow: isTop ? "0 0 10px var(--accent-glow-md)" : "none",
        }} />
      </div>
      <div style={{
        ...S.confPct,
        color: isTop ? "var(--accent)" : "var(--text-tertiary)",
      }}>
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
  const [hasInk, setHasInk] = useState(false);

  function getPos(e) {
    const rect = canvasRef.current.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: clientX - rect.left, y: clientY - rect.top };
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
    ctx.lineWidth   = 22;
    ctx.lineCap     = "round";
    ctx.lineJoin    = "round";
    ctx.beginPath();
    ctx.moveTo(lastPos.current.x, lastPos.current.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    lastPos.current = pos;
    setHasInk(true);
  }

  function endDraw() {
    drawing.current = false;
    lastPos.current = null;
  }

  function clearCanvas() {
    const ctx = canvasRef.current.getContext("2d");
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    setHasInk(false);
  }

  function extractPixels() {
    // Step 1: downsample CANVAS_SIZE → 28×28 by averaging blocks
    const ctx   = canvasRef.current.getContext("2d");
    const scale = CANVAS_SIZE / DIGIT_SIZE;
    const raw   = new Float32Array(DIGIT_SIZE * DIGIT_SIZE);
    for (let r = 0; r < DIGIT_SIZE; r++) {
      for (let c = 0; c < DIGIT_SIZE; c++) {
        const px = ctx.getImageData(c * scale, r * scale, scale, scale).data;
        let sum  = 0;
        for (let i = 0; i < px.length; i += 4) sum += px[i];
        raw[r * DIGIT_SIZE + c] = sum / (px.length / 4) / 255;
      }
    }

    // Step 2: bounding box of ink
    let minR = DIGIT_SIZE, maxR = -1, minC = DIGIT_SIZE, maxC = -1;
    for (let r = 0; r < DIGIT_SIZE; r++) {
      for (let c = 0; c < DIGIT_SIZE; c++) {
        if (raw[r * DIGIT_SIZE + c] > 0.05) {
          if (r < minR) minR = r;  if (r > maxR) maxR = r;
          if (c < minC) minC = c;  if (c > maxC) maxC = c;
        }
      }
    }
    if (maxR < 0) return Array.from(raw);

    // Step 3: scale content to fit 20×20 centered in 28×28 (MNIST style)
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

  useEffect(() => { clearCanvas(); }, []);

  function handlePredict() {
    onPredict(extractPixels());
  }

  return (
    <div style={S.canvasWrapper}>
      <div style={S.canvasFrame}>
        <span style={S.canvasCornerTL} />
        <span style={S.canvasCornerTR} />
        <span style={S.canvasCornerBL} />
        <span style={S.canvasCornerBR} />
        {!hasInk && (
          <div style={S.canvasHintOverlay}>
            DRAW A DIGIT
          </div>
        )}
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
      </div>
      <div style={S.canvasMeta}>
        <span style={S.canvasMetaItem}>{CANVAS_SIZE}×{CANVAS_SIZE}px</span>
        <span style={S.canvasMetaSep}>·</span>
        <span style={S.canvasMetaItem}>downsampled to 28×28</span>
        <span style={S.canvasMetaSep}>·</span>
        <span style={S.canvasMetaItem}>MNIST-style centered</span>
      </div>
      <div style={S.canvasBtns}>
        <button style={S.clearBtn} onClick={clearCanvas} disabled={!hasInk}>
          ✕ CLEAR
        </button>
        <button
          style={{ ...S.predictBtn, opacity: predicting || !hasInk ? 0.45 : 1 }}
          onClick={handlePredict}
          disabled={predicting || !hasInk}
        >
          {predicting ? "PREDICTING…" : "▶ PREDICT"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------
export default function Model() {
  const [accuracyLog, setAccuracyLog] = useState([]);
  const [serverUp,    setServerUp]    = useState(null);
  const [prediction,  setPrediction]  = useState(null);
  const [predicting,  setPredicting]  = useState(false);
  const [predErr,     setPredErr]     = useState("");
  const [activeMode,  setActiveMode]  = useState("advanced");

  useEffect(() => {
    fetch(`${ADMIN_API}/api/mode`)
      .then((r) => r.json())
      .then((d) => { if (d.mode) setActiveMode(d.mode); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadHistory() {
      try {
        const r = await fetch(`${ADMIN_API}/api/accuracy?mode=${activeMode}`,
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
  }, [activeMode]);

  useEffect(() => {
    async function poll() {
      try {
        const r = await fetch(`${ADMIN_API}/api/accuracy?mode=${activeMode}`,
          { signal: AbortSignal.timeout(3000) });
        const d = await r.json();
        if (d.ok) {
          setAccuracyLog(d.log || []);
          setServerUp(true);
        }
      } catch { /* non-fatal */ }
    }
    const id = setInterval(poll, 10_000);
    return () => clearInterval(id);
  }, [activeMode]);

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

  // Derived stats
  const dataEntries = accuracyLog.filter((e) => !e.reset);
  const latestAcc   = dataEntries.length > 0
    ? dataEntries[dataEntries.length - 1].accuracy
    : null;
  const bestScore   = dataEntries.length > 0
    ? Math.max(...dataEntries.map((e) => e.winner_score))
    : null;

  const sliceOffset = Math.max(0, accuracyLog.length - 20);
  const chartData   = accuracyLog.slice(-20).map((e, i) => ({
    entryNum:    sliceOffset + i + 1,
    taskLabel:   e.reset ? null : `#${e.task_id}`,
    accuracy:    e.reset ? null : +(e.accuracy * 100).toFixed(2),
    winnerScore: e.reset ? null : (e.winner_score ?? null),
    isReset:     !!e.reset,
  }));

  const resetPoints = chartData.filter((d) => d.isReset).map((d) => d.entryNum);
  const nonResetChart = chartData.filter((d) => !d.isReset);
  const yMin = nonResetChart.length > 0
    ? Math.max(0, Math.floor(Math.min(...nonResetChart.map((d) => d.accuracy)) - 5))
    : 0;

  // Format hero accuracy
  const accInt = latestAcc !== null ? Math.floor(latestAcc * 100) : null;
  const accDec = latestAcc !== null ? Math.round((latestAcc * 100 - accInt) * 10) : null;

  return (
    <div>
      {/* Hero */}
      <div style={S.hero}>
        <div style={S.heroEyebrow}>
          <span style={S.heroEyebrowBar} />
          GLOBAL FEDERATED MODEL
        </div>
        <h1 style={S.heroTitle}>MNIST</h1>
        <p style={S.heroSub}>
          Aggregated from all four miners via FedAvg. The model improves every block as new
          rounds of federated training complete and quality-gated gradient updates are merged.
        </p>
      </div>

      {serverUp === false && (
        <div style={S.warn}>
          ⚠  PROVE SERVER NOT REACHABLE
          <span style={{ marginLeft: 12, color: "var(--text-tertiary)" }}>
            run: <code style={S.code}>npm run prove-server</code>
          </span>
        </div>
      )}

      {/* ── Hero accuracy panel ─────────────────────────────────────── */}
      <div style={S.heroPanel}>
        <div style={S.heroAccLeft}>
          <div style={S.heroAccEyebrow}>
            <span style={S.heroAccDot} />
            GLOBAL ACCURACY
          </div>
          <div style={S.heroAccBig}>
            {accInt !== null ? (
              <>
                <span style={S.heroAccInt}>{accInt}</span>
                <span style={S.heroAccDec}>.{accDec}</span>
                <span style={S.heroAccPct}>%</span>
              </>
            ) : (
              <span style={{ ...S.heroAccInt, color: "var(--text-faint)" }}>—</span>
            )}
          </div>
          <div style={S.heroAccSub}>
            evaluated on 2,000 held-out test samples
          </div>
        </div>

        <div style={S.heroAccRight}>
          <div style={S.miniStat}>
            <div style={S.miniStatLabel}>BLOCKS</div>
            <div style={S.miniStatVal}>
              {String(dataEntries.length || 0).padStart(3, "0")}
            </div>
          </div>
          <div style={S.miniStatSep} />
          <div style={S.miniStat}>
            <div style={S.miniStatLabel}>BEST SCORE</div>
            <div style={S.miniStatVal}>
              {bestScore !== null ? `${bestScore}` : "—"}
              {bestScore !== null && <span style={S.miniStatUnit}>/100</span>}
            </div>
          </div>
          <div style={S.miniStatSep} />
          <div style={S.miniStat}>
            <div style={S.miniStatLabel}>ARCHITECTURE</div>
            <div style={S.miniStatArchVal}>784→128→64→10</div>
          </div>
        </div>
      </div>

      {/* ── Two-column layout: chart + canvas ───────────────────────── */}
      <div style={S.layout}>
        {/* LEFT: chart + table */}
        <div style={S.leftCol}>
          <div style={S.card}>
            <div style={S.cardHead}>
              <div style={S.cardTitle}>Accuracy over blocks</div>
              <div style={S.cardChips}>
                <span style={S.legendChip}>
                  <span style={{ ...S.legendDot, background: "var(--accent)" }} /> ACCURACY
                </span>
                <span style={S.legendChip}>
                  <span style={{ ...S.legendDot, background: "var(--text-tertiary)", border: "1px dashed var(--text-secondary)" }} /> WINNER
                </span>
              </div>
            </div>
            {chartData.length === 0 ? (
              <div style={S.empty}>No data yet — accuracy updates after each block is finalized.</div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={chartData} margin={{ top: 12, right: 12, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis
                    dataKey="entryNum"
                    tick={{ fill: "var(--text-tertiary)", fontSize: 9, fontFamily: "var(--font-mono)" }}
                    interval="preserveStartEnd"
                    stroke="var(--border)"
                  />
                  <YAxis
                    domain={[yMin, 100]}
                    tick={{ fill: "var(--text-tertiary)", fontSize: 9, fontFamily: "var(--font-mono)" }}
                    stroke="var(--border)"
                  />
                  <Tooltip
                    contentStyle={{
                      background: "var(--bg-elevated)",
                      border: "1px solid var(--accent-deep)",
                      borderRadius: 6,
                      fontSize: 11,
                      fontFamily: "var(--font-mono)",
                    }}
                    labelStyle={{ color: "var(--text-tertiary)" }}
                    itemStyle={{ color: "var(--accent)" }}
                    labelFormatter={(label, payload) => {
                      const taskLabel = payload?.[0]?.payload?.taskLabel ?? "";
                      return `ENTRY ${label}${taskLabel ? `  ·  BLOCK ${taskLabel}` : ""}`;
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="accuracy"
                    stroke="var(--accent)"
                    strokeWidth={2.5}
                    dot={false}
                    connectNulls={false}
                    activeDot={{ r: 5, fill: "var(--accent)", stroke: "var(--bg-base)", strokeWidth: 2 }}
                    name="Accuracy %"
                  />
                  <Line
                    type="monotone"
                    dataKey="winnerScore"
                    stroke="var(--text-tertiary)"
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                    dot={false}
                    connectNulls={false}
                    name="Winner Score"
                  />
                  {resetPoints.map((x) => (
                    <ReferenceLine
                      key={x}
                      x={x}
                      stroke="var(--warn)"
                      strokeDasharray="3 3"
                      label={{ value: "RESET", position: "insideTopRight", fill: "var(--warn)", fontSize: 8, fontFamily: "var(--font-mono)" }}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>

          <div style={S.card}>
            <div style={S.cardHead}>
              <div style={S.cardTitle}>Recent blocks</div>
              <div style={S.cardChip}>{dataEntries.length} TOTAL</div>
            </div>
            {dataEntries.length === 0 ? (
              <div style={S.empty}>No blocks finalized yet.</div>
            ) : (
              <table style={S.table}>
                <thead>
                  <tr>
                    {["BLOCK", "GLOBAL ACC", "SCORE", "WINNER"].map((h) => (
                      <th key={h} style={S.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...dataEntries].reverse().slice(0, 10).map((row) => (
                    <tr key={row.task_id} style={S.tr}>
                      <td style={S.td}>#{String(row.task_id).padStart(2, "0")}</td>
                      <td style={{ ...S.td, color: "var(--accent)" }}>
                        {(row.accuracy * 100).toFixed(1)}%
                      </td>
                      <td style={S.td}>{row.score}/100</td>
                      <td style={{ ...S.td, color: "var(--text-secondary)" }}>
                        {row.winner_score}/100
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* RIGHT: digit recognizer */}
        <div style={S.rightCol}>
          <div style={S.card}>
            <div style={S.cardHead}>
              <div style={S.cardTitle}>Live inference</div>
              <div style={S.cardChip}>POST /predict</div>
            </div>

            <DigitCanvas onPredict={handlePredict} predicting={predicting} />

            {predErr && <div style={S.errMsg}>{predErr}</div>}

            {prediction && (
              <div style={S.predResult}>
                <div style={S.predLabel}>PREDICTION</div>
                <div style={S.predDigit}>{prediction.digit}</div>
                <div style={S.predConf}>
                  {(prediction.confidence * 100).toFixed(1)}% CONFIDENCE
                </div>
                <div style={S.barsLabel}>ALL DIGIT PROBABILITIES</div>
                <div style={S.barsContainer}>
                  {prediction.confidences.map((p, i) => (
                    <ConfidenceBar key={i} digit={i} prob={p} isTop={i === prediction.digit} />
                  ))}
                </div>
              </div>
            )}

            <div style={S.modelNote}>
              Inference uses the global FedAvg model aggregated from all 4 miners' MNIST shards.
              The model improves every block as new rounds of federated training complete.
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
  // ── Hero ──
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

  // ── Hero accuracy panel ──
  heroPanel: {
    display: "grid",
    gridTemplateColumns: "1.5fr 1fr",
    gap: 0,
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-xl)",
    overflow: "hidden",
    marginBottom: 24,
    position: "relative",
  },
  heroAccLeft: {
    padding: "36px 40px 32px",
    borderRight: "1px solid var(--border)",
    position: "relative",
  },
  heroAccEyebrow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    color: "var(--text-tertiary)",
    letterSpacing: "0.18em",
    textTransform: "uppercase",
    marginBottom: 18,
  },
  heroAccDot: {
    width: 8, height: 8, borderRadius: "50%",
    background: "var(--accent)",
    boxShadow: "0 0 12px var(--accent)",
    animation: "pulse-glow 2.4s ease-in-out infinite",
  },
  heroAccBig: {
    display: "flex",
    alignItems: "baseline",
    fontFamily: "var(--font-mono)",
    fontWeight: 600,
    color: "var(--accent)",
    lineHeight: 0.85,
    fontVariantNumeric: "tabular-nums",
    textShadow: "0 0 48px var(--accent-glow-md)",
  },
  heroAccInt: {
    fontSize: 124,
    letterSpacing: "-0.04em",
  },
  heroAccDec: {
    fontSize: 56,
    letterSpacing: "-0.03em",
    color: "var(--accent-bright)",
    opacity: 0.7,
  },
  heroAccPct: {
    fontSize: 36,
    color: "var(--accent-dim)",
    marginLeft: 8,
    fontWeight: 500,
  },
  heroAccSub: {
    marginTop: 16,
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    color: "var(--text-tertiary)",
    letterSpacing: "0.04em",
  },

  heroAccRight: {
    padding: "36px 40px",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    gap: 0,
  },
  miniStat: { padding: "10px 0" },
  miniStatSep: { height: 1, background: "var(--border)" },
  miniStatLabel: {
    fontFamily: "var(--font-mono)",
    fontSize: 9,
    color: "var(--text-tertiary)",
    letterSpacing: "0.16em",
    marginBottom: 6,
  },
  miniStatVal: {
    fontFamily: "var(--font-mono)",
    fontSize: 26,
    fontWeight: 600,
    color: "var(--text-primary)",
    lineHeight: 1,
    fontVariantNumeric: "tabular-nums",
    letterSpacing: "-0.02em",
    display: "flex",
    alignItems: "baseline",
    gap: 3,
  },
  miniStatUnit: {
    fontSize: 12,
    color: "var(--text-dim)",
  },
  miniStatArchVal: {
    fontFamily: "var(--font-mono)",
    fontSize: 16,
    fontWeight: 500,
    color: "var(--text-primary)",
    lineHeight: 1,
    letterSpacing: "0.02em",
  },

  warn: {
    background: "rgba(255, 184, 77, 0.06)",
    border: "1px solid rgba(255, 184, 77, 0.3)",
    borderRadius: "var(--radius-sm)",
    padding: "12px 18px",
    color: "var(--warn)",
    fontSize: 11,
    fontFamily: "var(--font-mono)",
    marginBottom: 20,
    letterSpacing: "0.04em",
  },
  code: {
    fontFamily: "var(--font-mono)",
    color: "var(--text-secondary)",
    background: "var(--bg-inset)",
    padding: "2px 6px",
    borderRadius: 3,
    fontSize: 11,
  },

  // ── Layout ──
  layout: {
    display: "grid",
    gridTemplateColumns: "1.4fr 1fr",
    gap: 16,
    alignItems: "flex-start",
  },
  leftCol: { display: "flex", flexDirection: "column", gap: 16, minWidth: 0 },
  rightCol: { display: "flex", flexDirection: "column", gap: 16 },

  card: {
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-lg)",
    padding: "22px 24px 20px",
  },
  cardHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 18,
  },
  cardTitle: {
    fontFamily: "var(--font-sans)",
    fontSize: 14,
    fontWeight: 600,
    color: "var(--text-primary)",
    letterSpacing: "-0.01em",
  },
  cardChip: {
    fontFamily: "var(--font-mono)",
    fontSize: 9,
    color: "var(--text-tertiary)",
    letterSpacing: "0.14em",
    border: "1px solid var(--border)",
    padding: "3px 8px",
    borderRadius: 3,
  },
  cardChips: { display: "flex", gap: 10 },
  legendChip: {
    fontFamily: "var(--font-mono)",
    fontSize: 9,
    color: "var(--text-tertiary)",
    letterSpacing: "0.14em",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
  },
  legendDot: {
    display: "inline-block",
    width: 10, height: 2,
  },

  empty: {
    color: "var(--text-dim)",
    fontStyle: "italic",
    fontSize: 11,
    padding: "24px 0",
    fontFamily: "var(--font-mono)",
    textAlign: "center",
  },

  // Table
  table: { width: "100%", borderCollapse: "collapse" },
  th: {
    fontFamily: "var(--font-mono)",
    fontSize: 9,
    color: "var(--text-tertiary)",
    textAlign: "left",
    padding: "6px 10px",
    letterSpacing: "0.14em",
    borderBottom: "1px solid var(--border)",
    fontWeight: 500,
  },
  tr: { borderBottom: "1px solid var(--border-dim)" },
  td: {
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    color: "var(--text-secondary)",
    padding: "10px 10px",
    fontVariantNumeric: "tabular-nums",
  },

  // ── Canvas ──
  canvasWrapper: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 14,
  },
  canvasFrame: {
    position: "relative",
    width: CANVAS_SIZE,
    height: CANVAS_SIZE,
    background: "var(--bg-inset)",
    border: "1px solid var(--border-strong)",
    borderRadius: "var(--radius-md)",
    overflow: "hidden",
    boxShadow: "inset 0 0 40px rgba(0, 0, 0, 0.6), 0 0 24px rgba(0, 245, 255, 0.04)",
  },
  canvasCornerTL: {
    position: "absolute", top: -1, left: -1,
    width: 18, height: 18,
    borderTop: "1px solid var(--accent)",
    borderLeft: "1px solid var(--accent)",
    boxShadow: "0 0 8px var(--accent-glow-md)",
    pointerEvents: "none",
  },
  canvasCornerTR: {
    position: "absolute", top: -1, right: -1,
    width: 18, height: 18,
    borderTop: "1px solid var(--accent)",
    borderRight: "1px solid var(--accent)",
    boxShadow: "0 0 8px var(--accent-glow-md)",
    pointerEvents: "none",
  },
  canvasCornerBL: {
    position: "absolute", bottom: -1, left: -1,
    width: 18, height: 18,
    borderBottom: "1px solid var(--accent)",
    borderLeft: "1px solid var(--accent)",
    boxShadow: "0 0 8px var(--accent-glow-md)",
    pointerEvents: "none",
  },
  canvasCornerBR: {
    position: "absolute", bottom: -1, right: -1,
    width: 18, height: 18,
    borderBottom: "1px solid var(--accent)",
    borderRight: "1px solid var(--accent)",
    boxShadow: "0 0 8px var(--accent-glow-md)",
    pointerEvents: "none",
  },
  canvasHintOverlay: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "var(--font-mono)",
    fontSize: 13,
    letterSpacing: "0.24em",
    color: "var(--text-faint)",
    pointerEvents: "none",
    userSelect: "none",
  },
  canvas: {
    cursor: "crosshair",
    display: "block",
    touchAction: "none",
    position: "relative",
    zIndex: 1,
  },
  canvasMeta: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontFamily: "var(--font-mono)",
    fontSize: 9,
    color: "var(--text-tertiary)",
    letterSpacing: "0.08em",
  },
  canvasMetaItem: { color: "var(--text-tertiary)" },
  canvasMetaSep: { color: "var(--text-faint)" },
  canvasBtns: {
    display: "flex",
    gap: 10,
    width: "100%",
  },
  clearBtn: {
    flex: 1,
    background: "var(--bg-inset)",
    border: "1px solid var(--border)",
    color: "var(--text-tertiary)",
    padding: "11px 18px",
    borderRadius: "var(--radius-sm)",
    fontSize: 11,
    fontFamily: "var(--font-mono)",
    letterSpacing: "0.12em",
    cursor: "pointer",
    transition: "all 200ms var(--ease-out)",
  },
  predictBtn: {
    flex: 2,
    background: "var(--accent)",
    border: "1px solid var(--accent)",
    color: "var(--bg-base)",
    padding: "11px 18px",
    borderRadius: "var(--radius-sm)",
    fontSize: 11,
    fontFamily: "var(--font-mono)",
    fontWeight: 600,
    letterSpacing: "0.12em",
    cursor: "pointer",
    boxShadow: "0 0 28px var(--accent-glow-md)",
    transition: "all 200ms var(--ease-out)",
  },

  // Prediction result
  errMsg: {
    color: "#ff7a8e",
    fontSize: 11,
    marginTop: 14,
    textAlign: "center",
    fontFamily: "var(--font-mono)",
  },
  predResult: {
    marginTop: 22,
    paddingTop: 22,
    borderTop: "1px solid var(--border)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
  },
  predLabel: {
    fontFamily: "var(--font-mono)",
    fontSize: 9,
    color: "var(--text-tertiary)",
    letterSpacing: "0.18em",
    marginBottom: 4,
  },
  predDigit: {
    fontFamily: "var(--font-sans)",
    fontSize: 96,
    fontWeight: 800,
    color: "var(--accent)",
    lineHeight: 0.95,
    letterSpacing: "-0.04em",
    textShadow: "0 0 48px var(--accent-glow-lg)",
    marginBottom: 6,
  },
  predConf: {
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    color: "var(--text-secondary)",
    letterSpacing: "0.12em",
    marginBottom: 16,
  },
  barsLabel: {
    fontFamily: "var(--font-mono)",
    fontSize: 9,
    color: "var(--text-tertiary)",
    letterSpacing: "0.16em",
    alignSelf: "flex-start",
    marginBottom: 8,
    width: "100%",
  },
  barsContainer: { width: "100%" },

  confRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 6,
  },
  confDigit: {
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    width: 14,
    textAlign: "right",
    flexShrink: 0,
    fontWeight: 600,
  },
  confBarBg: {
    flex: 1,
    height: 8,
    background: "var(--bg-inset)",
    borderRadius: 1,
    overflow: "hidden",
    border: "1px solid var(--border-dim)",
  },
  confBarFill: {
    height: "100%",
    transition: "width 320ms var(--ease-out)",
  },
  confPct: {
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    width: 42,
    textAlign: "right",
    flexShrink: 0,
    fontVariantNumeric: "tabular-nums",
  },

  modelNote: {
    marginTop: 18,
    paddingTop: 14,
    borderTop: "1px solid var(--border-dim)",
    fontSize: 11,
    color: "var(--text-tertiary)",
    lineHeight: 1.6,
    fontFamily: "var(--font-sans)",
  },
};
