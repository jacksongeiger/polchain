import { useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { ADDRESSES, TASK_MANAGER_ABI } from "../contracts";
import { getReadProvider, formatPOL, timeLeft } from "../wallet";

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
  const proofBytes = proofJson.hex_proof; // already 0x-prefixed hex
  const instances = proofJson.instances[0].map((hexLE) => {
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
// Mode toggle
// ---------------------------------------------------------------------------
function ModeToggle({ zkMode, onChange }) {
  return (
    <div style={S.toggleRow}>
      <button
        type="button"
        onClick={() => onChange(false)}
        style={zkMode ? S.toggleInactive : S.toggleActive}
      >
        Basic
      </button>
      <button
        type="button"
        onClick={() => onChange(true)}
        style={zkMode ? S.toggleActiveZK : S.toggleInactiveZK}
      >
        ZK Verified
      </button>
      <span style={S.toggleHint}>
        {zkMode
          ? "Proof cryptographically verified on-chain — weights stay private"
          : "Score is self-reported — no cryptographic guarantee"}
      </span>
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
  const [zkMode, setZkMode]             = useState(false);
  const [gradientHash, setGradientHash] = useState("");
  const [score, setScore]               = useState("");
  const [proofData, setProofData]       = useState(null);   // { proofBytes, instances }
  const [proofFileName, setProofFileName] = useState("");
  const [proofError, setProofError]     = useState("");
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

  function handleProofFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    setProofError("");
    setProofData(null);
    setProofFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const json = JSON.parse(ev.target.result);
        const parsed = parseProofJson(json);
        setProofData(parsed);
        // Auto-fill score from the last instance (the model output logit → sigmoid → 0-100)
        if (!score) {
          const logitRaw = Number(parsed.instances[parsed.instances.length - 1]);
          // The logit is stored in the ZK field — small positive values mean positive sentiment
          // Clamp to a sensible display range; actual verification happens on-chain
          const approxScore = Math.min(100, Math.max(0, Math.round(50 + logitRaw * 5)));
          setScore(String(approxScore));
        }
      } catch (err) {
        setProofError("Failed to parse proof.json: " + err.message);
      }
    };
    reader.readAsText(file);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!wallet) { setStatus("Connect your wallet first."); return; }

    let hashBytes;
    try {
      hashBytes = resolveHashBytes(gradientHash);
    } catch {
      setStatus("Gradient hash must be a 32-byte hex string (0x…) or plain text to hash.");
      return;
    }

    const scoreNum = parseInt(score, 10);
    if (isNaN(scoreNum) || scoreNum < 0 || scoreNum > 100) {
      setStatus("Score must be 0–100.");
      return;
    }

    if (zkMode && !proofData) {
      setStatus("Upload a proof.json file to use ZK mode.");
      return;
    }

    setSubmitting(true);
    setStatus("Sending transaction…");
    setTxHash("");
    try {
      const manager = getManager(wallet.signer);
      let tx;

      if (zkMode) {
        tx = await manager.submitWithProof(
          BigInt(selectedTask),
          hashBytes,
          scoreNum,
          proofData.proofBytes,
          proofData.instances,
        );
      } else {
        tx = await manager.submitWork(BigInt(selectedTask), hashBytes, scoreNum);
      }

      setStatus("Waiting for confirmation…");
      await tx.wait();
      setTxHash(tx.hash);
      setStatus(zkMode ? "ZK-verified submission confirmed." : "Basic submission confirmed.");
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

  if (!ADDRESSES.TaskManager) {
    return <p style={S.notice}>Contract not deployed. Update ADDRESSES in contracts.js.</p>;
  }

  return (
    <div>
      <h2 style={S.heading}>Submit Gradient</h2>

      {loadingTasks ? (
        <p style={S.notice}>Loading tasks…</p>
      ) : tasks.length === 0 ? (
        <p style={S.notice}>No active tasks available.</p>
      ) : (
        <form onSubmit={handleSubmit} style={S.form}>

          {/* Mode toggle */}
          <ModeToggle zkMode={zkMode} onChange={(val) => { setZkMode(val); setStatus(""); setTxHash(""); }} />

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

          {/* ZK mode — proof.json upload */}
          {zkMode && (
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
            <span style={S.hint}> — must be ≥ {activeTask?.threshold.toString() ?? "threshold"}{zkMode ? " (from proof)" : ""}</span>
          </label>
          <input
            style={{ ...S.input, width: 120 }}
            type="number" min="0" max="100" placeholder="0–100"
            value={score}
            onChange={(e) => setScore(e.target.value)}
            required
          />

          <button type="submit" disabled={submitting || !wallet} style={zkMode ? S.btnZK : S.btn}>
            {submitting ? "Submitting…" : zkMode ? "Submit with ZK Proof" : "Submit Work"}
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
  btn:          { marginTop: 24, background: "#1a2a4a", color: "#6b8fff", border: "1px solid #2a3a6a", padding: "10px 24px", borderRadius: 4, fontSize: 13 },
  btnZK:        { marginTop: 24, background: "#0e2a1a", color: "#3ddc84", border: "1px solid #1a4a2a", padding: "10px 24px", borderRadius: 4, fontSize: 13 },
  warn:         { color: "#886600", fontSize: 12, marginTop: 8 },
  status:       { fontSize: 12, marginTop: 10 },
  txLink:       { fontSize: 11, color: "#555", marginTop: 6 },

  // Mode toggle
  toggleRow:    { display: "flex", alignItems: "center", gap: 8, marginBottom: 24, flexWrap: "wrap" },
  toggleActive:   { background: "#1a2a4a", color: "#6b8fff", border: "1px solid #2a3a6a", padding: "6px 16px", borderRadius: 4 },
  toggleInactive: { background: "transparent", color: "#444", border: "1px solid #222", padding: "6px 16px", borderRadius: 4 },
  toggleActiveZK:   { background: "#0e2a1a", color: "#3ddc84", border: "1px solid #1a4a2a", padding: "6px 16px", borderRadius: 4 },
  toggleInactiveZK: { background: "transparent", color: "#444", border: "1px solid #222", padding: "6px 16px", borderRadius: 4 },
  toggleHint:   { fontSize: 11, color: "#555", marginLeft: 4 },

  // ZK proof upload
  proofBox:   { background: "#0a0f0a", border: "1px solid #1a2a1a", borderRadius: 6, padding: "14px 16px", marginTop: 16 },
  fileRow:    { display: "flex", alignItems: "center", gap: 12, marginTop: 6 },
  fileBtn:    { background: "#0e2a1a", color: "#3ddc84", border: "1px solid #1a4a2a", padding: "6px 14px", borderRadius: 4, cursor: "pointer", fontSize: 12 },
  proofMeta:  { display: "flex", gap: 20, marginTop: 10, fontSize: 11, color: "#4a8a6a" },
};
