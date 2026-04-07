import { useEffect, useRef, useState, useCallback, useContext, createContext } from "react";
import { ethers } from "ethers";
import { ADDRESSES, TASK_MANAGER_ABI, getActiveTaskManager } from "../contracts";
import { getReadProvider, shortAddress } from "../wallet";

const BASESCAN   = "https://sepolia.basescan.org";
const ZERO_HASH  = "0x" + "0".repeat(64);
const ADMIN_API  = "http://localhost:3001";

// Context so BlockCard can trigger the inspector without prop-drilling
const InspectCtx = createContext(null);

// Named miners matching autoMiner.js — all share one wallet, so we match
// on-chain submissions to miner slots by score proximity to each base.
const MINER_PROFILES = [
  {
    id: 0, shard: 0, name: "Miner Alpha", color: "#6b8fff", base: 82,
    icon: "⟳", aug: "Random Rotation ±15°",
    desc: "Rotates each digit image by a random angle up to ±15° every epoch — trains the model to be rotation-invariant.",
  },
  {
    id: 1, shard: 1, name: "Miner Beta",  color: "#f0c040", base: 50,
    icon: "≋", aug: "Gaussian Noise σ=0.1",
    desc: "Adds Gaussian noise (σ=0.1) to pixel values each epoch — improves robustness to noisy or corrupted inputs.",
  },
  {
    id: 2, shard: 2, name: "Miner Gamma", color: "#3ddc84", base: 92,
    icon: "▪", aug: "Random Erasing 10–20%",
    desc: "Zeros out a random rectangular patch covering 10–20% of pixels each epoch — trains the model to handle occlusion.",
  },
  {
    id: 3, shard: 3, name: "Miner Delta", color: "#b07fff", base: 83,
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
    <div style={S.block}>
      <div style={S.blockHeader}>
        <span style={{ ...S.blockNum, color: "#6b8fff" }}>GENESIS</span>
      </div>
      <div style={S.fieldGroup}>
        <span style={S.label}>ORIGIN</span>
        <span style={{ ...S.mono, color: "#555" }}>PoLChain v1</span>
      </div>
      <div style={S.fieldGroup}>
        <span style={S.label}>PREV HASH</span>
        <span style={{ ...S.mono, color: "#333" }}>{shortHash(ZERO_HASH)}</span>
      </div>
      <div style={S.fieldGroup}>
        <span style={S.label}>GRAD HASH</span>
        <span style={{ ...S.mono, color: "#333" }}>{shortHash(ZERO_HASH)}</span>
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
  return (
    <div
      style={{
        ...S.block,
        background:  block.noWinner ? "#100808" : "#080e10",
        borderColor: block.noWinner ? "#3a1a1a" : "#1a3a2a",
        cursor: "pointer",
      }}
      onClick={() => openInspector(block.id)}
      title="Click to inspect proof"
    >
      <div style={S.blockHeader}>
        <div>
          <span style={{ ...S.blockNum, color: block.noWinner ? "#ff6b6b" : "#3ddc84" }}>
            BLOCK #{block.id}
          </span>
          {!block.noWinner && (
            <div style={S.winnerLine}>
              <span style={S.winnerLabel}>Winner</span>
              <span style={S.winnerAddr}>{shortAddress(block.miner)}</span>
            </div>
          )}
        </div>
        {!block.noWinner && (
          block.zkVerified ? (
            <span style={S.zkBadge}>ZK✓</span>
          ) : (
            <span style={S.basicBadge}>BASIC</span>
          )
        )}
      </div>

      {block.noWinner ? (
        <div style={S.fieldGroup}>
          <span style={{ ...S.label, color: "#5a2020" }}>RESULT</span>
          <span style={{ ...S.mono, color: "#ff6b6b" }}>No winner</span>
        </div>
      ) : (
        <div style={S.fieldGroup}>
          <span style={S.label}>SCORE</span>
          <span style={{ ...S.mono, color: "#d0d0e0" }}>{block.score}/100</span>
        </div>
      )}

      <div style={S.fieldGroup}>
        <span style={S.label}>GRAD HASH</span>
        <span style={S.mono}>{shortHash(block.gradHash)}</span>
      </div>
      <div style={S.fieldGroup}>
        <span style={S.label}>PREV HASH</span>
        <span style={{ ...S.mono, color: "#333" }}>{shortHash(block.prevHash)}</span>
      </div>
      {block.timestamp && (
        <div style={S.fieldGroup}>
          <span style={S.label}>MINED</span>
          <span style={{ ...S.mono, fontSize: 9, color: "#555" }}>
            {new Date(block.timestamp).toLocaleString()}
          </span>
        </div>
      )}
      {block.txHash && (
        <a href={`${BASESCAN}/tx/${block.txHash}`} target="_blank" rel="noreferrer" style={S.txLink}>
          view tx ↗
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
      <div style={S.blockHeader}>
        <span style={{ ...S.blockNum, color: "#b07fff" }}>BLOCK #{pending.id}</span>
        <span style={S.pendingBadge}>PENDING</span>
      </div>
      <div style={S.fieldGroup}>
        <span style={S.label}>STATUS</span>
        <span style={{ ...S.mono, color: "#b07fff" }}>Miners competing…</span>
      </div>
      <div style={S.fieldGroup}>
        <span style={S.label}>SUBMISSIONS</span>
        <span style={S.mono}>{pending.submissionCount}</span>
      </div>
      <div style={S.fieldGroup}>
        <span style={S.label}>PREV HASH</span>
        <span style={{ ...S.mono, color: "#333" }}>{shortHash(pending.prevHash)}</span>
      </div>
      <div style={S.fieldGroup}>
        <span style={S.label}>DEADLINE</span>
        <span style={{ ...S.mono, fontSize: 9, color: "#666" }}>{label}</span>
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
      <div style={S.arrowHead} />
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

  return (
    <div
      className={isWinner ? "winner-flash" : ""}
      style={{
        ...SL.card,
        background:  isWinner ? "#061410" : submitted ? "#08100e" : "#080810",
        borderColor: isWinner ? "#2a6a3a" : submitted ? "#183828" : "#1a1a2a",
        transition:  "background 0.6s, border-color 0.6s",
        cursor: "pointer",
      }}
      onClick={onClick}
      title="Click for miner profile"
    >
      {/* Name row */}
      <div style={SL.cardTop}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <div style={{
            width: 7, height: 7, borderRadius: "50%",
            background:  submitted ? slot.color : "#2a2a2a",
            boxShadow:   submitted ? `0 0 6px ${slot.color}88` : "none",
            transition:  "background 0.4s, box-shadow 0.4s",
            flexShrink: 0,
          }} />
          <span style={{ ...SL.minerName, color: isWinner ? "#3ddc84" : submitted ? "#c0c0d8" : "#555" }}>
            {slot.name}
          </span>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {isWinner && <span style={SL.winnerBadge}>WINNER</span>}
          {isLeading && !finalized && <span style={SL.leadingBadge}>LEADING</span>}
        </div>
      </div>

      {/* Score or waiting */}
      {submitted ? (
        <>
          <div style={SL.scoreRow}>
            <span style={{ ...SL.scoreVal, color: isWinner ? "#3ddc84" : slot.color }}>
              {score}
            </span>
            <span style={SL.scoreDenom}>/100</span>
          </div>
          {isWinner && <div style={SL.reward}>+100 POL</div>}
          <div style={SL.subTime}>
            {new Date(subTime).toLocaleTimeString()}
          </div>
        </>
      ) : basicScore !== null ? (
        <div style={SL.scoreRow}>
          <span style={{ ...SL.scoreVal, color: slot.color }}>{basicScore}</span>
          <span style={SL.scoreDenom}>/100</span>
        </div>
      ) : (
        <div style={SL.waiting}>Waiting…</div>
      )}

      {/* Proof status — only shown after gradient has been submitted */}
      {submitted && proofLabel}
    </div>
  );
}

const PROVE_SERVER_URL = "http://localhost:5001";

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
        <div>
          <div style={SL.title}>Live Mining — Block #{liveTask.id}</div>
          <div style={SL.subtitle}>
            {liveTask.finalized
              ? `Block finalized · winner: ${shortAddress(liveTask.winner)}`
              : submitted.length === 0
                ? "Waiting for miners…"
                : `${submitted.length} of ${slots.length} miners submitted`}
          </div>
        </div>

        {/* Countdown */}
        <div style={SL.timerBox}>
          <div style={{ ...SL.timerVal, color: timeColor }}>{countdown}</div>
          <div style={SL.timerLabel}>{liveTask.finalized ? "COMPLETE" : "REMAINING"}</div>
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
function blockCacheKey(taskId) {
  return `polchain_block_v2_${ADDRESSES.TaskManager}_${taskId}`;
}

async function fetchBlockData(manager, task, bypassCache = false) {
  const taskId = Number(task.id);

  // Return cached finalized blocks immediately (unless caller wants a fresh fetch)
  if (!bypassCache) {
    try {
      const hit = localStorage.getItem(blockCacheKey(taskId));
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

  try { localStorage.setItem(blockCacheKey(taskId), JSON.stringify(block)); } catch { /* ignore */ }
  return block;
}

function clearBlockCache() {
  const prefix = `polchain_block_v2_${ADDRESSES.TaskManager}_`;
  Object.keys(localStorage)
    .filter((k) => k.startsWith(prefix))
    .forEach((k) => localStorage.removeItem(k));
}

async function loadChain(manager, bypassCache = false) {
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
      clearBlockCache();
      const freshTotal = Number(await manager.totalTasks());
      if (freshTotal === 0) return { blocks: [], pending: null };
      // Re-enter with bypassCache so we don't hit the now-cleared stale entries
      return loadChain(manager, true);
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
  const blockData = await Promise.all(finalized.map((t) => fetchBlockData(manager, t, bypassCache)));

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

  // Mode-aware contract address — stable for the lifetime of this page (reload on switch)
  const [activeMode, setActiveMode] = useState("advanced");
  useEffect(() => {
    fetch(`${ADMIN_API}/api/mode`)
      .then((r) => r.json())
      .then((d) => { if (d.mode) setActiveMode(d.mode); })
      .catch(() => {});
  }, []);
  const taskManagerAddr = getActiveTaskManager(activeMode);

  const doLoad = useCallback(async (bypassCache = false, silent = false) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const { blocks: b, pending: p } = await loadChain(managerRef.current, bypassCache);
      setBlocks(b);
      setPending(p);
      if (!silent) setError("");
    } catch (e) {
      const isStale =
        e.code === "CALL_EXCEPTION" ||
        e.message?.includes("CALL_EXCEPTION") ||
        e.message?.includes("could not decode result data");
      if (isStale) {
        // Stale cache from a previous deployment — clear it and retry fresh.
        clearBlockCache();
        try {
          const { blocks: b, pending: p } = await loadChain(managerRef.current, true);
          setBlocks(b);
          setPending(p);
          if (!silent) setError("");
        } catch (e2) {
          if (!silent) setError(e2.message);
        }
      } else {
        if (!silent) setError(e.message);
      }
    } finally {
      loadingRef.current = false;
    }
  }, []);

  const doRefresh = useCallback(async () => {
    setRefreshing(true);
    clearBlockCache();
    await doLoad(true);
    setRefreshing(false);
  }, [doLoad]);

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
      } catch { /* non-fatal */ }
    }

    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, [doLoad, taskManagerAddr]);

  // Scroll to end when chain changes
  useEffect(() => {
    if (blocks !== null && scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, [blocks, pending]);

  if (!taskManagerAddr) {
    return <p style={S.notice}>Contract not deployed. Update ADDRESSES in contracts.js.</p>;
  }
  if (error)          return <p style={{ ...S.notice, color: "#ff6b6b" }}>{error}</p>;
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

      {/* Header */}
      <div style={S.topRow}>
        <div>
          <h2 style={S.heading}>PoLChain</h2>
          <p style={S.subheading}>Each block is mined by submitting a verifiable AI gradient proof</p>
        </div>
        <div style={S.stats}>
          <div style={S.statItem}>
            <div style={S.statVal}>{minedCount}</div>
            <div style={S.statLabel}>BLOCKS MINED</div>
          </div>
          {pending && (
            <div style={S.statItem}>
              <div style={{ ...S.statVal, color: "#b07fff" }}>1</div>
              <div style={S.statLabel}>PENDING</div>
            </div>
          )}
          <button
            style={{
              ...S.attackBtn,
              opacity: attackBusy ? 0.45 : 1,
              cursor:  attackBusy ? "not-allowed" : "pointer",
            }}
            onClick={handleAttack}
            disabled={attackBusy}
          >
            {attackBusy ? "⚡ Attacking…" : "⚡ Simulate Attack"}
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
            {refreshing ? "Refreshing…" : "⟳ Refresh"}
          </button>
        </div>
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

      {/* Why this secures the blockchain */}
      <div style={S.secSection}>
        <div style={S.secTitle}>Why this secures the blockchain</div>
        <div style={S.secGrid}>
          {[
            {
              icon: "⬡",
              head: "ZK proof required to mine",
              body: "Every block requires a valid zero-knowledge proof that the miner actually trained the model and achieved the claimed score — fake submissions are rejected on-chain.",
            },
            {
              icon: "⬡",
              head: "Proof ties gradient to model state",
              body: "The gradient hash commits to the exact weight updates applied during training. Any tampering changes the hash and invalidates the cryptographic proof.",
            },
            {
              icon: "⬡",
              head: "Chain is tamper-proof",
              body: "Each block's prev hash is the winning gradient hash of the round before. Altering any block invalidates every subsequent proof, making history immutable.",
            },
          ].map(({ icon, head, body }) => (
            <div key={head} style={S.secItem}>
              <div style={S.secIcon}>{icon}</div>
              <div style={S.secText}>
                <strong style={{ color: "#d0d0e0" }}>{head}</strong>
                <br />{body}
              </div>
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
const S = {
  notice:     { color: "#666", padding: "40px 0", textAlign: "center" },
  heading:    { color: "#a0b0ff", marginBottom: 4, fontSize: 16, letterSpacing: 1 },
  subheading: { color: "#555", fontSize: 11, margin: 0 },

  topRow:    { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 },
  stats:     { display: "flex", gap: 20, alignItems: "flex-start" },
  statItem:  { textAlign: "right" },
  statVal:    { fontSize: 22, fontWeight: "bold", color: "#3ddc84", fontFamily: "monospace" },
  statLabel:  { fontSize: 9, color: "#444", letterSpacing: 1.2, textTransform: "uppercase" },
  refreshBtn: {
    background: "#0e0e1a", border: "1px solid #2e3666", color: "#a0b0ff",
    padding: "5px 12px", borderRadius: 4, fontSize: 11, fontFamily: "monospace",
    alignSelf: "center", transition: "opacity 0.2s",
  },
  attackBtn: {
    background: "#1a0808", border: "1px solid #4a1a1a", color: "#ff8c42",
    padding: "5px 12px", borderRadius: 4, fontSize: 11, fontFamily: "monospace",
    alignSelf: "center", cursor: "pointer", letterSpacing: 0.3,
  },

  scrollOuter: { overflowX: "auto", paddingBottom: 12, marginBottom: 8, scrollbarWidth: "thin", scrollbarColor: "#1e1e30 transparent" },
  chainRow:    { display: "flex", alignItems: "center", minWidth: "max-content", padding: "12px 4px 4px" },

  block: {
    width: 186, minHeight: 188, borderRadius: 6, padding: "12px 14px", flexShrink: 0,
    fontFamily: "'Courier New', Courier, monospace", background: "#08080e",
    border: "1px solid #1e1e30", boxSizing: "border-box",
  },
  blockHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 },
  blockNum:    { fontSize: 10, fontWeight: "bold", letterSpacing: 1 },
  winnerLine:  { display: "flex", alignItems: "center", gap: 4, marginTop: 3 },
  winnerLabel: { fontSize: 7, color: "#2a4a2a", letterSpacing: 0.8, textTransform: "uppercase" },
  winnerAddr:  { fontSize: 9, color: "#4a7a4a", fontFamily: "monospace", letterSpacing: 0.2 },
  zkBadge:    { fontSize: 8, color: "#3ddc84", border: "1px solid #1a4a2a", borderRadius: 3, padding: "1px 5px", letterSpacing: 0.5, fontFamily: "monospace", cursor: "default" },
  basicBadge: { fontSize: 8, color: "#555",    border: "1px solid #1e1e30", borderRadius: 3, padding: "1px 5px", letterSpacing: 0.5, fontFamily: "monospace" },
  pendingBadge:{ fontSize: 8, color: "#b07fff", border: "1px solid #3a1a6a", borderRadius: 3, padding: "1px 5px", letterSpacing: 0.5, fontFamily: "monospace" },

  fieldGroup: { marginBottom: 7 },
  label:  { display: "block", fontSize: 8, color: "#444", letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 1 },
  mono:   { fontSize: 10, color: "#808098", letterSpacing: 0.2 },
  txLink: { display: "block", marginTop: 10, fontSize: 9, color: "#4a6aaa", textDecoration: "none", letterSpacing: 0.3 },

  pendingBlock: {
    width: 186, minHeight: 188, borderRadius: 6, padding: "12px 14px", flexShrink: 0,
    fontFamily: "'Courier New', Courier, monospace", background: "#0c080f",
    border: "1px solid #3a1a6a", boxSizing: "border-box",
  },
  arrow:     { display: "flex", alignItems: "center", flexShrink: 0, padding: "0 2px" },
  arrowLine: { width: 24, height: 1, background: "#252530" },
  arrowHead: { width: 0, height: 0, borderTop: "4px solid transparent", borderBottom: "4px solid transparent", borderLeft: "6px solid #252530" },

  secSection: { borderTop: "1px solid #1a1a28", paddingTop: 28, marginTop: 32 },
  secTitle:   { color: "#a0b0ff", fontSize: 13, fontWeight: "bold", letterSpacing: 0.5, marginBottom: 18 },
  secGrid:    { display: "flex", gap: 24, flexWrap: "wrap" },
  secItem:    { flex: "1 1 220px", display: "flex", gap: 12, alignItems: "flex-start" },
  secIcon:    { fontSize: 18, color: "#3ddc84", flexShrink: 0, lineHeight: 1.4 },
  secText:    { fontSize: 12, color: "#666", lineHeight: 1.65 },
};

// ---------------------------------------------------------------------------
// Live mining styles
// ---------------------------------------------------------------------------
const SL = {
  section: { borderTop: "1px solid #1a1a28", paddingTop: 24, marginTop: 24, marginBottom: 8 },
  header:  { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18 },
  title:   { color: "#a0b0ff", fontSize: 14, fontWeight: "bold", letterSpacing: 0.5, marginBottom: 4 },
  subtitle:{ color: "#555", fontSize: 11 },

  timerBox:   { textAlign: "right" },
  timerVal:   { fontSize: 26, fontWeight: "bold", fontFamily: "'Courier New', Courier, monospace", lineHeight: 1 },
  timerLabel: { fontSize: 9, color: "#444", letterSpacing: 1.2, textTransform: "uppercase", marginTop: 3 },

  grid: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 4 },

  card: {
    borderRadius: 6, padding: "14px 14px 12px",
    fontFamily: "'Courier New', Courier, monospace",
    border: "1px solid transparent", boxSizing: "border-box",
  },
  cardTop:    { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  minerName:  { fontSize: 10, fontWeight: "bold", letterSpacing: 0.5 },

  winnerBadge: {
    fontSize: 8, color: "#3ddc84", background: "#0a2a18",
    border: "1px solid #1a5a2a", borderRadius: 3, padding: "1px 5px", letterSpacing: 0.5,
  },
  leadingBadge: {
    fontSize: 8, color: "#f0c040", background: "#1a1400",
    border: "1px solid #3a3000", borderRadius: 3, padding: "1px 5px", letterSpacing: 0.5,
  },

  scoreRow:   { display: "flex", alignItems: "baseline", gap: 1, marginBottom: 4 },
  scoreVal:   { fontSize: 28, fontWeight: "bold", lineHeight: 1 },
  scoreDenom: { fontSize: 11, color: "#444" },
  reward:     { fontSize: 11, color: "#3ddc84", marginBottom: 4 },
  subTime:    { fontSize: 9, color: "#444", marginTop: 2 },
  waiting:    { fontSize: 10, color: "#333", marginTop: 6, fontStyle: "italic" },

  proofStatus: {
    display: "flex", alignItems: "center", gap: 5,
    marginTop: 8, fontSize: 9, color: "#666",
    fontFamily: "'Courier New', Courier, monospace", letterSpacing: 0.2,
  },
  proofDot: {
    display: "inline-block", width: 5, height: 5, borderRadius: "50%",
    background: "#555", flexShrink: 0,
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

