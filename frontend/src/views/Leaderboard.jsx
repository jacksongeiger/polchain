import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { ADDRESSES, TASK_MANAGER_ABI } from "../contracts";
import { getReadProvider, formatPOL, shortAddress, timeLeft } from "../wallet";

function getManager(provider) {
  return new ethers.Contract(ADDRESSES.TaskManager, TASK_MANAGER_ABI, provider);
}

export default function Leaderboard() {
  const [tasks, setTasks] = useState([]);
  const [selectedTask, setSelectedTask] = useState("");
  const [submissions, setSubmissions] = useState([]);
  const [taskMeta, setTaskMeta] = useState(null);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [loadingSubs, setLoadingSubs] = useState(false);
  const [error, setError] = useState("");

  // Load all tasks on mount
  useEffect(() => {
    if (!ADDRESSES.TaskManager) { setLoadingTasks(false); return; }
    const manager = getManager(getReadProvider());
    (async () => {
      try {
        const total = await manager.totalTasks();
        const all = [];
        for (let i = 1n; i <= total; i++) all.push(await manager.getTask(i));
        setTasks(all);
        if (all.length > 0) setSelectedTask(all[all.length - 1].id.toString());
      } catch (e) {
        setError(e.message);
      } finally {
        setLoadingTasks(false);
      }
    })();
  }, []);

  // Load submissions when task selection changes
  useEffect(() => {
    if (!selectedTask) return;
    const manager = getManager(getReadProvider());
    const task = tasks.find((t) => t.id.toString() === selectedTask);
    setTaskMeta(task ?? null);
    setLoadingSubs(true);
    setSubmissions([]);
    (async () => {
      try {
        const subs = await manager.getAllSubmissions(BigInt(selectedTask));
        // Sort by score descending, stable (preserves submission order on tie)
        const sorted = [...subs].sort((a, b) => {
          const diff = Number(b.score) - Number(a.score);
          return diff !== 0 ? diff : Number(a.submittedAt) - Number(b.submittedAt);
        });
        setSubmissions(sorted);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoadingSubs(false);
      }
    })();
  }, [selectedTask, tasks]);

  if (!ADDRESSES.TaskManager) {
    return <p style={S.notice}>Contract not deployed. Update ADDRESSES in contracts.js.</p>;
  }
  if (loadingTasks) return <p style={S.notice}>Loading…</p>;
  if (error) return <p style={{ ...S.notice, color: "#ff6b6b" }}>{error}</p>;
  if (tasks.length === 0) return <p style={S.notice}>No tasks have been posted yet.</p>;

  return (
    <div>
      <div style={S.topRow}>
        <h2 style={S.heading}>Leaderboard</h2>
        <select value={selectedTask} onChange={(e) => setSelectedTask(e.target.value)} style={S.select}>
          {tasks.map((t) => (
            <option key={t.id.toString()} value={t.id.toString()}>
              #{t.id.toString()} — {t.description.slice(0, 50)}{t.description.length > 50 ? "…" : ""}
            </option>
          ))}
        </select>
      </div>

      {taskMeta && (
        <div style={S.taskBar}>
          <span>Threshold: <strong>{taskMeta.threshold.toString()}/100</strong></span>
          <span>Reward: <strong style={{ color: "#3ddc84" }}>{formatPOL(taskMeta.reward)} POL</strong></span>
          <span>{taskMeta.finalized
            ? <span style={{ color: "#3ddc84" }}>Finalized · winner {shortAddress(taskMeta.winner)}</span>
            : <span style={{ color: "#aaa" }}>{timeLeft(taskMeta.deadline)}</span>
          }</span>
        </div>
      )}

      {loadingSubs ? (
        <p style={S.notice}>Loading submissions…</p>
      ) : submissions.length === 0 ? (
        <p style={S.notice}>No submissions yet for this task.</p>
      ) : (
        <table style={S.table}>
          <thead>
            <tr>
              {["Rank", "Miner", "Score", "Gradient Hash", "Submitted"].map((h) => (
                <th key={h} style={S.th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {submissions.map((sub, i) => {
              const isWinner = taskMeta?.finalized && taskMeta.winner.toLowerCase() === sub.miner.toLowerCase();
              return (
                <tr key={i} style={{ background: i === 0 ? "#0c120a" : "transparent" }}>
                  <td style={S.td}>
                    {i === 0
                      ? <span style={{ color: "#f0c040" }}>1st</span>
                      : i === 1 ? <span style={{ color: "#aaa" }}>2nd</span>
                      : i === 2 ? <span style={{ color: "#c87533" }}>3rd</span>
                      : `${i + 1}th`}
                  </td>
                  <td style={S.td}>
                    <span style={{ color: isWinner ? "#3ddc84" : "#d0d0e0" }}>
                      {shortAddress(sub.miner)}{isWinner ? " 🏆" : ""}
                    </span>
                  </td>
                  <td style={{ ...S.td, color: "#a0f0a0", fontWeight: i === 0 ? "bold" : "normal" }}>
                    {sub.score.toString()}
                  </td>
                  <td style={{ ...S.td, color: "#555", fontSize: 11 }}>
                    {sub.gradientHash.slice(0, 12)}…{sub.gradientHash.slice(-6)}
                  </td>
                  <td style={{ ...S.td, color: "#555", fontSize: 11 }}>
                    {new Date(Number(sub.submittedAt) * 1000).toLocaleString()}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

const S = {
  notice: { color: "#666", padding: "40px 0", textAlign: "center" },
  topRow: { display: "flex", alignItems: "center", gap: 16, marginBottom: 16 },
  heading: { color: "#a0b0ff", fontSize: 16, letterSpacing: 1 },
  select: { background: "#0e0e1a", color: "#d0d0e0", border: "1px solid #1e1e30", borderRadius: 4, padding: "6px 10px", flex: 1 },
  taskBar: {
    display: "flex", gap: 24, background: "#0a0a14", border: "1px solid #1a1a28",
    borderRadius: 4, padding: "10px 14px", marginBottom: 20, color: "#888", fontSize: 12,
  },
  table: { width: "100%", borderCollapse: "collapse" },
  th: {
    textAlign: "left", padding: "8px 12px", fontSize: 10, color: "#555",
    letterSpacing: 1, textTransform: "uppercase", borderBottom: "1px solid #1a1a2a",
  },
  td: { padding: "10px 12px", borderBottom: "1px solid #111118", color: "#c0c0d8", verticalAlign: "middle" },
};
