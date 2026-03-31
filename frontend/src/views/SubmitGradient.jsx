import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { ADDRESSES, TASK_MANAGER_ABI } from "../contracts";
import { getReadProvider, formatPOL, timeLeft } from "../wallet";

function getManager(signerOrProvider) {
  return new ethers.Contract(ADDRESSES.TaskManager, TASK_MANAGER_ABI, signerOrProvider);
}

export default function SubmitGradient({ wallet }) {
  const [tasks, setTasks] = useState([]);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [selectedTask, setSelectedTask] = useState("");
  const [gradientHash, setGradientHash] = useState("");
  const [score, setScore] = useState("");
  const [status, setStatus] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [txHash, setTxHash] = useState("");

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

  async function handleSubmit(e) {
    e.preventDefault();
    if (!wallet) { setStatus("Connect your wallet first."); return; }
    if (!gradientHash || !score) { setStatus("Fill in all fields."); return; }

    // Validate bytes32
    let hashBytes;
    try {
      hashBytes = gradientHash.startsWith("0x") ? gradientHash : ethers.keccak256(ethers.toUtf8Bytes(gradientHash));
      if (!/^0x[0-9a-fA-F]{64}$/.test(hashBytes)) throw new Error("invalid");
    } catch {
      setStatus("Gradient hash must be a 32-byte hex string (0x...) or plain text to hash.");
      return;
    }

    const scoreNum = parseInt(score, 10);
    if (isNaN(scoreNum) || scoreNum < 0 || scoreNum > 100) {
      setStatus("Score must be 0–100.");
      return;
    }

    setSubmitting(true);
    setStatus("Sending transaction…");
    setTxHash("");
    try {
      const manager = getManager(wallet.signer);
      const tx = await manager.submitWork(BigInt(selectedTask), hashBytes, scoreNum);
      setStatus("Waiting for confirmation…");
      await tx.wait();
      setTxHash(tx.hash);
      setStatus("Submitted successfully.");
      setGradientHash("");
      setScore("");
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
          {/* Task selector */}
          <label style={S.label}>Select Task</label>
          <select
            value={selectedTask}
            onChange={(e) => setSelectedTask(e.target.value)}
            style={S.input}
          >
            {tasks.map((t) => (
              <option key={t.id.toString()} value={t.id.toString()}>
                #{t.id.toString()} — {t.description.slice(0, 60)}{t.description.length > 60 ? "…" : ""}
              </option>
            ))}
          </select>

          {/* Task info */}
          {activeTask && (
            <div style={S.taskInfo}>
              <span>Threshold: <strong>{activeTask.threshold.toString()}/100</strong></span>
              <span>Reward: <strong style={{ color: "#3ddc84" }}>{formatPOL(activeTask.reward)} POL</strong></span>
              <span>Deadline: <strong>{timeLeft(activeTask.deadline)}</strong></span>
            </div>
          )}

          {/* Gradient hash */}
          <label style={S.label}>
            Gradient Hash
            <span style={S.hint}> — bytes32 hex (0x…) or plain text (will be keccak256 hashed)</span>
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
            <span style={S.hint}> — must be ≥ {activeTask?.threshold.toString() ?? "threshold"}</span>
          </label>
          <input
            style={{ ...S.input, width: 120 }}
            type="number"
            min="0"
            max="100"
            placeholder="0–100"
            value={score}
            onChange={(e) => setScore(e.target.value)}
            required
          />

          <button type="submit" disabled={submitting || !wallet} style={S.btn}>
            {submitting ? "Submitting…" : "Submit Work"}
          </button>

          {!wallet && <p style={S.warn}>Connect your wallet to submit.</p>}
          {status && <p style={{ ...S.status, color: txHash ? "#3ddc84" : status.startsWith("Error") ? "#ff6b6b" : "#aaa" }}>{status}</p>}
          {txHash && (
            <p style={S.txLink}>
              Tx: <a href={`https://sepolia.basescan.org/tx/${txHash}`} target="_blank" rel="noreferrer">{txHash.slice(0, 20)}…</a>
            </p>
          )}
        </form>
      )}
    </div>
  );
}

const S = {
  heading: { color: "#a0b0ff", marginBottom: 20, fontSize: 16, letterSpacing: 1 },
  notice: { color: "#666", padding: "40px 0", textAlign: "center" },
  form: { maxWidth: 540 },
  label: { display: "block", color: "#888", fontSize: 11, letterSpacing: 1, textTransform: "uppercase", marginTop: 20, marginBottom: 6 },
  hint: { color: "#555", textTransform: "none", letterSpacing: 0, fontSize: 11 },
  input: {
    display: "block", width: "100%", background: "#0e0e1a", color: "#d0d0e0",
    border: "1px solid #1e1e30", borderRadius: 4, padding: "8px 10px", outline: "none",
  },
  taskInfo: {
    display: "flex", gap: 24, background: "#0a0a14", border: "1px solid #1a1a28",
    borderRadius: 4, padding: "10px 14px", marginTop: 10, color: "#888", fontSize: 12,
  },
  btn: {
    marginTop: 24, background: "#1a2a4a", color: "#6b8fff", border: "1px solid #2a3a6a",
    padding: "10px 24px", borderRadius: 4, fontSize: 13,
  },
  warn: { color: "#886600", fontSize: 12, marginTop: 8 },
  status: { fontSize: 12, marginTop: 10 },
  txLink: { fontSize: 11, color: "#555", marginTop: 6 },
};
