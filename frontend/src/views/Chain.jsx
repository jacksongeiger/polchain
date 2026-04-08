import { useEffect, useRef, useState, useCallback, useContext, createContext } from "react";
import { ethers } from "ethers";
import { TASK_MANAGER_ABI } from "../contracts";
import { getReadProvider, shortAddress, resetReadProvider, getRpcUrls } from "../wallet";
import { ADMIN_API, PROVE_SERVER as PROVE_SERVER_URL, fetchAddresses, pickTaskManager, BUILD_TIME_ADDRESSES } from "../config";

const BASESCAN   = "https://sepolia.basescan.org";
const ZERO_HASH  = "0x" + "0".repeat(64);

// Context so BlockCard can trigger the inspector without prop-drilling
const InspectCtx = createContext(null);

// Named miners matching autoMiner.js — all share one wallet, so we match
// on-chain submissions to miner slots by score proximity to each base.
// Colors mirror the new identity palette in Miners.jsx and index.css.
const MINER_PROFILES = [
  {
    id: 0, shard: 0, name: "ALPHA", color: "#00f5ff", base: 82,
    icon: "⟳", aug: "Random Rotation ±15°",
    desc: "Rotates each digit image by a random angle up to ±15° every epoch — trains the model to be rotation-invariant.",
  },
  {
    id: 1, shard: 1, name: "BETA",  color: "#ffd84d", base: 50,
    icon: "≋", aug: "Gaussian Noise σ=0.1",
    desc: "Adds Gaussian noise (σ=0.1) to pixel values each epoch — improves robustness to noisy or corrupted inputs.",
  },
  {
    id: 2, shard: 2, name: "GAMMA", color: "#4ade80", base: 92,
    icon: "▪", aug: "Random Erasing 10–20%",
    desc: "Zeros out a random rectangular patch covering 10–20% of pixels each epoch — trains the model to handle occlusion.",
  },
  {
    id: 3, shard: 3, name: "DELTA", color: "#c084fc", base: 83,
    icon: "◆", aug: "Clean Training",
    desc: "No augmentation — pure gradient descent on the MNIST shard. Provides a clean baseline for comparison.",
  },
];

function getManager(addr, p) {
  return new ethers.Contract(addr, TASK_MANAGER_ABI, p);
}

function shortHash(h) {
  if (!h || h === ZERO_HASH) return "0x00000000…000000";
  return `${h.slice(0, 10)}…${h.slice(-6)}`;
}

// Greedily assign raw on-chain submissions to the 4 named miner slots
// by matching each submission's score to the nearest unassigned miner base.
function assignMiners(subs) {
  const slots  = MINER_PROFILES.map((p) => ({ ...p, sub: null }));
  const taken  = new Set();
  const sorted = [...subs].sort((a, b) => Number(b.score) - Number(a.score));

  for (const sub of sorted) {
    const score = Number(sub.score);
    let bestIdx = -1, bestDist = Infinity;
    for (let i = 0; i < slots.length; i++) {
      if (taken.has(i)) continue;
      const d = Math.abs(slots[i].base - score);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    if (bestIdx >= 0) { slots[bestIdx].sub = sub; taken.add(bestIdx); }
  }
  return slots;
}

// ---------------------------------------------------------------------------
// Genesis block card
// ---------------------------------------------------------------------------
function GenesisCard() {
  return (
    <div style={S.genesisBlock}>
      <div style={S.genesisRune}>◎</div>
      <div style={S.blockHeader}>
        <div>
          <div style={S.blockNum}>BLOCK</div>
          <div style={S.blockNumValue}>00</div>
        </div>
      </div>
      <div style={S.blockSpace} />
      <div style={S.fieldGroup}>
        <span style={S.label}>ORIGIN</span>
        <span style={{ ...S.mono, color: "var(--text-tertiary)" }}>POLCHAIN GENESIS</span>
      </div>
      <div style={S.fieldGroup}>
        <span style={S.label}>STATE</span>
        <span style={{ ...S.mono, color: "var(--text-dim)" }}>{shortHash(ZERO_HASH)}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Proof Inspector modal
// ---------------------------------------------------------------------------
function ProofInspector({ taskId, onClose }) {
  const [data,         setData]         = useState(null);  // null = loading
  const [err,          setErr]          = useState("");
  const [copied,       setCopied]       = useState(false);
  const [copiedWcHash, setCopiedWcHash] = useState(null);  // "input" | "output" | null
  const overlayRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${ADMIN_API}/api/proof/${taskId}`, { signal: AbortSignal.timeout(8_000) })
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, [taskId]);

  // Close on overlay click
  function handleOverlayClick(e) {
    if (e.target === overlayRef.current) onClose();
  }

  // Close on Escape
  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function copyHex() {
    if (!data?.proof?.hex_proof) return;
    navigator.clipboard.writeText(data.proof.hex_proof).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }

  function copyWcHash(which, val) {
    navigator.clipboard.writeText(val).then(() => {
      setCopiedWcHash(which);
      setTimeout(() => setCopiedWcHash(null), 1800);
    });
  }

  const winner = data?.winner;
  const proof  = data?.proof;

  return (
    <div ref={overlayRef} style={SM.overlay} onClick={handleOverlayClick}>
      <div style={SM.panel}>

        {/* Header */}
        <div style={SM.header}>
          <div>
            <div style={SM.title}>Block #{taskId} — Proof Inspector</div>
            {winner && (
              <div style={SM.subtitle}>
                Miner: <span style={{ color: "#a0f0a0", fontFamily: "monospace" }}>{shortAddress(winner.miner)}</span>
              </div>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {winner && (
              winner.zkVerified
                ? <span style={SM.zkBadge}>ZK✓ Verified</span>
                : <span style={SM.basicBadge}>Unverified</span>
            )}
            <button style={SM.closeBtn} onClick={onClose}>✕</button>
          </div>
        </div>

        {/* Body */}
        <div style={SM.body}>
          {winner?.zkVerified && (
            <div style={SM.zkNote}>
              Real Halo2 zero-knowledge proof — verified on-chain
            </div>
          )}
          {err ? (
            <div style={{ color: "#ff6b6b", fontSize: 12 }}>Error: {err}</div>
          ) : !data ? (
            <div style={{ color: "#555", fontSize: 12 }}>Loading…</div>
          ) : !proof ? (
            <div style={SM.noProof}>
              This block was submitted without a ZK proof (basic submission).
            </div>
          ) : (
            <>
              {/* Proof hex */}
              <div style={SM.section}>
                <div style={SM.sectionTitle}>Proof</div>
                <div style={SM.hexBox}>
                  <div style={SM.hexText}>{proof.hex_proof}</div>
                  <button style={{ ...SM.copyBtn, color: copied ? "#3ddc84" : "#666" }} onClick={copyHex}>
                    {copied ? "Copied ✓" : "Copy"}
                  </button>
                </div>
              </div>

              {/* Public inputs */}
              {proof.instances && proof.instances.length > 0 && (
                <div style={SM.section}>
                  <div style={SM.sectionTitle}>Public Inputs ({proof.instances[0]?.length ?? proof.instances.length} values)</div>
                  <div style={SM.instanceList}>
                    {(proof.instances[0] ?? proof.instances).map((v, i) => (
                      <div key={i} style={SM.instanceRow}>
                        <span style={SM.instanceIdx}>[{i}]</span>
                        <span style={SM.instanceVal}>{String(v).length > 20 ? String(v).slice(0, 18) + "…" : String(v)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Training details */}
              {(data.augmentation || data.digits_targeted) && (
                <div style={SM.section}>
                  <div style={SM.sectionTitle}>Training Details</div>
                  {data.augmentation && (
                    <div style={SM.detailRow}>
                      <span style={SM.detailLabel}>Augmentation</span>
                      <div>
                        <span style={SM.augLabel}>{data.augmentation.label}</span>
                        <div style={SM.augDesc}>{data.augmentation.description}</div>
                      </div>
                    </div>
                  )}
                  {data.digits_targeted && data.digits_targeted.length > 0 && (
                    <div style={SM.detailRow}>
                      <span style={SM.detailLabel}>Digits Targeted</span>
                      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                        {data.digits_targeted.map((d) => (
                          <span key={d} style={SM.digitBadge}>{d}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Weight chain */}
              {data.weight_chain && (
                <div style={SM.section}>
                  <div style={SM.sectionTitle}>Weight Chain</div>
                  <div style={SM.wcRow}>
                    <div style={SM.wcHashBox}>
                      <div style={SM.wcHashLabel}>Before</div>
                      <div style={SM.wcHashVal}>
                        {data.weight_chain.input_weight_hash.slice(0, 20)}…
                      </div>
                      <button
                        style={{ ...SM.copyBtn, color: copiedWcHash === "input" ? "#3ddc84" : "#666" }}
                        onClick={() => copyWcHash("input", data.weight_chain.input_weight_hash)}
                      >
                        {copiedWcHash === "input" ? "Copied ✓" : "Copy"}
                      </button>
                    </div>
                    <div style={SM.wcArrow}>→</div>
                    <div style={SM.wcHashBox}>
                      <div style={SM.wcHashLabel}>After</div>
                      <div style={SM.wcHashVal}>
                        {data.weight_chain.output_weight_hash.slice(0, 20)}…
                      </div>
                      <button
                        style={{ ...SM.copyBtn, color: copiedWcHash === "output" ? "#3ddc84" : "#666" }}
                        onClick={() => copyWcHash("output", data.weight_chain.output_weight_hash)}
                      >
                        {copiedWcHash === "output" ? "Copied ✓" : "Copy"}
                      </button>
                    </div>
                  </div>
                  <div style={SM.wcMeta}>
                    <span>Loss <span style={{ color: "#a0b0ff" }}>{data.weight_chain.loss.toFixed(4)}</span></span>
                    <span style={SM.wcSep}>·</span>
                    <span>Step score <span style={{ color: "#3ddc84" }}>{data.weight_chain.step_score}/100</span></span>
                  </div>
                  <div style={SM.wcCaption}>Proves model state transition for this block</div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Miner profile modal (shown when a Live Mining card is clicked)
// ---------------------------------------------------------------------------
function MinerProfileModal({ minerId, currentScore, onClose }) {
  const profile    = MINER_PROFILES[minerId];
  const [digits, setDigits] = useState(null); // null = loading
  const overlayRef = useRef(null);

  useEffect(() => {
    fetch(`${PROVE_SERVER_URL}/accuracy_by_class`, { signal: AbortSignal.timeout(5_000) })
      .then((r) => r.json())
      .then((d) => {
        if (d.ok && d.assignments) setDigits(d.assignments[minerId] ?? []);
        else setDigits([]);
      })
      .catch(() => setDigits([]));
  }, [minerId]);

  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function handleOverlayClick(e) {
    if (e.target === overlayRef.current) onClose();
  }

  if (!profile) return null;

  return (
    <div ref={overlayRef} style={SM.overlay} onClick={handleOverlayClick}>
      <div style={{ ...SM.panel, maxWidth: 400 }}>

        {/* Header */}
        <div style={SM.header}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{
              width: 10, height: 10, borderRadius: "50%",
              background: profile.color, boxShadow: `0 0 8px ${profile.color}66`, flexShrink: 0,
            }} />
            <div>
              <div style={{ ...SM.title, color: profile.color }}>{profile.name}</div>
              <div style={SM.subtitle}>Shard {profile.shard} · Miner ID {profile.id}</div>
            </div>
          </div>
          <button style={SM.closeBtn} onClick={onClose}>✕</button>
        </div>

        {/* Body */}
        <div style={SM.body}>

          {/* Augmentation */}
          <div style={SM.section}>
            <div style={SM.sectionTitle}>Augmentation Strategy</div>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
              <span style={{ fontSize: 18, color: profile.color, lineHeight: 1.3, flexShrink: 0 }}>
                {profile.icon}
              </span>
              <div>
                <div style={{ fontSize: 11, color: "#a0b0ff", fontWeight: "bold", marginBottom: 5 }}>
                  {profile.aug}
                </div>
                <div style={{ fontSize: 10, color: "#555", lineHeight: 1.6 }}>
                  {profile.desc}
                </div>
              </div>
            </div>
          </div>

          {/* Current score */}
          {currentScore !== null && (
            <div style={SM.section}>
              <div style={SM.sectionTitle}>Current Block Score</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 3 }}>
                <span style={{ fontSize: 26, fontWeight: "bold", color: profile.color, fontFamily: "monospace", lineHeight: 1 }}>
                  {currentScore}
                </span>
                <span style={{ fontSize: 11, color: "#444" }}>/100</span>
              </div>
            </div>
          )}

          {/* Digits targeted */}
          <div style={SM.section}>
            <div style={SM.sectionTitle}>Digits Targeted</div>
            {digits === null ? (
              <div style={{ fontSize: 10, color: "#444", fontStyle: "italic" }}>Fetching…</div>
            ) : digits.length === 0 ? (
              <div style={{ fontSize: 10, color: "#444", fontStyle: "italic" }}>None assigned</div>
            ) : (
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                {digits.map((d) => (
                  <span key={d} style={SM.digitBadge}>{d}</span>
                ))}
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Attack card — inline chain card shown during attack simulation
// ---------------------------------------------------------------------------

const ATTACK_REPORT_TIMEOUT = 20; // seconds before auto-dismiss

function AttackCard({ card, onOpenReport }) {
  // card: { phase, logLines, txHash, readableAt? }
  // phases: entering → active → rejecting → readable → fading
  const phaseClass = {
    entering:  "atk-enter",
    active:    "atk-pulse",
    rejecting: "atk-flash",
    readable:  "",          // static border, progress bar draining
    fading:    "atk-fade",
  }[card.phase] || "";

  const showStamp    = card.phase === "fading";
  const showReadable = card.phase === "readable" || card.phase === "fading";

  // Progress bar countdown — ticks every 100ms while in readable phase
  const [progress, setProgress] = useState(1); // 1 = full, 0 = empty
  useEffect(() => {
    if (card.phase !== "readable" || !card.readableAt) return;
    const id = setInterval(() => {
      const elapsed = (Date.now() - card.readableAt) / 1000;
      setProgress(Math.max(0, 1 - elapsed / ATTACK_REPORT_TIMEOUT));
    }, 100);
    return () => clearInterval(id);
  }, [card.phase, card.readableAt]);

  function handleCardClick() {
    if (showReadable && onOpenReport) onOpenReport();
  }

  return (
    <div
      className={phaseClass}
      onClick={handleCardClick}
      style={{
        ...S.block,
        background: "#100404",
        border:     "1px solid #4a1a1a",
        position:   "relative",
        overflow:   "hidden",
        cursor:     showReadable ? "pointer" : "default",
      }}
    >
      <div style={S.blockHeader}>
        <span style={{ ...S.blockNum, color: "#ff6b6b" }}>BLOCK ?</span>
        <span style={{
          fontSize: 8, color: "#ff4444", border: "1px solid #4a1a1a",
          borderRadius: 3, padding: "1px 5px", letterSpacing: 0.5,
          fontFamily: "monospace", background: "#1a0404",
        }}>ATTACK</span>
      </div>
      <div style={S.fieldGroup}>
        <span style={S.label}>MINER</span>
        <span style={{ ...S.mono, color: "#ff6b6b" }}>0x000...EVIL</span>
      </div>
      <div style={S.fieldGroup}>
        <span style={S.label}>SCORE</span>
        <span style={{ ...S.mono, color: "#ff8c42" }}>99/100 (CLAIMED)</span>
      </div>

      {/* Execution log — lines fade in one by one */}
      {card.logLines && card.logLines.length > 0 && (
        <div style={{ marginTop: 8, borderTop: "1px solid #2a1010", paddingTop: 6 }}>
          {card.logLines.map((line, i) => (
            <div key={i} className="atk-line-in" style={{
              display: "flex", gap: 5, alignItems: "flex-start",
              marginBottom: 4, fontSize: 9, fontFamily: "monospace",
              color: line.red ? "#ff4444" : "#cc7733",
              lineHeight: 1.4,
            }}>
              <span style={{ flexShrink: 0, color: line.red ? "#ff4444" : "#554433" }}>
                {line.red ? "✕" : "⟶"}
              </span>
              <span style={{ wordBreak: "break-word" }}>{line.text}</span>
            </div>
          ))}
        </div>
      )}

      {/* "View report" prompt — appears when all log lines are done */}
      {showReadable && (
        <div className="atk-line-in" style={{
          marginTop: 8, fontSize: 9, color: "#ff8c42",
          fontFamily: "monospace", letterSpacing: 0.3,
          textAlign: "right",
        }}>
          View report →
        </div>
      )}

      {card.txHash && (
        <a href={`${BASESCAN}/tx/${card.txHash}`} target="_blank" rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{ ...S.txLink, color: "#4a6aaa" }}>
          view tx ↗
        </a>
      )}

      {/* Progress bar draining along the bottom edge */}
      {showReadable && !showStamp && (
        <div style={{
          position: "absolute", bottom: 0, left: 0,
          height: 2, background: "#4a1a1a", width: "100%",
        }}>
          <div style={{
            height: "100%", background: "#ff6b6b",
            width:  `${progress * 100}%`,
            transition: "width 0.1s linear",
          }} />
        </div>
      )}

      {showStamp && (
        <div className="atk-stamp" style={{
          position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "rgba(16,4,4,0.82)",
        }}>
          <div style={{
            fontSize: 17, fontWeight: "bold", color: "#ff4444",
            border: "2px solid #ff4444", borderRadius: 3,
            padding: "3px 9px", letterSpacing: 3,
            fontFamily: "monospace", transform: "rotate(-12deg)",
          }}>REJECTED</div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ZK Attack Report Modal
// ---------------------------------------------------------------------------

function ZKAttackReportModal({ txHash, onClose }) {
  const overlayRef = useRef(null);

  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function handleOverlay(e) {
    if (e.target === overlayRef.current) onClose();
  }

  // Animated state for body
  const [stepVis,   setStepVis]   = useState([false, false, false, false, false]);
  const [bytesGray, setBytesGray] = useState(Array(64).fill(false));
  const [bytesRed,  setBytesRed]  = useState(Array(64).fill(false));
  const [verdict,   setVerdict]   = useState(false);

  useEffect(() => {
    const timers = [];
    [200, 600, 1000, 1400, 1800].forEach((delay, i) => {
      timers.push(setTimeout(() =>
        setStepVis(p => { const n = [...p]; n[i] = true; return n; }), delay));
    });
    for (let i = 0; i < 64; i++) {
      timers.push(setTimeout(() =>
        setBytesGray(p => { const n = [...p]; n[i] = true; return n; }), 1600 + i * 18));
    }
    for (let i = 0; i < 64; i++) {
      timers.push(setTimeout(() =>
        setBytesRed(p => { const n = [...p]; n[i] = true; return n; }), 2200 + i * 22));
    }
    timers.push(setTimeout(() => setVerdict(true), 3600));
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <div ref={overlayRef} onClick={handleOverlay} style={{
      position: "fixed", inset: 0, zIndex: 9000,
      background: "rgba(0,0,0,0.72)", display: "flex",
      alignItems: "center", justifyContent: "center",
      padding: "20px",
    }}>
      <div style={{
        width: "100%", maxWidth: 720, maxHeight: "90vh",
        borderRadius: 10, overflow: "hidden",
        display: "flex", flexDirection: "column",
        boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
        border: "1px solid var(--color-border, #1e1e30)",
      }}>

        {/* ── Header ── */}
        <div style={{
          background: "var(--color-bg-tertiary, #0a0a14)",
          padding: "20px 24px",
          borderBottom: "1px solid var(--color-border, #1e1e30)",
          flexShrink: 0,
        }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
            <div>
              <div style={{
                fontSize: 18, fontWeight: 700, color: "var(--color-text-primary, #e8e8f0)",
                letterSpacing: 0.3, marginBottom: 4,
              }}>
                ZK Proof Attack Report
              </div>
              <div style={{
                fontSize: 11, color: "var(--color-text-secondary, #666680)",
                letterSpacing: 0.2,
              }}>
                Attempted block forgery — cryptographic rejection confirmed
              </div>
              {txHash && (
                <a href={`${BASESCAN}/tx/${txHash}`} target="_blank" rel="noreferrer" style={{
                  display: "inline-block", marginTop: 8,
                  fontSize: 10, color: "var(--color-text-link, #4a6aaa)",
                  fontFamily: "monospace", letterSpacing: 0.2, textDecoration: "none",
                }}>
                  {txHash.slice(0, 18)}…{txHash.slice(-6)} ↗
                </a>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
              <span style={{
                fontSize: 10, fontWeight: 700, letterSpacing: 1.5,
                color: "#ff4444", background: "#1a0404",
                border: "1px solid #4a1a1a", borderRadius: 20,
                padding: "4px 12px",
              }}>REJECTED</span>
              <button onClick={onClose} style={{
                background: "none", border: "none",
                color: "var(--color-text-secondary, #666680)",
                fontSize: 16, cursor: "pointer", padding: "2px 6px",
                lineHeight: 1,
              }}>✕</button>
            </div>
          </div>
        </div>

        {/* ── Body ── */}
        <div style={{
          background: "var(--color-bg-secondary, #07070f)",
          padding: "24px",
          overflowY: "auto",
          display: "flex",
          gap: 28,
          flex: 1,
        }}>

          {/* LEFT — SVG attack flow */}
          <div style={{ width: "42%", flexShrink: 0 }}>
            <div style={{
              fontSize: 9, fontWeight: 700, letterSpacing: 1.5,
              textTransform: "uppercase",
              color: "var(--color-text-tertiary, #444460)",
              marginBottom: 12,
            }}>Attack flow</div>
            <FlowDiagramSVG />
          </div>

          {/* Divider */}
          <div style={{ width: 1, background: "var(--color-border, #1e1e30)", flexShrink: 0 }} />

          {/* RIGHT — Why ZK caught it */}
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            <div style={{
              fontSize: 9, fontWeight: 700, letterSpacing: 1.5,
              textTransform: "uppercase",
              color: "var(--color-text-tertiary, #444460)",
              marginBottom: 14,
            }}>Why ZK proof protection works</div>

            <div style={{ marginBottom: 18 }}>
              {STEP_DATA.map((step, i) => (
                <div key={i} style={{
                  display: "flex", gap: 12, alignItems: "flex-start",
                  marginBottom: 12,
                  opacity:    stepVis[i] ? 1 : 0,
                  transform:  stepVis[i] ? "translateX(0)" : "translateX(-10px)",
                  transition: "opacity 0.35s cubic-bezier(0.34,1.56,0.64,1), transform 0.35s cubic-bezier(0.34,1.56,0.64,1)",
                }}>
                  <div style={{
                    width: 24, height: 24, borderRadius: "50%",
                    background: step.iconBg,
                    border: "1px solid var(--color-border, #1e1e30)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 11, color: step.iconColor, flexShrink: 0, marginTop: 1,
                  }}>
                    {step.icon}
                  </div>
                  <div>
                    <div style={{
                      fontSize: 11, fontWeight: 600,
                      color: "var(--color-text-primary, #e8e8f0)", marginBottom: 3,
                    }}>{step.title}</div>
                    <div style={{
                      fontSize: 10, lineHeight: 1.6,
                      color: "var(--color-text-secondary, #888898)",
                    }}>{step.desc}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Proof bytes panel */}
            <div style={{
              background: "var(--color-bg-tertiary, #06060e)",
              border: "1px solid var(--color-border, #111120)",
              borderRadius: 6, padding: "12px 14px",
            }}>
              <div style={{
                fontSize: 9, fontFamily: "monospace", letterSpacing: 0.3,
                color: "var(--color-text-tertiary, #444460)", marginBottom: 8,
              }}>proof.bytes[0..63]</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                {Array.from({ length: 64 }, (_, i) => (
                  <div key={i} style={{
                    width: 7, height: 7, borderRadius: 1,
                    background: bytesRed[i]  ? "#E24B4A"
                              : bytesGray[i] ? "#2a2a3a" : "#111120",
                    opacity:    bytesGray[i] ? 1 : 0,
                    transform:  bytesRed[i]  ? "scale(1.2)" : "scale(1)",
                    transition: "opacity 0.15s ease-out, background 0.2s ease-out, transform 0.15s ease-out",
                  }} />
                ))}
              </div>
              <div style={{
                marginTop: 10, fontSize: 9, fontFamily: "monospace",
                color: "#ff4444", letterSpacing: 0.2,
                opacity: verdict ? 1 : 0,
                transition: "opacity 0.4s ease-out",
              }}>✕ polynomial constraints not satisfied</div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step data for ZK attack report modal
// ---------------------------------------------------------------------------

const STEP_DATA = [
  { icon: "⚠", iconBg: "#1a1400", iconColor: "#f0c040",
    title: "Fake proof submitted",
    desc:  "Attacker sends garbage bytes claiming a perfect score. No real MNIST training was done." },
  { icon: "→", iconBg: "#0e0e18", iconColor: "#888898",
    title: "TaskManager delegates",
    desc:  "The smart contract cannot verify ZK proofs itself — it forwards the bytes to the on-chain Halo2 Verifier." },
  { icon: "∑", iconBg: "#0e0818", iconColor: "#b07fff",
    title: "Polynomial constraints checked",
    desc:  "A valid proof must satisfy thousands of polynomial equations derived from the model training circuit." },
  { icon: "✕", iconBg: "#1a0404", iconColor: "#ff4444",
    title: "Verification fails — mathematically",
    desc:  "Random bytes cannot satisfy the constraints. Forging a valid ZK proof is computationally infeasible." },
  { icon: "⛓", iconBg: "#04100a", iconColor: "#3ddc84",
    title: "Chain state unchanged",
    desc:  "Transaction reverts on-chain. Attacker pays gas. PoLChain is unaffected." },
];

// ---------------------------------------------------------------------------
// SVG flow diagram — left column of attack report modal
// ---------------------------------------------------------------------------

function FlowDiagramSVG() {
  const pulseRef = useRef(null);

  useEffect(() => {
    let phase = 0;
    const pulseId = setInterval(() => {
      if (!pulseRef.current) return;
      phase = (phase + 1) % 50;
      const t = phase / 50;
      pulseRef.current.setAttribute("r",       String(82 + t * 16));
      pulseRef.current.setAttribute("opacity", String(0.6 * (1 - t)));
    }, 40);
    return () => clearInterval(pulseId);
  }, []);

  // Vertical layout (all y values are SVG units):
  //   Node 1 circle:     cy=72  r=44   bottom=116
  //   Node 1 labels:     y=132, y=148              bottom≈157
  //   Arrow 1:           y1=162  y2=200             length=38
  //   Node 2 rect:       top=204  h=52  bottom=256
  //   Arrow 2:           y1=262  y2=300             length=38
  //   Node 3 outer ring: cy=382  r=82   top=300  bottom=464
  //   Node 3 main circle:r=72           top=310  bottom=454
  //   Node 3 labels:     y=480, y=496              bottom≈505  (16px below outer ring)
  //   Arrow 3:           y1=512  y2=532             length=20
  //   Node 4 rect:       top=536  h=52  bottom=588
  //   SVG height: 600

  return (
    <svg viewBox="0 0 280 600" style={{ width: "100%", height: "auto" }}>
      <defs>
        <marker id="arr-red" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
          <path d="M0,0 L8,3 L0,6 Z" fill="#E24B4A" />
        </marker>
        <marker id="arr-gray" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
          <path d="M0,0 L8,3 L0,6 Z" fill="#444460" />
        </marker>
      </defs>

      {/* ── Node 1: Fake Miner ── */}
      {/* circle bottom=116, labels clear at y=132+ */}
      <g className="zkn-in" style={{ animationDelay: "0.1s" }}>
        <circle cx="140" cy="72" r="44" fill="#1a0404" stroke="#5a2020" strokeWidth="1.5" />
        {/* Person silhouette: head circle + shoulder arc, both at 60% opacity */}
        <circle cx="140" cy="54" r="11" fill="#E24B4A" fillOpacity="0.6" />
        <path d="M 114,96 C 114,80 128,72 140,72 C 152,72 166,80 166,96 Z"
          fill="#E24B4A" fillOpacity="0.6" />
        <text x="140" y="132" textAnchor="middle"
          fontSize="10" fontWeight="700" fill="#ff6666" fontFamily="sans-serif">Fake Miner</text>
        <text x="140" y="148" textAnchor="middle"
          fontSize="8.5" fill="#664444" fontFamily="sans-serif">score 99/100 claimed</text>
      </g>

      {/* ── Arrow 1: y1=162 → y2=200 (38px, 5px gap after label) ── */}
      <line className="zkd-draw"
        x1="140" y1="162" x2="140" y2="200"
        stroke="#E24B4A" strokeWidth="2"
        strokeDasharray="44" strokeDashoffset="44"
        markerEnd="url(#arr-red)"
        style={{ animationDelay: "0.55s" }} />

      {/* ── Node 2: TaskManager ── */}
      {/* rect top=204, h=52, center=230, bottom=256 */}
      <g className="zkn-in" style={{ animationDelay: "0.85s" }}>
        <rect x="55" y="204" width="170" height="52" rx="26"
          fill="#0a0a18" stroke="#1e1e30" strokeWidth="1.5" />
        <text x="140" y="227" textAnchor="middle"
          fontSize="11" fontWeight="700" fill="#888898" fontFamily="sans-serif">TaskManager</text>
        <text x="140" y="243" textAnchor="middle"
          fontSize="8.5" fill="#444460" fontFamily="sans-serif">delegates to verifier</text>
      </g>

      {/* ── Arrow 2: y1=262 → y2=300 (38px, 6px gap after rect) ── */}
      {/* Arrow tip at y=300 = Node 3 outer ring top (cy=382, r=82) */}
      <line className="zkd-draw"
        x1="140" y1="262" x2="140" y2="300"
        stroke="#444460" strokeWidth="1.5"
        strokeDasharray="44" strokeDashoffset="44"
        markerEnd="url(#arr-gray)"
        style={{ animationDelay: "1.15s" }} />

      {/* ── Node 3: Halo2 Verifier (cy=382) ── */}
      {/* outer ring: top=300, bottom=464  main circle: top=310, bottom=454 */}
      <g className="zkn-in" style={{ animationDelay: "1.45s" }}>
        {/* Outer dashed ring */}
        <circle cx="140" cy="382" r="82"
          fill="none" stroke="#3a1a6a" strokeWidth="1" strokeDasharray="4 3" />
        {/* JS-driven pulse ring */}
        <circle ref={pulseRef} cx="140" cy="382" r="82"
          fill="none" stroke="#b07fff" strokeWidth="1.5" opacity="0" />
        {/* Main circle */}
        <circle cx="140" cy="382" r="72" fill="#0e0818" stroke="#3a1a6a" strokeWidth="2" />
        {/* Sigma symbol — baseline at cy+12 centers it visually */}
        <text x="140" y="394" textAnchor="middle"
          fontSize="32" fill="#b07fff" fontFamily="serif">∑</text>
        {/* Left side annotations (inside circle area) */}
        <line x1="64" y1="356" x2="70" y2="356" stroke="#2a2a4a" strokeWidth="1" />
        <text x="62" y="359" textAnchor="end"
          fontSize="7.5" fill="#333350" fontFamily="monospace">constraints</text>
        <line x1="64" y1="384" x2="70" y2="384" stroke="#2a2a4a" strokeWidth="1" />
        <text x="62" y="387" textAnchor="end"
          fontSize="7.5" fill="#333350" fontFamily="monospace">verify key</text>
        {/* Labels fully below outer ring bottom (y=464) — 16px clear gap */}
        <text x="140" y="480" textAnchor="middle"
          fontSize="10" fontWeight="700" fill="#b07fff" fontFamily="sans-serif">Halo2 Verifier</text>
        <text x="140" y="496" textAnchor="middle"
          fontSize="8.5" fill="#664476" fontFamily="sans-serif">polynomial commitments</text>
      </g>

      {/* ── Arrow 3: y1=512 → y2=532 (dashed red, 16px gap after label) ── */}
      <line className="zkl-in"
        x1="140" y1="512" x2="140" y2="532"
        stroke="#E24B4A" strokeWidth="2" strokeDasharray="4 3"
        markerEnd="url(#arr-red)"
        style={{ animationDelay: "2.45s", opacity: 0 }} />

      {/* ── Node 4: REJECTED ── */}
      {/* rect top=536, h=52, center=562, bottom=588 */}
      <g className="zkn-in" style={{ animationDelay: "2.7s" }}>
        <rect x="20" y="536" width="240" height="52" rx="26"
          fill="#1a0404" stroke="#5a1a1a" strokeWidth="2" />
        <text x="140" y="559" textAnchor="middle"
          fontSize="13" fontWeight="700" fill="#ff4444"
          fontFamily="sans-serif" letterSpacing="3">REJECTED</text>
        <text x="140" y="574" textAnchor="middle"
          fontSize="8.5" fill="#664444" fontFamily="sans-serif">tx reverts · 0 POL paid</text>
      </g>
    </svg>
  );
}


// ---------------------------------------------------------------------------
// Finalized block card
// ---------------------------------------------------------------------------
function BlockCard({ block }) {
  const openInspector = useContext(InspectCtx);
  const [hover, setHover] = useState(false);

  const isLost = block.noWinner;
  const cardStyle = {
    ...S.block,
    background: "var(--bg-elevated)",
    borderColor: hover
      ? (isLost ? "rgba(255, 77, 109, 0.4)" : "var(--accent-deep)")
      : "var(--border)",
    boxShadow: hover && !isLost ? "0 0 32px var(--accent-glow)" : "none",
    transform: hover ? "translateY(-2px)" : "translateY(0)",
  };

  return (
    <div
      className="block-card"
      style={cardStyle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => openInspector(block.id)}
      title="Click to inspect proof"
    >
      <div style={S.blockHeader}>
        <div>
          <div style={S.blockNum}>BLOCK</div>
          <div style={S.blockNumValue}>
            {String(block.id).padStart(2, "0")}
          </div>
        </div>
        {!isLost && (
          block.zkVerified
            ? <span style={S.zkBadge}>◆ ZK</span>
            : <span style={S.basicBadge}>BASIC</span>
        )}
        {isLost && (
          <span style={{ ...S.basicBadge, color: "#ff7a8e", borderColor: "rgba(255, 77, 109, 0.3)" }}>VOID</span>
        )}
      </div>

      {isLost ? (
        <>
          <div style={S.scoreLine}>
            <span style={{ ...S.scoreVal, color: "#ff7a8e", fontSize: 22 }}>—</span>
          </div>
          <div style={S.fieldGroup}>
            <span style={S.label}>RESULT</span>
            <span style={{ ...S.mono, color: "#ff7a8e" }}>NO SUBMISSIONS</span>
          </div>
        </>
      ) : (
        <>
          <div style={S.scoreLine}>
            <span style={S.scoreVal}>{block.score}</span>
            <span style={S.scoreDenom}>/ 100</span>
          </div>
          <div style={S.fieldGroup}>
            <span style={S.label}>MINER</span>
            <span style={S.mono}>{shortAddress(block.miner)}</span>
          </div>
          <div style={S.fieldGroup}>
            <span style={S.label}>GRADIENT HASH</span>
            <span style={S.mono}>{shortHash(block.gradHash)}</span>
          </div>
        </>
      )}

      <div style={S.blockSpace} />

      {block.txHash && (
        <a
          href={`${BASESCAN}/tx/${block.txHash}`}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={S.txLink}
        >
          VIEW TX ↗
        </a>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pending block (chain scroll card)
// ---------------------------------------------------------------------------
function PendingCard({ pending }) {
  const [label, setLabel] = useState("");

  useEffect(() => {
    function tick() {
      const diff = pending.deadline - Date.now();
      if (diff <= 0) { setLabel("Closing…"); return; }
      const s = Math.floor(diff / 1000) % 60;
      const m = Math.floor(diff / 60000);
      setLabel(m > 0 ? `${m}m ${s}s` : `${s}s`);
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [pending.deadline]);

  return (
    <div className="pending-pulse" style={S.pendingBlock}>
      <span style={S.pendingCorner} />
      <div style={S.blockHeader}>
        <div>
          <div style={{ ...S.blockNum, color: "var(--accent)" }}>BLOCK</div>
          <div style={S.blockNumValue}>{String(pending.id).padStart(2, "0")}</div>
        </div>
        <span style={S.pendingBadge}>● LIVE</span>
      </div>

      <div style={S.scoreLine}>
        <span style={{ ...S.scoreVal, color: "var(--accent)", fontSize: 34 }}>{label}</span>
      </div>

      <div style={S.fieldGroup}>
        <span style={S.label}>SUBMISSIONS</span>
        <span style={{ ...S.mono, color: "var(--text-primary)" }}>
          {String(pending.submissionCount).padStart(2, "0")} / 04
        </span>
      </div>
      <div style={S.fieldGroup}>
        <span style={S.label}>PREV STATE</span>
        <span style={{ ...S.mono, color: "var(--text-dim)" }}>{shortHash(pending.prevHash)}</span>
      </div>

      <div style={S.blockSpace} />
      <div style={{ ...S.fieldGroup, marginBottom: 0 }}>
        <span style={{ ...S.label, color: "var(--accent)" }}>● MINERS COMPETING</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Arrow connector between blocks
// ---------------------------------------------------------------------------
function Arrow() {
  return (
    <div style={S.arrow}>
      <div style={S.arrowLine} />
      <div style={S.arrowDot} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live miner card
// ---------------------------------------------------------------------------
function MinerCard({ slot, isWinner, isLeading, finalized, proofJob, jobStartedAt, onClick, basicScore }) {
  const submitted = slot.sub !== null;
  const score     = submitted ? Number(slot.sub.score) : null;
  const subTime   = submitted ? Number(slot.sub.submittedAt) * 1000 : null;

  // Live elapsed timer — ticks every second while proof is in progress
  const [elapsedSecs, setElapsedSecs] = useState(0);
  const isProving = proofJob?.status === "pending" || proofJob?.status === "proving";

  useEffect(() => {
    if (!isProving || !jobStartedAt) {
      setElapsedSecs(0);
      return;
    }
    function tick() {
      setElapsedSecs(Math.floor((Date.now() - jobStartedAt) / 1000));
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isProving, jobStartedAt]);

  // Proof status label
  let proofLabel = null;
  if (proofJob) {
    if (isProving) {
      const mins = Math.floor(elapsedSecs / 60);
      const secs = elapsedSecs % 60;
      const t    = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
      proofLabel = (
        <div style={SL.proofStatus}>
          <span style={SL.proofDot} />
          Proving block #{proofJob.task_id}… ({t})
        </div>
      );
    } else if (proofJob.status === "complete") {
      proofLabel = (
        <div style={{ ...SL.proofStatus, color: "#3ddc84" }}>
          <span style={{ ...SL.proofDot, background: "#3ddc84" }} />
          Proof ready ✓
        </div>
      );
    } else if (proofJob.status === "failed") {
      proofLabel = (
        <div style={{ ...SL.proofStatus, color: "#ff6b6b" }}>
          <span style={{ ...SL.proofDot, background: "#ff6b6b" }} />
          Proof failed
        </div>
      );
    }
  }

  // Card visual state
  const isActive = submitted || isLeading;
  const cardStyle = {
    ...SL.card,
    background:  isWinner   ? "linear-gradient(180deg, var(--bg-elevated) 0%, var(--accent-tint) 100%)"
              : isLeading  ? "linear-gradient(180deg, var(--bg-elevated) 0%, var(--accent-tint) 100%)"
              : submitted  ? "var(--bg-elevated)"
              :              "var(--bg-elevated)",
    borderColor: isWinner   ? "var(--accent)"
              : isLeading  ? "var(--accent-deep)"
              : submitted  ? "var(--border-strong)"
              :              "var(--border)",
    boxShadow:   isWinner   ? "0 0 36px var(--accent-glow-md), inset 0 0 0 1px var(--accent-glow)"
              : isLeading  ? "0 0 24px var(--accent-glow)"
              :              "none",
  };

  const accentStyle = {
    ...SL.cardAccent,
    background: slot.color,
    boxShadow:  isActive ? `0 0 12px ${slot.color}80` : "none",
    opacity:    isActive ? 1 : 0.4,
    transform:  isActive ? "scaleX(1)" : "scaleX(0.5)",
  };

  return (
    <div
      className={isWinner ? "winner-flash" : ""}
      style={cardStyle}
      onClick={onClick}
      title="Click for miner profile"
    >
      <div style={accentStyle} />

      {/* Name row */}
      <div style={SL.cardTop}>
        <div style={SL.minerNameRow}>
          <div style={{
            ...SL.minerDot,
            background: isActive ? slot.color : "var(--text-faint)",
            boxShadow:  isActive ? `0 0 10px ${slot.color}` : "none",
          }} />
          <span style={{
            ...SL.minerName,
            color: isActive ? "var(--text-primary)" : "var(--text-tertiary)",
          }}>
            {slot.name}
          </span>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {isWinner && <span style={SL.winnerBadge}>WINNER</span>}
          {isLeading && !finalized && !isWinner && <span style={SL.leadingBadge}>LEADING</span>}
        </div>
      </div>

      {/* Score or waiting */}
      {submitted ? (
        <>
          <div style={SL.scoreRow}>
            <span style={{
              ...SL.scoreVal,
              color: isWinner || isLeading ? slot.color : "var(--text-primary)",
              textShadow: isWinner ? `0 0 32px ${slot.color}88` : "none",
            }}>
              {score}
            </span>
            <span style={SL.scoreDenom}>/100</span>
          </div>
          {isWinner && <div style={SL.reward}>+ 100 POL</div>}
          <div style={SL.subTime}>{new Date(subTime).toLocaleTimeString()}</div>
        </>
      ) : basicScore !== null ? (
        <div style={SL.scoreRow}>
          <span style={{ ...SL.scoreVal, color: slot.color }}>{basicScore}</span>
          <span style={SL.scoreDenom}>/100</span>
        </div>
      ) : (
        <>
          <div style={{
            ...SL.scoreVal,
            color: "var(--text-faint)",
            fontSize: 28,
            marginBottom: 4,
          }}>···</div>
          <div style={SL.waiting}>WAITING</div>
        </>
      )}

      {/* Proof status — only shown after gradient has been submitted */}
      {submitted && proofLabel}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live Mining section — polls every 5s
// ---------------------------------------------------------------------------
function LiveMining({ taskManagerAddr, onBlockFinalized }) {
  const [liveTask,        setLiveTask]        = useState(null);
  const [slots,           setSlots]           = useState(() => MINER_PROFILES.map((p) => ({ ...p, sub: null })));
  const [countdown,       setCountdown]       = useState("");
  const [proofJobs,       setProofJobs]       = useState([]); // jobs from /jobs endpoint
  const [inspectedMinerId, setInspectedMinerId] = useState(null);
  const [basicScores,     setBasicScores]     = useState({}); // { miner_id: score } from SSE
  const prevFinalizedRef  = useRef(false);
  const prevTaskIdRef     = useRef(0);
  const jobStartTimesRef  = useRef({}); // { [miner_id]: startedAt ms } for current block

  // Subscribe to admin SSE log and parse [basic-score] lines.
  // On arrival: mark miner as training, store score. After 1.5s: reveal score.
  useEffect(() => {
    const es = new EventSource(`${ADMIN_API}/api/logs`);
    es.onmessage = (e) => {
      try {
        const { line } = JSON.parse(e.data);
        const m = line.match(/\[basic-score\] miner_id=(\d+) score=(\d+)/);
        if (m) {
          const id    = Number(m[1]);
          const score = Number(m[2]);
          setBasicScores((prev) => ({ ...prev, [id]: score }));
        }
      } catch { /* ignore malformed events */ }
    };
    return () => es.close();
  }, []);

  // Poll contract every 5s
  useEffect(() => {
    if (!taskManagerAddr) return;
    const manager = getManager(taskManagerAddr, getReadProvider());

    async function poll() {
      try {
        const total = Number(await manager.totalTasks());
        if (total === 0) return;

        const task     = await manager.getTask(BigInt(total));
        const taskId   = Number(task.id);
        const deadline = Number(task.deadline) * 1000;

        // Reset miner slots when a new task appears
        if (taskId !== prevTaskIdRef.current) {
          setSlots(MINER_PROFILES.map((p) => ({ ...p, sub: null })));
          setBasicScores({});
          prevFinalizedRef.current = false;
          prevTaskIdRef.current    = taskId;
        }

        setLiveTask({ id: taskId, deadline, finalized: task.finalized, winner: task.winner });

        const subs = await manager.getAllSubmissions(BigInt(total));
        setSlots(assignMiners(subs));

        // Detect first moment of finalization → notify parent to reload chain
        if (task.finalized && !prevFinalizedRef.current) {
          prevFinalizedRef.current = true;
          onBlockFinalized();
        }
      } catch { /* non-fatal */ }
    }

    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, [onBlockFinalized]);

  // Poll /jobs endpoint every 5s for proof status
  useEffect(() => {
    async function pollJobs() {
      try {
        const res = await fetch(`${PROVE_SERVER_URL}/jobs`, { signal: AbortSignal.timeout(4_000) });
        if (!res.ok) return;
        const data = await res.json();
        if (data.ok) setProofJobs(data.jobs);
      } catch { /* prove-server not running — silently skip */ }
    }
    pollJobs();
    const id = setInterval(pollJobs, 5000);
    return () => clearInterval(id);
  }, []);

  // Clear job start times when the block changes
  useEffect(() => {
    jobStartTimesRef.current = {};
  }, [liveTask?.id]);

  // Record the first time a pending/proving job appears for each miner on the current block
  useEffect(() => {
    if (!liveTask) return;
    for (const job of proofJobs) {
      if (job.task_id !== liveTask.id) continue;
      if (job.status !== "pending" && job.status !== "proving") continue;
      if (jobStartTimesRef.current[job.miner_id] === undefined) {
        jobStartTimesRef.current[job.miner_id] = Date.now();
      }
    }
  }, [proofJobs, liveTask?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // 1-second countdown tick
  useEffect(() => {
    if (!liveTask) return;
    function tick() {
      const diff = liveTask.deadline - Date.now();
      if (liveTask.finalized) { setCountdown("Finalized"); return; }
      if (diff <= 0)          { setCountdown("Closing…");  return; }
      const s = Math.floor(diff / 1000) % 60;
      const m = Math.floor(diff / 60000);
      setCountdown(m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`);
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [liveTask?.deadline, liveTask?.finalized]);

  if (!liveTask) return null;

  // Determine leading / winner slots
  const submitted     = slots.filter((s) => s.sub !== null);
  const leadingScore  = submitted.length > 0
    ? Math.max(...submitted.map((s) => Number(s.sub.score)))
    : -1;
  const winningSlot   = liveTask.finalized && submitted.length > 0
    ? submitted.reduce((best, s) => Number(s.sub.score) > Number(best.sub.score) ? s : best)
    : null;

  const timeColor = liveTask.finalized ? "#3ddc84"
    : (liveTask.deadline - Date.now() < 10000 ? "#ff6b6b" : "#f0c040");

  // Find the most recent proof job per miner_id (0-3) for the CURRENT block only.
  // Jobs from previous blocks are hidden — "Proof ready ✓" from block N should
  // not bleed into the display for block N+1.
  const latestJobByMiner = {};
  for (const job of proofJobs) {
    const mid = job.miner_id;
    if (latestJobByMiner[mid] !== undefined) continue; // already have newest
    if (job.task_id === liveTask.id) latestJobByMiner[mid] = job;
  }

  return (
    <div style={SL.section}>
      {inspectedMinerId !== null && (
        <MinerProfileModal
          minerId={inspectedMinerId}
          currentScore={slots[inspectedMinerId]?.sub ? Number(slots[inspectedMinerId].sub.score) : null}
          onClose={() => setInspectedMinerId(null)}
        />
      )}
      {/* Header */}
      <div style={SL.header}>
        <div style={SL.headerLeft}>
          <div style={S.sectionEyebrow}>
            <span style={S.sectionEyebrowDot} />
            LIVE MINING
            <span style={S.sectionEyebrowBar} />
          </div>
          <div style={SL.title}>
            Block
            <span style={SL.titleAccent}>#{String(liveTask.id).padStart(2, "0")}</span>
          </div>
          <div style={SL.subtitle}>
            {liveTask.finalized
              ? `Sealed · winner ${shortAddress(liveTask.winner)}`
              : submitted.length === 0
                ? "Awaiting first submission…"
                : `${submitted.length} of ${slots.length} miners have submitted`}
          </div>
        </div>

        {/* Countdown */}
        <div style={SL.timerBox}>
          <div style={SL.timerLabel}>{liveTask.finalized ? "COMPLETE" : "REMAINING"}</div>
          <div style={{ ...SL.timerVal, color: timeColor }}>{countdown}</div>
        </div>
      </div>

      {/* Miner cards */}
      <div style={SL.grid}>
        {slots.map((slot, i) => {
          const isWinner  = winningSlot?.name === slot.name;
          const isLeading = slot.sub !== null && Number(slot.sub.score) === leadingScore && leadingScore >= 0;
          return (
            <MinerCard
              key={slot.name}
              slot={slot}
              isWinner={isWinner}
              isLeading={isLeading}
              finalized={liveTask.finalized}
              proofJob={latestJobByMiner[i] ?? null}
              jobStartedAt={jobStartTimesRef.current[i] ?? null}
              onClick={() => setInspectedMinerId(i)}
              basicScore={basicScores[i] ?? null}
            />
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Chain view
// ---------------------------------------------------------------------------
function blockCacheKey(taskManagerAddr, taskId) {
  return `polchain_block_v2_${taskManagerAddr}_${taskId}`;
}

async function fetchBlockData(manager, task, taskManagerAddr, bypassCache = false) {
  const taskId = Number(task.id);

  // Return cached finalized blocks immediately (unless caller wants a fresh fetch)
  if (!bypassCache) {
    try {
      const hit = localStorage.getItem(blockCacheKey(taskManagerAddr, taskId));
      if (hit) return JSON.parse(hit);
    } catch { /* ignore */ }
  }

  // Fetch submissions + finalize tx in parallel
  const [subs, evts] = await Promise.all([
    task.winner !== ethers.ZeroAddress
      ? manager.getAllSubmissions(task.id)
      : Promise.resolve([]),
    manager.queryFilter(manager.filters.TaskFinalized(task.id)).catch(() => []),
  ]);

  const winnerSub = subs.find(
    (s) => s.miner.toLowerCase() === task.winner.toLowerCase()
  ) ?? null;

  const gradHash = winnerSub?.gradientHash ?? ZERO_HASH;
  const block = {
    id:         taskId,
    miner:      task.winner,
    score:      winnerSub ? Number(winnerSub.score) : null,
    zkVerified: winnerSub?.zkVerified ?? false,
    gradHash,
    timestamp:  winnerSub ? Number(winnerSub.submittedAt) * 1000 : null,
    txHash:     evts.length > 0 ? evts[0].transactionHash : null,
    noWinner:   task.winner === ethers.ZeroAddress,
  };

  try { localStorage.setItem(blockCacheKey(taskManagerAddr, taskId), JSON.stringify(block)); } catch { /* ignore */ }
  return block;
}

function clearBlockCache(taskManagerAddr) {
  // Clear all polchain_block_v2_* entries (any address) so a stale cache from
  // a prior deployment never sticks around.
  const prefix = "polchain_block_v2_";
  Object.keys(localStorage)
    .filter((k) => k.startsWith(prefix))
    .forEach((k) => localStorage.removeItem(k));
}

async function loadChain(manager, taskManagerAddr, bypassCache = false) {
  const total = Number(await manager.totalTasks());
  if (total === 0) return { blocks: [], pending: null };

  // Canary: if getTask(1) throws CALL_EXCEPTION the chain was reset at this
  // contract address — clear the stale cache and restart with fresh totalTasks().
  try {
    await manager.getTask(1n);
  } catch (e) {
    const isCallEx =
      e.code === "CALL_EXCEPTION" ||
      e.message?.includes("CALL_EXCEPTION") ||
      e.message?.includes("could not decode result data");
    if (isCallEx) {
      clearBlockCache(taskManagerAddr);
      const freshTotal = Number(await manager.totalTasks());
      if (freshTotal === 0) return { blocks: [], pending: null };
      // Re-enter with bypassCache so we don't hit the now-cleared stale entries
      return loadChain(manager, taskManagerAddr, true);
    }
    throw e;
  }

  // Fetch all tasks in parallel, from total down to 1 (no hardcoded start index)
  const allTaskResults = await Promise.all(
    Array.from({ length: total }, (_, i) =>
      manager.getTask(BigInt(total - i)).catch(() => null)
    )
  );
  // Reverse so tasks are ordered oldest-first for prevHash chaining below
  const allTasks = allTaskResults.reverse().filter(Boolean);

  const now       = Date.now();
  const finalized = allTasks.filter((t) => t.finalized);
  const active    = allTasks.filter((t) => !t.finalized && now < Number(t.deadline) * 1000);

  // Fetch all finalized block data in parallel (cache-first unless bypassCache)
  const blockData = await Promise.all(finalized.map((t) => fetchBlockData(manager, t, taskManagerAddr, bypassCache)));

  // Thread prevHash sequentially (each block's prevHash = prior block's gradHash)
  const blocks = [];
  let prevHash = ZERO_HASH;
  for (const b of blockData) {
    blocks.push({ ...b, prevHash });
    prevHash = b.gradHash;
  }

  let pending = null;
  if (active.length > 0) {
    const t     = active[active.length - 1];
    const count = Number(await manager.getSubmissionCount(t.id));
    pending = { id: Number(t.id), deadline: Number(t.deadline) * 1000, submissionCount: count, prevHash };
  }

  return { blocks, pending };
}

export default function Chain() {
  const [blocks,      setBlocks]      = useState(null);
  const [pending,     setPending]     = useState(null);
  const [error,       setError]       = useState("");
  const [refreshing,  setRefreshing]  = useState(false);
  const [inspectId,   setInspectId]   = useState(null); // taskId being inspected
  const [attackCard,  setAttackCard]  = useState(null); // { phase, logLines, txHash, readableAt }
  const [attackBusy,  setAttackBusy]  = useState(false);
  const [toast,       setToast]       = useState("");
  const [showReport,  setShowReport]  = useState(false);
  const [reportTxHash, setReportTxHash] = useState(null);
  const reportResolverRef = useRef(null); // resolves the "wait for click or timeout" promise
  const scrollRef   = useRef(null);
  const managerRef  = useRef(null);
  const loadingRef  = useRef(false);

  // Mode + addresses — both fetched at runtime from the admin server so
  // redeploys propagate without a hard reload. Addresses are seeded
  // synchronously from the build-time bundled values so the UI renders
  // immediately even if the admin server is down.
  const [activeMode, setActiveMode] = useState("advanced");
  const [addresses,  setAddresses]  = useState(BUILD_TIME_ADDRESSES);

  useEffect(() => {
    fetch(`${ADMIN_API}/api/mode`)
      .then((r) => r.json())
      .then((d) => { if (d.mode) setActiveMode(d.mode); })
      .catch(() => {});
    fetchAddresses().then((a) => { if (a) setAddresses(a); });
  }, []);

  // Periodically re-fetch addresses so a redeploy propagates within ~15s
  // even if the polling loop happens to be quiet.
  useEffect(() => {
    const id = setInterval(() => { fetchAddresses().then((a) => { if (a) setAddresses(a); }); }, 15_000);
    return () => clearInterval(id);
  }, []);

  const taskManagerAddr = pickTaskManager(addresses, activeMode);

  // Refetch addresses on demand (e.g. after a CALL_EXCEPTION). Rebuilds the
  // manager contract instance with the new address and clears stale block cache.
  const refreshAddresses = useCallback(async () => {
    const fresh = await fetchAddresses();
    if (!fresh) return null;
    setAddresses(fresh);
    const newAddr = pickTaskManager(fresh, activeMode);
    if (newAddr && newAddr !== taskManagerAddr) {
      clearBlockCache(newAddr);
      managerRef.current = getManager(newAddr, getReadProvider());
    }
    return newAddr;
  }, [activeMode, taskManagerAddr]);

  const doLoad = useCallback(async (bypassCache = false, silent = false) => {
    if (loadingRef.current) return;
    if (!managerRef.current || !taskManagerAddr) return;
    loadingRef.current = true;
    try {
      const { blocks: b, pending: p } = await loadChain(managerRef.current, taskManagerAddr, bypassCache);
      setBlocks(b);
      setPending(p);
      if (!silent) setError("");
    } catch (e) {
      const isStale =
        e.code === "CALL_EXCEPTION" ||
        e.message?.includes("CALL_EXCEPTION") ||
        e.message?.includes("could not decode result data");
      if (isStale) {
        // CALL_EXCEPTION can mean two very different things:
        //   (a) TaskManager was redeployed and our address is stale
        //   (b) the RPC endpoint can't reach the contract (CORS, rate limit,
        //       extension blocking, etc.) and is returning empty 0x bytes
        // Log full diagnostics so the cause is visible in devtools.
        // eslint-disable-next-line no-console
        console.error("[PoLChain] CALL_EXCEPTION on read", {
          taskManagerAddr,
          rpcUrls:    getRpcUrls(),
          errorCode:  e.code,
          errorMsg:   e.message,
          shortMsg:   e.shortMessage,
          info:       e.info,
          fullError:  e,
        });

        // Try to recover: refetch addresses (case a), reset the read provider
        // singleton to dump any stalled FallbackProvider state (case b),
        // clear stale block cache, and retry once.
        const newAddr = await refreshAddresses();
        const useAddr = newAddr || taskManagerAddr;
        resetReadProvider();
        managerRef.current = getManager(useAddr, getReadProvider());
        clearBlockCache(useAddr);
        try {
          const { blocks: b, pending: p } = await loadChain(managerRef.current, useAddr, true);
          setBlocks(b);
          setPending(p);
          if (!silent) setError("");
        } catch (e2) {
          // eslint-disable-next-line no-console
          console.error("[PoLChain] Recovery retry failed", e2);
          if (!silent) setError(
            `RPC call failed: ${e2.shortMessage || e2.message}\n` +
            `Contract: ${useAddr}\n` +
            `RPCs: ${getRpcUrls().join(", ")}\n\n` +
            `Open the browser console for full error details. Common causes:\n` +
            `  • Browser extension (ad blocker, privacy extension) blocking the RPC\n` +
            `  • Stale dev-server bundle — try a hard reload (Cmd+Shift+R)\n` +
            `  • RPC endpoint rate-limited — set VITE_BASE_SEPOLIA_RPC to your own Alchemy/Infura URL`
          );
        }
      } else {
        if (!silent) setError(e.message);
      }
    } finally {
      loadingRef.current = false;
    }
  }, [taskManagerAddr, refreshAddresses]);

  const doRefresh = useCallback(async () => {
    setRefreshing(true);
    await refreshAddresses();
    clearBlockCache(taskManagerAddr);
    await doLoad(true);
    setRefreshing(false);
  }, [doLoad, refreshAddresses, taskManagerAddr]);

  const handleOpenReport = useCallback(() => {
    // Resolve the waiting promise in handleAttack so the sequence can advance
    if (reportResolverRef.current) {
      reportResolverRef.current();
      reportResolverRef.current = null;
    }
    setShowReport(true);
  }, []);

  const handleAttack = useCallback(async () => {
    if (attackBusy) return;

    if (!pending) {
      setToast("No active block to attack");
      setTimeout(() => setToast(""), 3000);
      return;
    }

    setAttackBusy(true);

    // Fire API immediately — in parallel with the log animation
    const apiPromise = fetch(`${ADMIN_API}/api/simulate-attack`, { method: "POST" })
      .then((r) => r.json())
      .catch((e) => ({ error: e.message }));

    function pushLine(line) {
      setAttackCard((prev) => prev
        ? { ...prev, logLines: [...prev.logLines, line] }
        : prev
      );
    }

    // Phase 1: slide card in (empty log)
    setAttackCard({ phase: "entering", logLines: [], txHash: null, readableAt: null });
    await new Promise((r) => setTimeout(r, 350));

    // Phase 2: pulsing border — push log lines at timed intervals
    setAttackCard((prev) => prev ? { ...prev, phase: "active" } : prev);
    pushLine({ text: "Submitting fake proof to TaskManager...", red: false });

    await new Promise((r) => setTimeout(r, 800));
    pushLine({ text: "TaskManager forwards to Verifier contract", red: false });

    await new Promise((r) => setTimeout(r, 800));
    pushLine({ text: "Verifier.verifyProof() called", red: false });

    // Await API result (should already be settled by now)
    const result = await apiPromise;

    pushLine({ text: "Cryptographic verification failed", red: true });

    await new Promise((r) => setTimeout(r, 400));
    const revertMsg = result.revertReason || "TaskManager: invalid ZK proof";
    pushLine({ text: `Transaction reverted: ${revertMsg}`, red: true });

    await new Promise((r) => setTimeout(r, 400));
    pushLine({ text: "Miner receives 0 POL — block rejected", red: true });

    // Phase 3: flash border briefly
    setAttackCard((prev) => prev
      ? { ...prev, phase: "rejecting", txHash: result.txHash || null }
      : prev
    );
    await new Promise((r) => setTimeout(r, 800));

    // Phase 4: readable — show "View report →" + countdown progress bar
    // Wait for click OR 20-second timeout, whichever comes first
    const readableAt = Date.now();
    setReportTxHash(result.txHash || null);
    setAttackCard((prev) => prev
      ? { ...prev, phase: "readable", readableAt }
      : prev
    );

    await new Promise((resolve) => {
      reportResolverRef.current = resolve;
      setTimeout(() => {
        if (reportResolverRef.current === resolve) {
          reportResolverRef.current = null;
          resolve();
        }
      }, ATTACK_REPORT_TIMEOUT * 1000);
    });

    // Phase 5: REJECTED stamp + fade out
    setAttackCard((prev) => prev ? { ...prev, phase: "fading" } : prev);
    await new Promise((r) => setTimeout(r, 600));

    setAttackCard(null);
    setAttackBusy(false);
  }, [attackBusy, pending]);

  // Initial load + 5s poll for active task
  useEffect(() => {
    if (!taskManagerAddr) return;
    managerRef.current = getManager(taskManagerAddr, getReadProvider());
    doLoad();

    // Lightweight poll: re-fetch only totalTasks + getTask(totalTasks) every 5s.
    // Runs immediately on mount (no waiting for first interval tick) so a freshly
    // posted task appears right away. Also runs on a chain with 0 finalized blocks.
    async function poll() {
      try {
        const manager = managerRef.current;
        const total   = Number(await manager.totalTasks());
        if (total === 0) return;

        const task = await manager.getTask(BigInt(total));
        const now  = Date.now();

        if (!task.finalized && now < Number(task.deadline) * 1000) {
          // Task is live — update pending (creates it if absent so fresh chains show it)
          const count = Number(await manager.getSubmissionCount(task.id));
          setPending((prev) => {
            if (prev && prev.id === Number(task.id)) {
              return { ...prev, submissionCount: count };
            }
            // New pending task not yet in state (e.g. fresh chain) — trigger full reload
            try { doLoad(false, true); } catch { /* silent */ }
            return prev;
          });
        } else if (task.finalized) {
          // Task just finalized — reload full chain to move it into blocks[]
          try { doLoad(false, true); } catch { /* silent */ }
        }
        // deadline passed but not finalized yet: wait for miningLoop to finalize
      } catch (e) {
        // CALL_EXCEPTION usually means TaskManager was redeployed underneath us.
        // Refetch addresses; the useEffect will re-fire and rebuild managerRef.
        const isCallEx =
          e?.code === "CALL_EXCEPTION" ||
          e?.message?.includes("CALL_EXCEPTION") ||
          e?.message?.includes("could not decode result data");
        if (isCallEx) {
          refreshAddresses().catch(() => {});
        }
      }
    }

    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, [doLoad, taskManagerAddr, refreshAddresses]);

  // Scroll to end when chain changes
  useEffect(() => {
    if (blocks !== null && scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, [blocks, pending]);

  if (error) return (
    <pre style={{ ...S.notice, color: "#ff6b6b", textAlign: "left", whiteSpace: "pre-wrap", maxWidth: 720, margin: "40px auto", fontFamily: "monospace", fontSize: 12, lineHeight: 1.6 }}>
      {error}
    </pre>
  );
  if (blocks === null) return <p style={S.notice}>Loading chain…</p>;

  const minedCount = blocks.filter((b) => !b.noWinner).length;

  return (
    <InspectCtx.Provider value={setInspectId}>
    <div>
      {inspectId !== null && (
        <ProofInspector taskId={inspectId} onClose={() => setInspectId(null)} />
      )}
      {showReport && (
        <ZKAttackReportModal txHash={reportTxHash} onClose={() => setShowReport(false)} />
      )}
      {toast && (
        <div style={{
          position: "fixed", bottom: 28, left: "50%", transform: "translateX(-50%)",
          background: "#1a1a2e", border: "1px solid #3a3a5a", borderRadius: 6,
          padding: "8px 20px", fontSize: 12, color: "#a0b0ff",
          fontFamily: "monospace", zIndex: 9999, letterSpacing: 0.3,
          pointerEvents: "none",
        }}>
          {toast}
        </div>
      )}
      <style>{`
        @keyframes pulse-border {
          0%, 100% { border-color: #3a1a6a; box-shadow: 0 0 8px #3a1a6a44; }
          50%       { border-color: #7a3aaa; box-shadow: 0 0 18px #7a3aaa55; }
        }
        .pending-pulse { animation: pulse-border 2s ease-in-out infinite; }

        @keyframes winner-glow {
          0%   { box-shadow: none; }
          30%  { box-shadow: 0 0 0 2px #3ddc8466, 0 0 24px #3ddc8433; }
          70%  { box-shadow: 0 0 0 2px #3ddc8466, 0 0 24px #3ddc8433; }
          100% { box-shadow: none; }
        }
        .winner-flash { animation: winner-glow 2s ease-in-out 2; }

        @keyframes atk-enter {
          from { opacity: 0; transform: translateY(-10px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes atk-pulse {
          0%,100% { border-color: #4a1a1a; box-shadow: 0 0 6px #ff2a1a18; }
          50%     { border-color: #aa2222; box-shadow: 0 0 14px #ff2a1a44; }
        }
        @keyframes atk-flash {
          0%,100% { border-color: #aa2222; box-shadow: none; }
          40%     { border-color: #ff4444; box-shadow: 0 0 18px #ff444455; }
        }
        @keyframes atk-fade {
          from { opacity: 1; transform: translateY(0); }
          to   { opacity: 0; transform: translateY(-10px); }
        }
        @keyframes atk-stamp {
          from { opacity: 0; transform: scale(1.4) rotate(-12deg); }
          to   { opacity: 1; transform: scale(1)   rotate(-12deg); }
        }
        .atk-enter    { animation: atk-enter 0.35s ease-out forwards; }
        .atk-pulse    { animation: atk-pulse 1.2s ease-in-out infinite; }
        .atk-flash    { animation: atk-flash 0.45s ease-out 3; border-color: #aa2222 !important; }
        .atk-fade     { animation: atk-fade  0.6s  ease-out forwards; pointer-events: none; }
        .atk-stamp    { animation: atk-stamp 0.3s  ease-out forwards; }
        @keyframes atk-line-in {
          from { opacity: 0; transform: translateX(-4px); }
          to   { opacity: 1; transform: translateX(0); }
        }
        .atk-line-in  { animation: atk-line-in 0.2s ease-out forwards; }

        @keyframes zkn-in {
          from { opacity: 0; transform: scale(0.7); }
          to   { opacity: 1; transform: scale(1); }
        }
        .zkn-in { animation: zkn-in 0.5s cubic-bezier(0.34,1.56,0.64,1) forwards; transform-box: fill-box; transform-origin: 50% 50%; opacity: 0; }

        @keyframes zkd-draw {
          to { stroke-dashoffset: 0; }
        }
        .zkd-draw { animation: zkd-draw 0.4s ease-out forwards; }

        @keyframes zkl-in {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        .zkl-in { animation: zkl-in 0.4s ease-out forwards; opacity: 0; }
      `}</style>

      {/* ── Hero header ─────────────────────────────────────────────── */}
      <div style={S.hero}>
        <div style={S.heroEyebrow}>
          <span style={S.heroEyebrowBar} />
          PROOF OF LEARNING / BASE SEPOLIA
        </div>
        <h1 style={S.heroTitle}>POLCHAIN</h1>
        <p style={S.heroSub}>
          Every block is mined by submitting a verifiable zero-knowledge proof
          of AI gradient computation. Cryptographic infrastructure for trustless model training.
        </p>
      </div>

      {/* ── Stat bar ────────────────────────────────────────────────── */}
      <div style={S.statBar}>
        <div style={S.statCell}>
          <div style={S.statEyebrow}>
            <span style={S.heroEyebrowBar} />
            BLOCKS MINED
          </div>
          <div style={{ ...S.statValue, ...S.statValueAccent }}>
            {String(minedCount).padStart(2, "0")}
          </div>
          <div style={S.statSub}>finalized on-chain</div>
        </div>
        <div style={S.statCell}>
          <div style={S.statEyebrow}>
            <span style={S.heroEyebrowBar} />
            CURRENT BLOCK
          </div>
          <div style={S.statValue}>
            #{String(pending ? pending.id : minedCount).padStart(2, "0")}
          </div>
          <div style={S.statSub}>{pending ? "pending" : "awaiting next"}</div>
        </div>
        <div style={S.statCell}>
          <div style={S.statEyebrow}>
            <span style={pending ? S.liveDot : S.liveDotIdle} />
            STATUS
          </div>
          <div style={S.statValue}>
            {pending ? "LIVE" : "IDLE"}
          </div>
          <div style={S.statSub}>{pending ? "miners competing" : "no active block"}</div>
        </div>
        <div style={{ ...S.statCell, ...S.statCellLast }}>
          <div style={S.statEyebrow}>
            <span style={S.heroEyebrowBar} />
            ACTIONS
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
            <button
              style={{
                ...S.attackBtn,
                opacity: attackBusy ? 0.4 : 1,
                cursor:  attackBusy ? "not-allowed" : "pointer",
              }}
              onClick={handleAttack}
              disabled={attackBusy}
            >
              ⚡ {attackBusy ? "ATTACKING" : "ATTACK"}
            </button>
            <button
              style={{
                ...S.refreshBtn,
                opacity: refreshing ? 0.5 : 1,
                cursor:  refreshing ? "not-allowed" : "pointer",
              }}
              onClick={doRefresh}
              disabled={refreshing}
            >
              ⟳ {refreshing ? "SYNCING" : "REFRESH"}
            </button>
          </div>
        </div>
      </div>

      {/* ── Section eyebrow ─────────────────────────────────────────── */}
      <div style={S.sectionEyebrow}>
        <span style={S.sectionEyebrowDot} />
        CHAIN HISTORY
        <span style={S.sectionEyebrowBar} />
        <span className="mono" style={{ color: "var(--text-tertiary)" }}>
          {minedCount} BLOCKS
        </span>
      </div>

      {/* Blockchain scroll */}
      {blocks.length === 0 && !pending ? (
        <p style={S.notice}>No blocks yet. Run <code>npm run mining</code> to start the chain.</p>
      ) : (
        <div ref={scrollRef} style={S.scrollOuter}>
          <div style={S.chainRow}>
            <GenesisCard />
            {blocks.map((b) => (
              <div key={b.id} style={{ display: "contents" }}>
                <Arrow />
                <BlockCard block={b} />
              </div>
            ))}
            {attackCard && (
              <>
                <Arrow />
                <AttackCard card={attackCard} onOpenReport={handleOpenReport} />
              </>
            )}
            {pending && (
              <>
                <Arrow />
                <PendingCard pending={pending} />
              </>
            )}
          </div>
        </div>
      )}

      {/* Live Mining section */}
      <LiveMining taskManagerAddr={taskManagerAddr} onBlockFinalized={doLoad} />

      {/* ── Security explainer ──────────────────────────────────────── */}
      <div style={S.secSection}>
        <span style={S.secCornerTL} />
        <span style={S.secCornerBR} />
        <div style={S.secEyebrow}>◆ CRYPTOGRAPHIC GUARANTEES</div>
        <h2 style={S.secTitle}>How this secures the blockchain</h2>
        <div style={S.secGrid}>
          {[
            {
              num:  "01",
              head: "ZK proof required to mine",
              body: "Every block requires a valid zero-knowledge proof that the miner actually trained the model and achieved the claimed score. Fake submissions are rejected on-chain by the Halo2 verifier.",
            },
            {
              num:  "02",
              head: "Proof ties gradient to model state",
              body: "The gradient hash commits to the exact weight updates applied during training. Any tampering changes the hash and invalidates the cryptographic proof.",
            },
            {
              num:  "03",
              head: "Chain is tamper-proof",
              body: "Each block's prev hash is the winning gradient hash of the round before. Altering any block invalidates every subsequent proof, making history immutable.",
            },
          ].map(({ num, head, body }) => (
            <div key={head} style={S.secItem}>
              <span style={S.secItemAccent} />
              <div style={S.secNum}>{num}</div>
              <div style={S.secHead}>{head}</div>
              <div style={S.secText}>{body}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
    </InspectCtx.Provider>
  );
}

// ---------------------------------------------------------------------------
// Chain styles
// ---------------------------------------------------------------------------
const BLOCK_W = 224;
const BLOCK_H = 224;

const S = {
  notice: {
    color: "var(--text-tertiary)",
    padding: "60px 0",
    textAlign: "center",
    fontFamily: "var(--font-sans)",
    fontSize: 13,
  },

  // ── Hero header ──────────────────────────────────────────────────────────
  hero: {
    paddingTop: 12,
    marginBottom: 28,
  },
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
    width: 24,
    height: 1,
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
    maxWidth: 560,
    lineHeight: 1.6,
  },

  // ── Stat bar ─────────────────────────────────────────────────────────────
  statBar: {
    display: "grid",
    gridTemplateColumns: "1.1fr 1fr 1fr 1fr",
    gap: 0,
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-lg)",
    padding: 0,
    marginBottom: 12,
    overflow: "hidden",
    position: "relative",
  },
  statCell: {
    padding: "22px 24px 22px",
    borderRight: "1px solid var(--border)",
    position: "relative",
  },
  statCellLast: { borderRight: "none" },
  statEyebrow: {
    fontFamily: "var(--font-mono)",
    fontSize: 9,
    fontWeight: 500,
    letterSpacing: "0.16em",
    textTransform: "uppercase",
    color: "var(--text-tertiary)",
    marginBottom: 12,
    display: "flex",
    alignItems: "center",
    gap: 7,
  },
  statValue: {
    fontFamily: "var(--font-mono)",
    fontSize: 38,
    fontWeight: 600,
    letterSpacing: "-0.02em",
    color: "var(--text-primary)",
    lineHeight: 1,
    fontVariantNumeric: "tabular-nums",
  },
  statValueAccent: {
    color: "var(--accent)",
    textShadow: "0 0 24px var(--accent-glow-md)",
  },
  statSub: {
    marginTop: 8,
    fontSize: 10,
    color: "var(--text-tertiary)",
    fontFamily: "var(--font-mono)",
    letterSpacing: "0.04em",
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: "var(--accent)",
    boxShadow: "0 0 12px var(--accent)",
    animation: "pulse-glow 2s ease-in-out infinite",
    flexShrink: 0,
  },
  liveDotIdle: {
    width: 8, height: 8, borderRadius: "50%",
    background: "var(--text-faint)", flexShrink: 0,
  },
  statActions: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 10,
    padding: "0 4px 0 0",
  },
  refreshBtn: {
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    color: "var(--text-secondary)",
    padding: "9px 16px",
    borderRadius: "var(--radius-sm)",
    fontSize: 11,
    fontFamily: "var(--font-mono)",
    letterSpacing: "0.06em",
    cursor: "pointer",
    transition: "all 200ms var(--ease-out)",
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
  },
  attackBtn: {
    background: "transparent",
    border: "1px solid rgba(255, 77, 109, 0.3)",
    color: "#ff7a8e",
    padding: "9px 16px",
    borderRadius: "var(--radius-sm)",
    fontSize: 11,
    fontFamily: "var(--font-mono)",
    cursor: "pointer",
    letterSpacing: "0.06em",
    transition: "all 200ms var(--ease-out)",
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
  },

  // ── Section eyebrow ──────────────────────────────────────────────────────
  sectionEyebrow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    margin: "44px 0 22px",
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    letterSpacing: "0.2em",
    textTransform: "uppercase",
    color: "var(--text-tertiary)",
  },
  sectionEyebrowBar: {
    flex: 1,
    height: 1,
    background: "var(--border)",
  },
  sectionEyebrowDot: {
    width: 6, height: 6,
    background: "var(--accent)",
    boxShadow: "0 0 10px var(--accent)",
  },

  // ── Chain scroller ───────────────────────────────────────────────────────
  scrollOuter: {
    overflowX: "auto",
    overflowY: "visible",
    paddingBottom: 16,
    paddingTop: 8,
    marginBottom: 8,
    maskImage: "linear-gradient(to right, transparent 0, #000 32px, #000 calc(100% - 32px), transparent 100%)",
    WebkitMaskImage: "linear-gradient(to right, transparent 0, #000 32px, #000 calc(100% - 32px), transparent 100%)",
  },
  chainRow: {
    display: "flex",
    alignItems: "stretch",
    minWidth: "max-content",
    padding: "16px 28px 16px",
    gap: 0,
  },

  // ── Block card ───────────────────────────────────────────────────────────
  block: {
    position: "relative",
    width: BLOCK_W,
    minHeight: BLOCK_H,
    borderRadius: "var(--radius-lg)",
    padding: "18px 20px 16px",
    flexShrink: 0,
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    boxSizing: "border-box",
    transition: "all 220ms var(--ease-out)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  blockHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 16,
  },
  blockNum: {
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: "0.14em",
    color: "var(--text-tertiary)",
    textTransform: "uppercase",
  },
  blockNumValue: {
    fontFamily: "var(--font-sans)",
    fontSize: 22,
    fontWeight: 700,
    color: "var(--text-primary)",
    letterSpacing: "-0.02em",
    marginTop: 2,
    lineHeight: 1,
  },

  winnerLine: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginTop: 10,
    fontFamily: "var(--font-mono)",
  },
  winnerAddr: {
    fontSize: 10,
    color: "var(--text-secondary)",
    letterSpacing: "0.02em",
  },
  winnerDot: {
    width: 4, height: 4, borderRadius: "50%",
    background: "var(--text-tertiary)",
  },

  zkBadge: {
    fontFamily: "var(--font-mono)",
    fontSize: 9,
    fontWeight: 600,
    color: "var(--accent)",
    border: "1px solid var(--accent-deep)",
    background: "var(--accent-tint)",
    borderRadius: "var(--radius-sm)",
    padding: "4px 8px",
    letterSpacing: "0.1em",
    cursor: "default",
    boxShadow: "0 0 18px var(--accent-glow)",
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
  },
  basicBadge: {
    fontFamily: "var(--font-mono)",
    fontSize: 9,
    color: "var(--text-tertiary)",
    border: "1px solid var(--border-strong)",
    background: "transparent",
    borderRadius: "var(--radius-sm)",
    padding: "4px 8px",
    letterSpacing: "0.1em",
  },
  pendingBadge: {
    fontFamily: "var(--font-mono)",
    fontSize: 9,
    fontWeight: 600,
    color: "var(--accent)",
    border: "1px solid var(--accent-deep)",
    background: "var(--accent-tint)",
    borderRadius: "var(--radius-sm)",
    padding: "4px 8px",
    letterSpacing: "0.1em",
  },

  // Block body
  blockSpace: { flex: 1 },
  scoreLine: { display: "flex", alignItems: "baseline", gap: 4, marginBottom: 12 },
  scoreVal: {
    fontFamily: "var(--font-mono)",
    fontSize: 34,
    fontWeight: 600,
    color: "var(--text-primary)",
    lineHeight: 1,
    letterSpacing: "-0.02em",
    fontVariantNumeric: "tabular-nums",
  },
  scoreDenom: {
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    color: "var(--text-dim)",
  },

  fieldGroup: { marginBottom: 6, display: "flex", flexDirection: "column", gap: 2 },
  label: {
    fontFamily: "var(--font-mono)",
    fontSize: 8,
    color: "var(--text-tertiary)",
    letterSpacing: "0.16em",
    textTransform: "uppercase",
  },
  mono: {
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    color: "var(--text-secondary)",
    letterSpacing: "0.02em",
  },
  txLink: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    marginTop: 12,
    fontFamily: "var(--font-mono)",
    fontSize: 9,
    color: "var(--accent)",
    textDecoration: "none",
    letterSpacing: "0.06em",
  },

  // Pending card
  pendingBlock: {
    position: "relative",
    width: BLOCK_W,
    minHeight: BLOCK_H,
    borderRadius: "var(--radius-lg)",
    padding: "18px 20px 16px",
    flexShrink: 0,
    background: "linear-gradient(180deg, var(--bg-elevated) 0%, rgba(0, 245, 255, 0.04) 100%)",
    border: "1px solid var(--accent-deep)",
    boxSizing: "border-box",
    boxShadow: "0 0 32px var(--accent-glow)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  pendingCorner: {
    position: "absolute",
    top: -1, right: -1,
    width: 32, height: 32,
    borderTop: "1px solid var(--accent)",
    borderRight: "1px solid var(--accent)",
    borderTopRightRadius: "var(--radius-lg)",
    boxShadow: "0 0 12px var(--accent-glow-md)",
  },

  // Genesis card
  genesisBlock: {
    position: "relative",
    width: BLOCK_W,
    minHeight: BLOCK_H,
    borderRadius: "var(--radius-lg)",
    padding: "18px 20px 16px",
    flexShrink: 0,
    background: "var(--bg-inset)",
    border: "1px dashed var(--border-strong)",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
  },
  genesisRune: {
    position: "absolute",
    top: 16, right: 16,
    width: 28, height: 28,
    border: "1px solid var(--text-dim)",
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--text-dim)",
    fontFamily: "var(--font-mono)",
    fontSize: 11,
  },

  // ── Connector arrow between blocks ───────────────────────────────────────
  arrow: {
    display: "flex",
    alignItems: "center",
    flexShrink: 0,
    padding: "0 14px",
    color: "var(--text-faint)",
  },
  arrowLine: {
    width: 28,
    height: 1,
    background: "linear-gradient(90deg, var(--text-faint), var(--text-dim), var(--text-faint))",
  },
  arrowDot: {
    width: 4, height: 4, borderRadius: "50%",
    background: "var(--text-dim)",
    margin: "0 2px",
  },

  // ── Security explainer ──────────────────────────────────────────────────
  secSection: {
    position: "relative",
    marginTop: 56,
    padding: "44px 36px 40px",
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-xl)",
    overflow: "hidden",
  },
  secCornerTL: {
    position: "absolute",
    top: -1, left: -1,
    width: 56, height: 56,
    borderTop: "1px solid var(--accent)",
    borderLeft: "1px solid var(--accent)",
    borderTopLeftRadius: "var(--radius-xl)",
    boxShadow: "0 0 18px var(--accent-glow-md)",
  },
  secCornerBR: {
    position: "absolute",
    bottom: -1, right: -1,
    width: 56, height: 56,
    borderBottom: "1px solid var(--accent)",
    borderRight: "1px solid var(--accent)",
    borderBottomRightRadius: "var(--radius-xl)",
    boxShadow: "0 0 18px var(--accent-glow-md)",
  },
  secEyebrow: {
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    letterSpacing: "0.2em",
    textTransform: "uppercase",
    color: "var(--accent)",
    marginBottom: 12,
  },
  secTitle: {
    fontFamily: "var(--font-sans)",
    color: "var(--text-primary)",
    fontSize: 28,
    fontWeight: 700,
    letterSpacing: "-0.025em",
    marginBottom: 32,
    maxWidth: 540,
    lineHeight: 1.15,
  },
  secGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 28,
  },
  secItem: {
    display: "flex",
    flexDirection: "column",
    gap: 14,
    paddingTop: 18,
    borderTop: "1px solid var(--border)",
    position: "relative",
  },
  secItemAccent: {
    position: "absolute",
    top: -1,
    left: 0,
    width: 32,
    height: 1.5,
    background: "var(--accent)",
    boxShadow: "0 0 8px var(--accent)",
  },
  secNum: {
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    color: "var(--text-tertiary)",
    letterSpacing: "0.14em",
  },
  secHead: {
    fontFamily: "var(--font-sans)",
    fontSize: 15,
    fontWeight: 600,
    color: "var(--text-primary)",
    letterSpacing: "-0.01em",
    lineHeight: 1.3,
  },
  secText: {
    fontFamily: "var(--font-sans)",
    fontSize: 13,
    color: "var(--text-secondary)",
    lineHeight: 1.65,
  },
};

// ---------------------------------------------------------------------------
// Live mining styles
// ---------------------------------------------------------------------------
const SL = {
  section: { marginTop: 8, marginBottom: 8 },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-end",
    marginBottom: 22,
    gap: 24,
  },
  headerLeft: { display: "flex", flexDirection: "column", gap: 6 },
  title: {
    fontFamily: "var(--font-sans)",
    color: "var(--text-primary)",
    fontSize: 22,
    fontWeight: 700,
    letterSpacing: "-0.02em",
    lineHeight: 1.1,
  },
  titleAccent: {
    color: "var(--accent)",
    fontFamily: "var(--font-mono)",
    fontWeight: 600,
    fontSize: 20,
    marginLeft: 6,
  },
  subtitle: {
    color: "var(--text-tertiary)",
    fontSize: 12,
    fontFamily: "var(--font-sans)",
  },

  timerBox: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: 4,
    padding: "12px 18px",
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
    minWidth: 120,
  },
  timerLabel: {
    fontSize: 9,
    color: "var(--text-tertiary)",
    letterSpacing: "0.16em",
    textTransform: "uppercase",
    fontFamily: "var(--font-mono)",
  },
  timerVal: {
    fontSize: 28,
    fontWeight: 600,
    fontFamily: "var(--font-mono)",
    lineHeight: 1,
    fontVariantNumeric: "tabular-nums",
    letterSpacing: "-0.02em",
  },

  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: 14,
    marginBottom: 4,
  },

  card: {
    position: "relative",
    borderRadius: "var(--radius-lg)",
    padding: "20px 20px 18px",
    fontFamily: "var(--font-sans)",
    border: "1px solid var(--border)",
    background: "var(--bg-elevated)",
    boxSizing: "border-box",
    transition: "all 240ms var(--ease-out)",
    cursor: "pointer",
    overflow: "hidden",
    minHeight: 178,
  },
  cardAccent: {
    position: "absolute",
    top: 0, left: 0, right: 0,
    height: 2,
    transformOrigin: "left",
    transition: "all 240ms var(--ease-out)",
  },

  cardTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 18,
  },
  minerNameRow: { display: "flex", alignItems: "center", gap: 8 },
  minerDot: {
    width: 7, height: 7, borderRadius: "50%",
    flexShrink: 0,
    transition: "all 240ms var(--ease-out)",
  },
  minerName: {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "0.04em",
    fontFamily: "var(--font-sans)",
    color: "var(--text-primary)",
  },

  winnerBadge: {
    fontFamily: "var(--font-mono)",
    fontSize: 8,
    fontWeight: 700,
    color: "var(--bg-base)",
    background: "var(--accent)",
    borderRadius: 2,
    padding: "3px 7px",
    letterSpacing: "0.14em",
    boxShadow: "0 0 12px var(--accent-glow-lg)",
  },
  leadingBadge: {
    fontFamily: "var(--font-mono)",
    fontSize: 8,
    fontWeight: 600,
    color: "var(--accent)",
    background: "var(--accent-tint)",
    border: "1px solid var(--accent-deep)",
    borderRadius: 2,
    padding: "2px 6px",
    letterSpacing: "0.14em",
  },

  scoreRow: {
    display: "flex",
    alignItems: "baseline",
    gap: 2,
    marginBottom: 4,
    fontFamily: "var(--font-mono)",
  },
  scoreVal: {
    fontSize: 44,
    fontWeight: 600,
    lineHeight: 1,
    fontVariantNumeric: "tabular-nums",
    letterSpacing: "-0.03em",
    transition: "color 240ms var(--ease-out)",
  },
  scoreDenom: {
    fontSize: 14,
    color: "var(--text-dim)",
    marginLeft: 2,
  },
  reward: {
    fontSize: 11,
    color: "var(--accent)",
    fontFamily: "var(--font-mono)",
    letterSpacing: "0.05em",
    marginTop: 2,
    textShadow: "0 0 12px var(--accent-glow)",
  },
  subTime: {
    fontSize: 9,
    color: "var(--text-tertiary)",
    fontFamily: "var(--font-mono)",
    marginTop: 6,
    letterSpacing: "0.04em",
  },
  waiting: {
    fontSize: 11,
    color: "var(--text-dim)",
    marginTop: 8,
    fontFamily: "var(--font-mono)",
    letterSpacing: "0.04em",
  },

  proofStatus: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    marginTop: 12,
    fontSize: 9,
    color: "var(--text-tertiary)",
    fontFamily: "var(--font-mono)",
    letterSpacing: "0.04em",
  },
  proofDot: {
    display: "inline-block",
    width: 5, height: 5, borderRadius: "50%",
    background: "var(--text-tertiary)",
    flexShrink: 0,
  },
};

// ---------------------------------------------------------------------------
// Proof Inspector modal styles
// ---------------------------------------------------------------------------
const SM = {
  overlay: {
    position: "fixed", inset: 0, zIndex: 1000,
    background: "rgba(0,0,0,0.72)", backdropFilter: "blur(2px)",
    display: "flex", alignItems: "center", justifyContent: "center",
    padding: 24,
  },
  panel: {
    background: "#0b0b18", border: "1px solid #2a2a44", borderRadius: 8,
    width: "100%", maxWidth: 600, maxHeight: "85vh",
    display: "flex", flexDirection: "column",
    boxShadow: "0 8px 40px rgba(0,0,0,0.7)",
    fontFamily: "'Courier New', Courier, monospace",
  },
  header: {
    display: "flex", justifyContent: "space-between", alignItems: "flex-start",
    padding: "18px 20px 14px", borderBottom: "1px solid #1a1a2e",
    flexShrink: 0,
  },
  title:    { fontSize: 13, fontWeight: "bold", color: "#a0b0ff", letterSpacing: 0.5, marginBottom: 4 },
  subtitle: { fontSize: 10, color: "#555" },
  zkBadge:  {
    fontSize: 9, color: "#3ddc84", border: "1px solid #1a4a2a",
    background: "#061410", borderRadius: 3, padding: "2px 8px", letterSpacing: 0.5,
  },
  basicBadge: {
    fontSize: 9, color: "#666", border: "1px solid #222",
    background: "#0e0e18", borderRadius: 3, padding: "2px 8px", letterSpacing: 0.5,
  },
  zkNote: {
    fontSize: 10, color: "#4a8a60", background: "#040e08",
    border: "1px solid #0e2a18", borderRadius: 4,
    padding: "6px 10px", marginBottom: 14, letterSpacing: 0.2,
  },
  closeBtn: {
    background: "transparent", border: "none", color: "#555", cursor: "pointer",
    fontSize: 16, padding: "0 2px", lineHeight: 1,
  },
  body: {
    overflowY: "auto", padding: "16px 20px 20px",
    scrollbarWidth: "thin", scrollbarColor: "#1e1e30 transparent",
  },
  noProof: {
    color: "#666", fontSize: 11, fontStyle: "italic",
    padding: "16px 0", textAlign: "center",
  },
  section:      { marginBottom: 20 },
  sectionTitle: {
    fontSize: 9, color: "#444", letterSpacing: 1.5,
    textTransform: "uppercase", marginBottom: 8,
  },
  hexBox: {
    background: "#06060e", border: "1px solid #111120", borderRadius: 4,
    padding: "10px 12px", display: "flex", alignItems: "flex-start", gap: 8,
  },
  hexText: {
    flex: 1, fontSize: 9, color: "#3a6aaa", wordBreak: "break-all",
    lineHeight: 1.6, letterSpacing: 0.3,
  },
  copyBtn: {
    background: "transparent", border: "none", cursor: "pointer",
    fontSize: 9, flexShrink: 0, padding: "1px 0", letterSpacing: 0.3,
    transition: "color 0.2s",
  },
  instanceList: {
    background: "#06060e", border: "1px solid #111120", borderRadius: 4,
    padding: "8px 12px", display: "flex", flexDirection: "column", gap: 3,
    maxHeight: 140, overflowY: "auto",
    scrollbarWidth: "thin", scrollbarColor: "#1e1e30 transparent",
  },
  instanceRow:  { display: "flex", gap: 8, alignItems: "baseline" },
  instanceIdx:  { fontSize: 8, color: "#333", width: 22, flexShrink: 0 },
  instanceVal:  { fontSize: 9, color: "#6080aa", letterSpacing: 0.3 },
  detailRow: {
    display: "flex", gap: 12, alignItems: "flex-start",
    marginBottom: 10, fontSize: 11,
  },
  detailLabel: {
    fontSize: 8, color: "#444", letterSpacing: 1, textTransform: "uppercase",
    width: 100, flexShrink: 0, paddingTop: 2,
  },
  augLabel: { color: "#a0b0ff", fontSize: 10, fontWeight: "bold" },
  augDesc:  { color: "#555", fontSize: 9, marginTop: 3, lineHeight: 1.5 },
  digitBadge: {
    display: "inline-block", width: 22, height: 22, lineHeight: "22px",
    textAlign: "center", borderRadius: 4, fontSize: 10, fontWeight: "bold",
    background: "#0e1a2e", border: "1px solid #2a3a6a", color: "#6b8fff",
  },

  // Weight chain section
  wcRow: { display: "flex", alignItems: "flex-end", gap: 8, marginBottom: 8 },
  wcHashBox: {
    flex: 1, background: "#06060e", border: "1px solid #111120", borderRadius: 4,
    padding: "7px 10px",
  },
  wcHashLabel: {
    fontSize: 8, color: "#444", letterSpacing: 1,
    textTransform: "uppercase", marginBottom: 3,
  },
  wcHashVal: {
    fontSize: 9, color: "#3a6aaa", letterSpacing: 0.3,
    marginBottom: 4, wordBreak: "break-all",
  },
  wcArrow:  { fontSize: 14, color: "#333", flexShrink: 0, paddingBottom: 8 },
  wcMeta:   {
    display: "flex", alignItems: "center",
    fontSize: 10, color: "#555", marginBottom: 5,
  },
  wcSep:    { margin: "0 8px", color: "#333" },
  wcCaption:{ fontSize: 9, color: "#444", fontStyle: "italic", letterSpacing: 0.2 },
};

