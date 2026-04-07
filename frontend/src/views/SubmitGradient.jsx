import { useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { ADDRESSES, TASK_MANAGER_ABI } from "../contracts";
import { getReadProvider, formatPOL, timeLeft } from "../wallet";
import { PROVE_SERVER } from "../config";

function getManager(signerOrProvider) {
  return new ethers.Contract(ADDRESSES.TaskManager, TASK_MANAGER_ABI, signerOrProvider);
}

// ---------------------------------------------------------------------------
// Proof parsing
// proof.json instances are little-endian 32-byte field elements (hex strings).
// The Solidity verifier expects them as big-endian uint256[].
// ---------------------------------------------------------------------------
function parseProofJson(proofJson) {
  if (!proofJson.hex_proof || !Array.isArray(proofJson.instances?.[0])) {
    throw new Error("Unrecognised proof.json format — expected hex_proof and instances fields.");
  }
  const proofBytes = proofJson.hex_proof;
  const instances  = proofJson.instances[0].map((hexLE) => {
    const bigEndian = hexLE.match(/.{2}/g).reverse().join("");
    return BigInt("0x" + bigEndian);
  });
  return { proofBytes, instances };
}

function resolveHashBytes(gradientHash) {
  const h = gradientHash.startsWith("0x")
    ? gradientHash
    : ethers.keccak256(ethers.toUtf8Bytes(gradientHash));
  if (!/^0x[0-9a-fA-F]{64}$/.test(h)) throw new Error("invalid");
  return h;
}

// ---------------------------------------------------------------------------
// Auto-Prove progress stages
// ---------------------------------------------------------------------------
const PROOF_STAGES = [
  { key: "loading",   label: "Load Data" },
  { key: "training",  label: "Training"  },
  { key: "computing", label: "Quality"   },
  { key: "proving",   label: "Prove"     },
  { key: "verifying", label: "Verify"    },
];

// ---------------------------------------------------------------------------
// Mode toggle — Basic / ZK Verified / Auto-Prove
// ---------------------------------------------------------------------------
function ModeToggle({ mode, onChange }) {
  return (
    <div style={S.toggleRow}>
      <button type="button" onClick={() => onChange("basic")}
        style={mode === "basic" ? S.toggleActive : S.toggleInactive}>
        Basic
      </button>
      <button type="button" onClick={() => onChange("zk")}
        style={mode === "zk" ? S.toggleActiveZK : S.toggleInactiveZK}>
        ZK Verified
      </button>
      <button type="button" onClick={() => onChange("auto")}
        style={mode === "auto" ? S.toggleActiveAuto : S.toggleInactiveAuto}>
        Auto-Prove
      </button>
      <span style={S.toggleHint}>
        {mode === "basic"  && "Score is self-reported — no cryptographic guarantee"}
        {mode === "zk"     && "Upload a proof.json — weights stay private"}
        {mode === "auto"   && "Type a sentence — proof generated and submitted automatically"}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stage progress bar (Auto-Prove mode)
// ---------------------------------------------------------------------------
function StageBar({ activeStage, doneStages, errorStage, stageLog }) {
  return (
    <div style={S.stageWrap}>
      <div style={S.stageRow}>
        {PROOF_STAGES.map((s, i) => {
          const done   = doneStages.has(s.key);
          const active = activeStage === s.key;
          const err    = errorStage && active;
          const color  = err ? "#ff6b6b" : done ? "#3ddc84" : active ? "#b07fff" : "#333";
          return (
            <div key={s.key} style={{ display: "flex", alignItems: "center" }}>
              <div style={{ ...S.stageDot, background: color, boxShadow: active ? `0 0 8px ${color}` : "none" }}>
                {done ? "✓" : active ? (err ? "✕" : "…") : String(i + 1)}
              </div>
              <span style={{ ...S.stageLabel, color }}>{s.label}</span>
              {i < PROOF_STAGES.length - 1 && (
                <div style={{ ...S.stageLine, background: done ? "#3ddc84" : "#222" }} />
              )}
            </div>
          );
        })}
      </div>
      {stageLog && <p style={S.stageLog}>{stageLog}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function SubmitGradient({ wallet }) {
  const [tasks, setTasks]               = useState([]);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [selectedTask, setSelectedTask] = useState("");

  // mode: "basic" | "zk" | "auto"
  const [mode, setMode] = useState("basic");

  // Basic + ZK fields
  const [gradientHash, setGradientHash] = useState("");
  const [score, setScore]               = useState("");
  const [proofData, setProofData]       = useState(null);
  const [proofFileName, setProofFileName] = useState("");
  const [proofError, setProofError]     = useState("");

  // Auto-Prove fields
  const [proving, setProving]           = useState(false);
  const [doneStages, setDoneStages]     = useState(new Set());
  const [activeStage, setActiveStage]   = useState("");
  const [errorStage, setErrorStage]     = useState(false);
  const [stageLog, setStageLog]         = useState("");
  const [autoScore, setAutoScore]       = useState(null);

  // Shared
  const [status, setStatus]             = useState("");
  const [submitting, setSubmitting]     = useState(false);
  const [txHash, setTxHash]             = useState("");
  const fileRef = useRef(null);

  useEffect(() => {
    if (!ADDRESSES.TaskManager) { setLoadingTasks(false); return; }
    const manager = getManager(getReadProvider());
    (async () => {
      try {
        const total = await manager.totalTasks();
        const all = [];
        for (let i = 1n; i <= total; i++) {
          const t = await manager.getTask(i);
          if (!t.finalized && Date.now() < Number(t.deadline) * 1000) all.push(t);
        }
        setTasks(all);
        if (all.length > 0) setSelectedTask(all[0].id.toString());
      } catch (e) {
        setStatus("Failed to load tasks: " + e.message);
      } finally {
        setLoadingTasks(false);
      }
    })();
  }, []);

  const activeTask = tasks.find((t) => t.id.toString() === selectedTask);

  function resetShared() {
    setStatus("");
    setTxHash("");
  }

  function handleModeChange(val) {
    setMode(val);
    resetShared();
    setDoneStages(new Set());
    setActiveStage("");
    setErrorStage(false);
    setStageLog("");
    setAutoScore(null);
    setProving(false);
  }

  // -------------------------------------------------------------------------
  // Proof file upload (ZK mode)
  // -------------------------------------------------------------------------
  function handleProofFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    setProofError("");
    setProofData(null);
    setProofFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const json   = JSON.parse(ev.target.result);
        const parsed = parseProofJson(json);
        setProofData(parsed);
        if (!score) {
          const logitRaw    = Number(parsed.instances[parsed.instances.length - 1]);
          const approxScore = Math.min(100, Math.max(0, Math.round(50 + logitRaw * 5)));
          setScore(String(approxScore));
        }
      } catch (err) {
        setProofError("Failed to parse proof.json: " + err.message);
      }
    };
    reader.readAsText(file);
  }

  // -------------------------------------------------------------------------
  // Basic / ZK submit
  // -------------------------------------------------------------------------
  async function handleSubmit(e) {
    e.preventDefault();
    if (!wallet) { setStatus("Connect your wallet first."); return; }

    let hashBytes;
    try {
      hashBytes = resolveHashBytes(gradientHash);
    } catch {
      setStatus("Gradient hash must be a 32-byte hex string (0x…) or plain text.");
      return;
    }

    const scoreNum = parseInt(score, 10);
    if (isNaN(scoreNum) || scoreNum < 0 || scoreNum > 100) {
      setStatus("Score must be 0–100.");
      return;
    }

    if (mode === "zk" && !proofData) {
      setStatus("Upload a proof.json file to use ZK mode.");
      return;
    }

    setSubmitting(true);
    setStatus("Sending transaction…");
    setTxHash("");
    try {
      const manager = getManager(wallet.signer);
      let tx;
      if (mode === "zk") {
        tx = await manager.submitWithProof(
          BigInt(selectedTask), hashBytes, scoreNum,
          proofData.proofBytes, proofData.instances,
        );
      } else {
        tx = await manager.submitWork(BigInt(selectedTask), hashBytes, scoreNum);
      }
      setStatus("Waiting for confirmation…");
      await tx.wait();
      setTxHash(tx.hash);
      setStatus(mode === "zk" ? "ZK-verified submission confirmed." : "Basic submission confirmed.");
      setGradientHash("");
      setScore("");
      setProofData(null);
      setProofFileName("");
      if (fileRef.current) fileRef.current.value = "";
    } catch (e) {
      setStatus("Error: " + (e.reason || e.message));
    } finally {
      setSubmitting(false);
    }
  }

  // -------------------------------------------------------------------------
  // Auto-Prove: POST task_id to local server, stream SSE, then submit tx
  // -------------------------------------------------------------------------
  async function handleAutoProve(e) {
    e.preventDefault();
    if (!wallet) { setStatus("Connect your wallet first."); return; }

    setProving(true);
    setDoneStages(new Set());
    setActiveStage("");
    setErrorStage(false);
    setStageLog("");
    setAutoScore(null);
    setStatus("");
    setTxHash("");

    let finalProof        = null;
    let finalScore        = null;
    let finalGradientHash = null;

    try {
      let res;
      try {
        res = await fetch(`${PROVE_SERVER}/prove`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ task_id: parseInt(selectedTask, 10) }),
        });
      } catch {
        throw new Error(`Cannot reach prove-server at ${PROVE_SERVER} — run: npm run prove-server`);
      }

      if (!res.ok) throw new Error(`Server returned ${res.status}`);

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer    = "";

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

          if (ev.stage === "error") {
            setErrorStage(true);
            setStageLog(ev.message);
            setStatus("Error: " + ev.message);
            break outer;
          }

          if (ev.stage === "done") {
            setDoneStages(new Set(PROOF_STAGES.map((s) => s.key)));
            setActiveStage("done");
            setStageLog(ev.message);
            finalScore        = ev.score;
            finalGradientHash = ev.gradient_hash;
            finalProof        = parseProofJson(ev.proof);
            setAutoScore(ev.score);
            break outer;
          }

          // Mark all preceding stages done, activate current
          const idx = PROOF_STAGES.findIndex((s) => s.key === ev.stage);
          setDoneStages(() => {
            const next = new Set();
            for (let i = 0; i < idx; i++) next.add(PROOF_STAGES[i].key);
            return next;
          });
          setActiveStage(ev.stage);
          setStageLog(ev.message);
          if (ev.score !== undefined) setAutoScore(ev.score);
        }
      }

      // Submit tx using the server-provided gradient_hash and ZK proof
      if (finalProof && finalScore !== null && finalGradientHash) {
        setStatus("Submitting ZK-verified transaction…");
        const manager = getManager(wallet.signer);
        const tx = await manager.submitWithProof(
          BigInt(selectedTask),
          finalGradientHash,
          finalScore,
          finalProof.proofBytes,
          finalProof.instances,
        );
        setStatus("Waiting for confirmation…");
        await tx.wait();
        setTxHash(tx.hash);
        const threshold = Number(activeTask?.threshold ?? 0);
        const beat      = finalScore >= threshold;
        setStatus(
          `ZK-verified submission confirmed — gradient quality ${finalScore}/100` +
          (beat ? ` ✓ beats threshold (${threshold})` : ` ✗ below threshold (${threshold})`),
        );
      }
    } catch (err) {
      setStatus("Error: " + (err.reason || err.message));
    } finally {
      setProving(false);
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  if (!ADDRESSES.TaskManager) {
    return <p style={S.notice}>Contract not deployed. Update ADDRESSES in contracts.js.</p>;
  }

  return (
    <div>
      <h2 style={S.heading}>Mine Block</h2>

      {loadingTasks ? (
        <p style={S.notice}>Loading tasks…</p>
      ) : tasks.length === 0 ? (
        <p style={S.notice}>No active tasks available.</p>
      ) : (
        <div style={S.form}>
          <ModeToggle mode={mode} onChange={handleModeChange} />

          {/* Task selector */}
          <label style={S.label}>Select Task</label>
          <select value={selectedTask} onChange={(e) => setSelectedTask(e.target.value)} style={S.input}>
            {tasks.map((t) => (
              <option key={t.id.toString()} value={t.id.toString()}>
                #{t.id.toString()} — {t.description.slice(0, 60)}{t.description.length > 60 ? "…" : ""}
              </option>
            ))}
          </select>

          {activeTask && (
            <div style={S.taskInfo}>
              <span>Threshold: <strong>{activeTask.threshold.toString()}/100</strong></span>
              <span>Reward: <strong style={{ color: "#3ddc84" }}>{formatPOL(activeTask.reward)} POL</strong></span>
              <span>Deadline: <strong>{timeLeft(activeTask.deadline)}</strong></span>
            </div>
          )}

          {/* ---------------------------------------------------------------- */}
          {/* AUTO-PROVE MODE                                                   */}
          {/* ---------------------------------------------------------------- */}
          {mode === "auto" && (
            <form onSubmit={handleAutoProve}>
              <div style={S.autoBox}>
                <p style={S.autoDesc}>
                  Runs a local training loop on synthetic task data, measures gradient quality,
                  and generates a ZK proof that a real training step occurred —
                  without revealing your model weights.
                </p>
                <div style={S.autoMeta}>
                  <span>8 epochs · 400 samples · SentimentNet (16→8→1)</span>
                  <span style={{ color: "#555" }}>seed = task_id</span>
                </div>
              </div>

              {/* Stage progress bar */}
              {(proving || activeStage) && (
                <StageBar
                  activeStage={activeStage}
                  doneStages={doneStages}
                  errorStage={errorStage}
                  stageLog={stageLog}
                />
              )}

              {/* Score result */}
              {autoScore !== null && (
                <div style={S.scoreResult}>
                  <div>
                    <div style={S.scoreNumRow}>
                      <span style={S.scoreNum}>{autoScore}</span>
                      <span style={S.scoreLabel}>/100</span>
                    </div>
                    <div style={S.scoreName}>Gradient Quality Score</div>
                  </div>
                  {activeTask && (
                    <span style={{
                      ...S.scoreBadge,
                      background: autoScore >= Number(activeTask.threshold) ? "#0e2a1a" : "#1a0a0a",
                      color:      autoScore >= Number(activeTask.threshold) ? "#3ddc84" : "#ff6b6b",
                      border:     `1px solid ${autoScore >= Number(activeTask.threshold) ? "#1a4a2a" : "#3a1a1a"}`,
                    }}>
                      {autoScore >= Number(activeTask.threshold)
                        ? `✓ beats threshold (${activeTask.threshold.toString()})`
                        : `✗ below threshold (${activeTask.threshold.toString()})`}
                    </span>
                  )}
                </div>
              )}

              <button
                type="submit"
                disabled={proving || submitting || !wallet}
                style={S.btnAuto}
              >
                {proving ? "Proving…" : submitting ? "Submitting…" : "Mine Task"}
              </button>

              {!wallet && <p style={S.warn}>Connect your wallet to submit.</p>}
              {status && (
                <p style={{ ...S.status, color: txHash ? "#3ddc84" : status.startsWith("Error") ? "#ff6b6b" : "#aaa" }}>
                  {status}
                </p>
              )}
              {txHash && (
                <p style={S.txLink}>
                  Tx:{" "}
                  <a href={`https://sepolia.basescan.org/tx/${txHash}`} target="_blank" rel="noreferrer">
                    {txHash.slice(0, 20)}…
                  </a>
                </p>
              )}
            </form>
          )}

          {/* ---------------------------------------------------------------- */}
          {/* BASIC + ZK MODES                                                  */}
          {/* ---------------------------------------------------------------- */}
          {(mode === "basic" || mode === "zk") && (
            <form onSubmit={handleSubmit}>
              {/* ZK — proof.json upload */}
              {mode === "zk" && (
                <div style={S.proofBox}>
                  <label style={{ ...S.label, marginTop: 0, color: "#7a9fff" }}>
                    proof.json
                    <span style={S.hint}> — generated by <code style={S.code}>python3 zk/prove.py</code></span>
                  </label>
                  <div style={S.fileRow}>
                    <input
                      ref={fileRef}
                      type="file"
                      accept=".json,application/json"
                      onChange={handleProofFile}
                      style={{ display: "none" }}
                      id="proof-file-input"
                    />
                    <label htmlFor="proof-file-input" style={S.fileBtn}>
                      Choose File
                    </label>
                    <span style={{ color: proofData ? "#3ddc84" : "#555", fontSize: 12 }}>
                      {proofData
                        ? `✓ ${proofFileName} — ${proofData.instances.length} instances`
                        : proofFileName || "No file chosen"}
                    </span>
                  </div>
                  {proofError && <p style={{ color: "#ff6b6b", fontSize: 12, marginTop: 6 }}>{proofError}</p>}
                  {proofData && (
                    <div style={S.proofMeta}>
                      <span>Proof bytes: {(proofData.proofBytes.length / 2 - 1).toLocaleString()} bytes</span>
                      <span>Public instances: {proofData.instances.length} field elements</span>
                    </div>
                  )}
                </div>
              )}

              {/* Gradient hash */}
              <label style={S.label}>
                Gradient Hash
                <span style={S.hint}> — bytes32 hex (0x…) or plain text (keccak256 hashed)</span>
              </label>
              <input
                style={S.input}
                placeholder="0xabc123… or 'my-gradient-v1'"
                value={gradientHash}
                onChange={(e) => setGradientHash(e.target.value)}
                required
              />

              {/* Score */}
              <label style={S.label}>
                Performance Score
                <span style={S.hint}> — must be ≥ {activeTask?.threshold.toString() ?? "threshold"}{mode === "zk" ? " (from proof)" : ""}</span>
              </label>
              <input
                style={{ ...S.input, width: 120 }}
                type="number" min="0" max="100" placeholder="0–100"
                value={score}
                onChange={(e) => setScore(e.target.value)}
                required
              />

              <button type="submit" disabled={submitting || !wallet}
                style={mode === "zk" ? S.btnZK : S.btn}>
                {submitting ? "Mining…" : mode === "zk" ? "Mine with ZK Proof" : "Mine"}
              </button>

              {!wallet && <p style={S.warn}>Connect your wallet to submit.</p>}
              {status && (
                <p style={{ ...S.status, color: txHash ? "#3ddc84" : status.startsWith("Error") ? "#ff6b6b" : "#aaa" }}>
                  {status}
                </p>
              )}
              {txHash && (
                <p style={S.txLink}>
                  Tx:{" "}
                  <a href={`https://sepolia.basescan.org/tx/${txHash}`} target="_blank" rel="noreferrer">
                    {txHash.slice(0, 20)}…
                  </a>
                </p>
              )}
            </form>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const S = {
  heading:      { color: "#a0b0ff", marginBottom: 20, fontSize: 16, letterSpacing: 1 },
  notice:       { color: "#666", padding: "40px 0", textAlign: "center" },
  form:         { maxWidth: 560 },
  label:        { display: "block", color: "#888", fontSize: 11, letterSpacing: 1, textTransform: "uppercase", marginTop: 20, marginBottom: 6 },
  hint:         { color: "#555", textTransform: "none", letterSpacing: 0, fontSize: 11 },
  code:         { background: "#1a1a28", padding: "1px 5px", borderRadius: 3, fontSize: 11 },
  input:        { display: "block", width: "100%", background: "#0e0e1a", color: "#d0d0e0", border: "1px solid #1e1e30", borderRadius: 4, padding: "8px 10px", outline: "none" },
  taskInfo:     { display: "flex", gap: 24, background: "#0a0a14", border: "1px solid #1a1a28", borderRadius: 4, padding: "10px 14px", marginTop: 10, color: "#888", fontSize: 12 },
  btn:          { marginTop: 24, background: "#1a2a4a", color: "#6b8fff", border: "1px solid #2a3a6a", padding: "10px 24px", borderRadius: 4, fontSize: 13, cursor: "pointer" },
  btnZK:        { marginTop: 24, background: "#0e2a1a", color: "#3ddc84", border: "1px solid #1a4a2a", padding: "10px 24px", borderRadius: 4, fontSize: 13, cursor: "pointer" },
  btnAuto:      { marginTop: 24, background: "#1a0e2a", color: "#b07fff", border: "1px solid #3a1a6a", padding: "10px 24px", borderRadius: 4, fontSize: 13, cursor: "pointer" },
  warn:         { color: "#886600", fontSize: 12, marginTop: 8 },
  status:       { fontSize: 12, marginTop: 10 },
  txLink:       { fontSize: 11, color: "#555", marginTop: 6 },

  // Mode toggle
  toggleRow:        { display: "flex", alignItems: "center", gap: 8, marginBottom: 24, flexWrap: "wrap" },
  toggleActive:     { background: "#1a2a4a", color: "#6b8fff", border: "1px solid #2a3a6a", padding: "6px 16px", borderRadius: 4, cursor: "pointer" },
  toggleInactive:   { background: "transparent", color: "#444", border: "1px solid #222", padding: "6px 16px", borderRadius: 4, cursor: "pointer" },
  toggleActiveZK:   { background: "#0e2a1a", color: "#3ddc84", border: "1px solid #1a4a2a", padding: "6px 16px", borderRadius: 4, cursor: "pointer" },
  toggleInactiveZK: { background: "transparent", color: "#444", border: "1px solid #222", padding: "6px 16px", borderRadius: 4, cursor: "pointer" },
  toggleActiveAuto:   { background: "#1a0e2a", color: "#b07fff", border: "1px solid #3a1a6a", padding: "6px 16px", borderRadius: 4, cursor: "pointer" },
  toggleInactiveAuto: { background: "transparent", color: "#444", border: "1px solid #222", padding: "6px 16px", borderRadius: 4, cursor: "pointer" },
  toggleHint:       { fontSize: 11, color: "#555", marginLeft: 4 },

  // ZK proof upload
  proofBox:   { background: "#0a0f0a", border: "1px solid #1a2a1a", borderRadius: 6, padding: "14px 16px", marginTop: 16 },
  fileRow:    { display: "flex", alignItems: "center", gap: 12, marginTop: 6 },
  fileBtn:    { background: "#0e2a1a", color: "#3ddc84", border: "1px solid #1a4a2a", padding: "6px 14px", borderRadius: 4, cursor: "pointer", fontSize: 12 },
  proofMeta:  { display: "flex", gap: 20, marginTop: 10, fontSize: 11, color: "#4a8a6a" },

  // Auto-Prove
  autoBox:     { background: "#0d0a14", border: "1px solid #2a1a4a", borderRadius: 6, padding: "14px 16px", marginTop: 16 },
  autoDesc:    { color: "#888", fontSize: 12, lineHeight: 1.6, margin: "0 0 10px" },
  autoMeta:    { display: "flex", gap: 16, fontSize: 11, color: "#4a3a6a" },

  // Stage bar
  stageWrap:  { marginTop: 20, background: "#0a0a14", border: "1px solid #1a1a2a", borderRadius: 6, padding: "14px 16px" },
  stageRow:   { display: "flex", alignItems: "center" },
  stageDot:   { width: 24, height: 24, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#fff", fontWeight: "bold", flexShrink: 0, transition: "background 0.3s" },
  stageLabel: { fontSize: 10, letterSpacing: 0.5, marginLeft: 5, marginRight: 4, whiteSpace: "nowrap" },
  stageLine:  { height: 2, width: 20, flexShrink: 0, transition: "background 0.3s" },
  stageLog:   { fontSize: 11, color: "#666", marginTop: 10, marginBottom: 0 },

  // Score result
  scoreResult:  { display: "flex", alignItems: "center", gap: 16, marginTop: 16 },
  scoreNumRow:  { display: "flex", alignItems: "baseline", gap: 4 },
  scoreNum:     { fontSize: 36, fontWeight: "bold", color: "#b07fff" },
  scoreLabel:   { fontSize: 14, color: "#555" },
  scoreName:    { fontSize: 10, color: "#664a99", letterSpacing: 1, textTransform: "uppercase", marginTop: 2 },
  scoreBadge:   { fontSize: 11, padding: "3px 10px", borderRadius: 4 },
};
