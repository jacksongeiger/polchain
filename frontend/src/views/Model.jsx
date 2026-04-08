import { useEffect, useRef, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Brush, Area, ComposedChart,
} from "recharts";
import { ADMIN_API, PROVE_SERVER } from "../config";

const CANVAS_SIZE  = 260;   // compact canvas to fit dashboard grid
const DIGIT_SIZE   = 28;

// ---------------------------------------------------------------------------
// Custom chart tooltip — block number, accuracy, winner score
// ---------------------------------------------------------------------------
function ChartTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const p = payload[0]?.payload;
  if (!p || p.isReset) return null;

  return (
    <div style={S.tooltip}>
      <div style={S.tooltipHead}>
        BLOCK {p.taskLabel || "—"}
      </div>
      <div style={S.tooltipRow}>
        <span style={S.tooltipLabel}>Accuracy</span>
        <span style={{ ...S.tooltipVal, color: "var(--accent)" }}>
          {p.accuracy !== null ? `${p.accuracy.toFixed(2)}%` : "—"}
        </span>
      </div>
      <div style={S.tooltipRow}>
        <span style={S.tooltipLabel}>Winner Score</span>
        <span style={{ ...S.tooltipVal, color: "var(--gold)" }}>
          {p.winnerScore !== null ? `${p.winnerScore}/100` : "—"}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confidence bar
// ---------------------------------------------------------------------------
function ConfidenceBar({ digit, prob, isTop }) {
  return (
    <div style={S.confRow}>
      <div style={{ ...S.confDigit, color: isTop ? "var(--success)" : "var(--text-tertiary)" }}>
        {digit}
      </div>
      <div style={S.confBarBg}>
        <div style={{
          ...S.confBarFill,
          width: `${(prob * 100).toFixed(1)}%`,
          background: isTop ? "var(--success)" : "var(--border-bright)",
          boxShadow: isTop ? "0 0 10px var(--success-glow-md)" : "none",
        }} />
      </div>
      <div style={{
        ...S.confPct,
        color: isTop ? "var(--success)" : "var(--text-tertiary)",
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
    ctx.lineWidth   = 18;
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
          <div style={S.canvasHintOverlay}>DRAW A DIGIT</div>
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

  // Use the FULL accuracy log for the chart so the brush can scrub through history
  const chartData = accuracyLog.map((e, i) => ({
    entryNum:    i + 1,
    taskLabel:   e.reset ? null : `${e.task_id}`,
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

  // Default brush window: last 20 entries
  const brushStart = Math.max(0, chartData.length - 20);
  const brushEnd   = Math.max(0, chartData.length - 1);

  return (
    <div>
      {/* ── Compact hero with accuracy + mini-stats inline ──────────────── */}
      <div style={S.heroBar}>
        <div style={S.heroLeft}>
          <div style={S.heroEyebrow}>
            <span style={S.heroEyebrowBar} />
            GLOBAL FEDERATED MODEL
          </div>
          <h1 style={S.heroTitle}>MNIST</h1>
        </div>

        <div style={S.heroAccBox}>
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
        </div>

        <div style={S.heroMini}>
          <div style={S.miniStat}>
            <div style={S.miniStatLabel}>BLOCKS</div>
            <div style={S.miniStatVal}>{String(dataEntries.length || 0).padStart(3, "0")}</div>
          </div>
          <div style={S.miniStat}>
            <div style={S.miniStatLabel}>BEST SCORE</div>
            <div style={S.miniStatVal}>
              {bestScore !== null ? `${bestScore}` : "—"}
            </div>
          </div>
          <div style={S.miniStat}>
            <div style={S.miniStatLabel}>ARCHITECTURE</div>
            <div style={S.miniStatArchVal}>784→128→64→10</div>
          </div>
        </div>
      </div>

      {serverUp === false && (
        <div style={S.warn}>
          ⚠  PROVE SERVER NOT REACHABLE
          <span style={{ marginLeft: 12, color: "var(--text-tertiary)" }}>
            run: <code style={S.code}>npm run prove-server</code>
          </span>
        </div>
      )}

      {/* ── Dashboard grid: chart + canvas (above the fold) ─────────── */}
      <div style={S.dashGrid}>
        {/* LEFT: large interactive chart */}
        <div style={{ ...S.card, ...S.chartCard }}>
          <div style={S.cardHead}>
            <div style={S.cardTitle}>Accuracy over blocks</div>
            <div style={S.cardChips}>
              <span style={S.legendChip}>
                <span style={{ ...S.legendDot, background: "var(--accent)" }} /> ACCURACY
              </span>
              <span style={S.legendChip}>
                <span style={{ ...S.legendDot, background: "var(--gold)" }} /> WINNER
              </span>
              <span style={S.cardChip}>{dataEntries.length} BLOCKS</span>
            </div>
          </div>
          {chartData.length === 0 ? (
            <div style={S.empty}>No data yet — accuracy updates after each block is finalized.</div>
          ) : (
            <ResponsiveContainer width="100%" height={340}>
              <ComposedChart data={chartData} margin={{ top: 16, right: 16, left: -8, bottom: 0 }}>
                <defs>
                  <linearGradient id="accGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"   stopColor="var(--accent)" stopOpacity="0.28" />
                    <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis
                  dataKey="entryNum"
                  tick={{ fill: "var(--text-tertiary)", fontSize: 10, fontFamily: "var(--font-mono)" }}
                  interval="preserveStartEnd"
                  stroke="var(--border)"
                />
                <YAxis
                  domain={[yMin, 100]}
                  tick={{ fill: "var(--text-tertiary)", fontSize: 10, fontFamily: "var(--font-mono)" }}
                  stroke="var(--border)"
                  width={40}
                />
                <Tooltip content={<ChartTooltip />} cursor={{ stroke: "var(--accent)", strokeWidth: 1, strokeDasharray: "3 3" }} />
                <Area
                  type="monotone"
                  dataKey="accuracy"
                  stroke="none"
                  fill="url(#accGradient)"
                  connectNulls={false}
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
                  stroke="var(--gold)"
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
                    label={{ value: "RESET", position: "insideTopRight", fill: "var(--warn)", fontSize: 9, fontFamily: "var(--font-mono)" }}
                  />
                ))}
                <Brush
                  dataKey="entryNum"
                  height={24}
                  stroke="var(--border-strong)"
                  fill="var(--bg-inset)"
                  travellerWidth={8}
                  startIndex={brushStart}
                  endIndex={brushEnd}
                  tickFormatter={(v) => `#${v}`}
                />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* RIGHT: digit recognizer */}
        <div style={{ ...S.card, ...S.canvasCard }}>
          <div style={S.cardHead}>
            <div style={S.cardTitle}>Live inference</div>
            <div style={S.cardChip}>POST /predict</div>
          </div>

          <DigitCanvas onPredict={handlePredict} predicting={predicting} />

          {predErr && <div style={S.errMsg}>{predErr}</div>}

          {prediction ? (
            <div style={S.predResult}>
              <div style={S.predTopRow}>
                <div>
                  <div style={S.predLabel}>PREDICTED DIGIT</div>
                  <div style={S.predDigit}>{prediction.digit}</div>
                </div>
                <div style={S.predConfBox}>
                  <div style={S.predLabel}>CONFIDENCE</div>
                  <div style={S.predConfVal}>
                    {(prediction.confidence * 100).toFixed(1)}<span style={S.predConfPct}>%</span>
                  </div>
                </div>
              </div>
              <div style={S.barsLabel}>ALL DIGIT PROBABILITIES</div>
              <div style={S.barsContainer}>
                {prediction.confidences.map((p, i) => (
                  <ConfidenceBar key={i} digit={i} prob={p} isTop={i === prediction.digit} />
                ))}
              </div>
            </div>
          ) : (
            <div style={S.predPlaceholder}>
              <div style={S.predLabel}>AWAITING INPUT</div>
              <div style={S.predPlaceholderText}>
                Draw a digit above and tap PREDICT to run inference on the global FedAvg model.
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Recent blocks panel — compact, scrollable ──────────────── */}
      <div style={{ ...S.card, marginTop: 16 }}>
        <div style={S.cardHead}>
          <div style={S.cardTitle}>Recent blocks</div>
          <div style={S.cardChip}>{dataEntries.length} TOTAL</div>
        </div>
        {dataEntries.length === 0 ? (
          <div style={S.empty}>No blocks finalized yet.</div>
        ) : (
          <div style={S.tableScroll}>
            <table style={S.table}>
              <thead style={S.thead}>
                <tr>
                  {["BLOCK", "GLOBAL ACCURACY", "SHARD SCORE", "WINNER SCORE", "Δ ACCURACY"].map((h) => (
                    <th key={h} style={S.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...dataEntries].reverse().map((row, idx, arr) => {
                  const prev = arr[idx + 1];
                  const delta = prev ? (row.accuracy - prev.accuracy) * 100 : null;
                  return (
                    <tr key={row.task_id} style={idx % 2 === 0 ? S.tr : S.trAlt}>
                      <td style={{ ...S.td, color: "var(--text-primary)" }}>
                        #{String(row.task_id).padStart(2, "0")}
                      </td>
                      <td style={{ ...S.td, color: "var(--accent)" }}>
                        {(row.accuracy * 100).toFixed(2)}%
                      </td>
                      <td style={S.td}>{row.score}/100</td>
                      <td style={{ ...S.td, color: "var(--gold)" }}>{row.winner_score}/100</td>
                      <td style={S.td}>
                        {delta === null ? "—" : (
                          <span style={{
                            color: delta > 0 ? "var(--success)" : delta < 0 ? "#ff7a8e" : "var(--text-tertiary)",
                          }}>
                            {delta > 0 ? "+" : ""}{delta.toFixed(2)}%
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const S = {
  // ── Hero bar — compact horizontal layout ──
  heroBar: {
    display: "grid",
    gridTemplateColumns: "auto 1fr auto",
    gap: 28,
    alignItems: "center",
    padding: "20px 24px",
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-xl)",
    marginBottom: 20,
    overflow: "hidden",
  },
  heroLeft: { display: "flex", flexDirection: "column", gap: 0 },
  heroEyebrow: {
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    fontWeight: 500,
    letterSpacing: "0.18em",
    textTransform: "uppercase",
    color: "var(--text-tertiary)",
    marginBottom: 8,
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  heroEyebrowBar: {
    width: 22, height: 1,
    background: "var(--accent)",
    boxShadow: "0 0 8px var(--accent)",
  },
  heroTitle: {
    fontFamily: "var(--font-sans)",
    fontSize: 44,                            // page title
    fontWeight: 800,
    letterSpacing: "-0.04em",
    color: "var(--text-primary)",
    lineHeight: 0.95,
    margin: 0,
  },

  // ── Hero accuracy box — center column, the page hero number ──
  heroAccBox: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 8,
    padding: "0 28px",
    borderLeft: "1px solid var(--border)",
    borderRight: "1px solid var(--border)",
  },
  heroAccEyebrow: {
    display: "flex",
    alignItems: "center",
    gap: 9,
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    color: "var(--text-tertiary)",
    letterSpacing: "0.18em",
    textTransform: "uppercase",
  },
  heroAccDot: {
    width: 7, height: 7, borderRadius: "50%",
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
    textShadow: "0 0 36px var(--accent-glow-md)",
  },
  heroAccInt: {
    fontSize: 96,                            // PAGE HERO
    letterSpacing: "-0.04em",
  },
  heroAccDec: {
    fontSize: 44,
    letterSpacing: "-0.03em",
    color: "var(--accent-bright)",
    opacity: 0.7,
  },
  heroAccPct: {
    fontSize: 28,
    color: "var(--accent-dim)",
    marginLeft: 6,
    fontWeight: 500,
  },

  // ── Hero mini stats — right column ──
  heroMini: {
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  miniStat: {},
  miniStatLabel: {
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    color: "var(--text-tertiary)",
    letterSpacing: "0.16em",
    marginBottom: 4,
    textTransform: "uppercase",
  },
  miniStatVal: {
    fontFamily: "var(--font-mono)",
    fontSize: 24,                            // card primary
    fontWeight: 600,
    color: "var(--text-primary)",
    lineHeight: 1,
    fontVariantNumeric: "tabular-nums",
    letterSpacing: "-0.02em",
  },
  miniStatArchVal: {
    fontFamily: "var(--font-mono)",
    fontSize: 14,
    fontWeight: 500,
    color: "var(--text-primary)",
    lineHeight: 1,
    letterSpacing: "0.02em",
  },

  warn: {
    background: "rgba(255, 184, 77, 0.06)",
    border: "1px solid rgba(255, 184, 77, 0.3)",
    borderRadius: "var(--radius-sm)",
    padding: "10px 16px",
    color: "var(--warn)",
    fontSize: 11,
    fontFamily: "var(--font-mono)",
    marginBottom: 16,
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

  // ── Dashboard grid: chart + canvas side by side ──
  dashGrid: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1.55fr) minmax(0, 1fr)",
    gap: 16,
    alignItems: "start",
  },

  card: {
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-lg)",
    padding: "20px 22px 18px",
  },
  chartCard: {},
  canvasCard: {},
  cardHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
    gap: 12,
  },
  cardTitle: {
    fontFamily: "var(--font-sans)",
    fontSize: 16,                            // card secondary
    fontWeight: 600,
    color: "var(--text-primary)",
    letterSpacing: "-0.01em",
  },
  cardChip: {
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    color: "var(--text-tertiary)",
    letterSpacing: "0.14em",
    border: "1px solid var(--border)",
    padding: "3px 9px",
    borderRadius: 3,
  },
  cardChips: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" },
  legendChip: {
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    color: "var(--text-tertiary)",
    letterSpacing: "0.12em",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
  },
  legendDot: {
    display: "inline-block",
    width: 12, height: 2,
  },

  empty: {
    color: "var(--text-dim)",
    fontStyle: "italic",
    fontSize: 11,
    padding: "40px 0",
    fontFamily: "var(--font-mono)",
    textAlign: "center",
  },

  // ── Custom chart tooltip ──
  tooltip: {
    background: "var(--bg-elevated)",
    border: "1px solid var(--accent-deep)",
    borderRadius: "var(--radius-md)",
    padding: "10px 14px",
    fontFamily: "var(--font-mono)",
    boxShadow: "0 8px 28px rgba(0, 0, 0, 0.6), 0 0 24px var(--accent-glow)",
    minWidth: 180,
  },
  tooltipHead: {
    fontSize: 11,
    color: "var(--text-tertiary)",
    letterSpacing: "0.16em",
    marginBottom: 8,
    paddingBottom: 6,
    borderBottom: "1px solid var(--border)",
  },
  tooltipRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: 16,
    fontSize: 11,
    margin: "4px 0",
  },
  tooltipLabel: {
    color: "var(--text-tertiary)",
    letterSpacing: "0.04em",
  },
  tooltipVal: {
    fontWeight: 600,
    fontVariantNumeric: "tabular-nums",
  },

  // ── Recent blocks table ──
  tableScroll: {
    maxHeight: 240,
    overflowY: "auto",
    borderRadius: "var(--radius-sm)",
  },
  table: { width: "100%", borderCollapse: "collapse" },
  thead: { position: "sticky", top: 0, background: "var(--bg-elevated)", zIndex: 1 },
  th: {
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    color: "var(--text-tertiary)",
    textAlign: "left",
    padding: "8px 12px",
    letterSpacing: "0.14em",
    borderBottom: "1px solid var(--border)",
    fontWeight: 500,
  },
  tr: {
    background: "transparent",
  },
  trAlt: {
    background: "rgba(255, 255, 255, 0.012)",
  },
  td: {
    fontFamily: "var(--font-mono)",
    fontSize: 13,
    color: "var(--text-secondary)",
    padding: "10px 12px",
    fontVariantNumeric: "tabular-nums",
    borderBottom: "1px solid var(--border-dim)",
  },

  // ── Canvas ──
  canvasWrapper: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 12,
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
    width: 16, height: 16,
    borderTop: "1px solid var(--accent)",
    borderLeft: "1px solid var(--accent)",
    boxShadow: "0 0 8px var(--accent-glow-md)",
    pointerEvents: "none",
  },
  canvasCornerTR: {
    position: "absolute", top: -1, right: -1,
    width: 16, height: 16,
    borderTop: "1px solid var(--accent)",
    borderRight: "1px solid var(--accent)",
    boxShadow: "0 0 8px var(--accent-glow-md)",
    pointerEvents: "none",
  },
  canvasCornerBL: {
    position: "absolute", bottom: -1, left: -1,
    width: 16, height: 16,
    borderBottom: "1px solid var(--accent)",
    borderLeft: "1px solid var(--accent)",
    boxShadow: "0 0 8px var(--accent-glow-md)",
    pointerEvents: "none",
  },
  canvasCornerBR: {
    position: "absolute", bottom: -1, right: -1,
    width: 16, height: 16,
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
    padding: "10px 16px",
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
    padding: "10px 16px",
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
    marginTop: 12,
    textAlign: "center",
    fontFamily: "var(--font-mono)",
  },
  predResult: {
    marginTop: 16,
    paddingTop: 16,
    borderTop: "1px solid var(--border)",
  },
  predTopRow: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 16,
    marginBottom: 14,
  },
  predLabel: {
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    color: "var(--text-tertiary)",
    letterSpacing: "0.16em",
    marginBottom: 4,
  },
  predDigit: {
    fontFamily: "var(--font-sans)",
    fontSize: 72,                            // page hero range
    fontWeight: 800,
    color: "var(--success)",                 // verified result → green
    lineHeight: 0.95,
    letterSpacing: "-0.04em",
    textShadow: "0 0 36px var(--success-glow-lg)",
  },
  predConfBox: {
    textAlign: "right",
  },
  predConfVal: {
    fontFamily: "var(--font-mono)",
    fontSize: 28,                            // card primary
    fontWeight: 600,
    color: "var(--text-primary)",
    lineHeight: 1,
    fontVariantNumeric: "tabular-nums",
    letterSpacing: "-0.02em",
  },
  predConfPct: {
    fontSize: 16,
    color: "var(--text-dim)",
    marginLeft: 2,
  },
  barsLabel: {
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    color: "var(--text-tertiary)",
    letterSpacing: "0.16em",
    marginBottom: 8,
  },
  barsContainer: { width: "100%" },

  predPlaceholder: {
    marginTop: 16,
    paddingTop: 16,
    borderTop: "1px solid var(--border)",
  },
  predPlaceholderText: {
    fontSize: 11,
    color: "var(--text-tertiary)",
    fontFamily: "var(--font-sans)",
    lineHeight: 1.55,
    marginTop: 8,
  },

  confRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 5,
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
    fontSize: 11,
    width: 44,
    textAlign: "right",
    flexShrink: 0,
    fontVariantNumeric: "tabular-nums",
  },
};
