import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { ADDRESSES, TASK_MANAGER_ABI } from "../contracts";
import { getReadProvider, formatPOL, formatDeadline, timeLeft } from "../wallet";

function getManager(provider) {
  return new ethers.Contract(ADDRESSES.TaskManager, TASK_MANAGER_ABI, provider);
}

function TaskCard({ task }) {
  const expired = Date.now() > Number(task.deadline) * 1000;
  return (
    <div style={S.card}>
      <div style={S.cardHeader}>
        <span style={S.taskId}>TASK #{task.id.toString()}</span>
        <span style={expired ? S.badgeExpired : S.badge}>
          {expired ? "EXPIRED" : timeLeft(task.deadline)}
        </span>
      </div>

      <p style={S.desc}>{task.description}</p>

      <div style={S.meta}>
        <div style={S.metaItem}>
          <span style={S.metaLabel}>Min Score</span>
          <span style={S.metaVal}>{task.threshold.toString()} / 100</span>
        </div>
        <div style={S.metaItem}>
          <span style={S.metaLabel}>Reward</span>
          <span style={{ ...S.metaVal, color: "#3ddc84" }}>{formatPOL(task.reward)} POL</span>
        </div>
        <div style={S.metaItem}>
          <span style={S.metaLabel}>Deadline</span>
          <span style={S.metaVal}>{formatDeadline(task.deadline)}</span>
        </div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!ADDRESSES.TaskManager) { setLoading(false); return; }
    const provider = getReadProvider();
    const manager = getManager(provider);

    (async () => {
      try {
        const total = await manager.totalTasks();
        const all = [];
        for (let i = 1n; i <= total; i++) {
          all.push(await manager.getTask(i));
        }
        // Active = not finalized and deadline in the future
        setTasks(all.filter((t) => !t.finalized && Date.now() < Number(t.deadline) * 1000));
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (!ADDRESSES.TaskManager) {
    return <Notice msg="Contract not deployed yet. Run npm run deploy:baseSepolia and update ADDRESSES in contracts.js." />;
  }
  if (loading) return <Notice msg="Loading tasks…" />;
  if (error) return <Notice msg={`Error: ${error}`} color="#ff6b6b" />;

  return (
    <div>
      <h2 style={S.heading}>Active Tasks</h2>
      {tasks.length === 0
        ? <Notice msg="No active tasks. The owner hasn't posted any tasks yet." />
        : tasks.map((t) => <TaskCard key={t.id.toString()} task={t} />)
      }
    </div>
  );
}

function Notice({ msg, color = "#666" }) {
  return <p style={{ color, padding: "40px 0", textAlign: "center" }}>{msg}</p>;
}

const S = {
  heading: { color: "#a0b0ff", marginBottom: 20, fontSize: 16, letterSpacing: 1 },
  card: {
    background: "#0e0e1a", border: "1px solid #1e1e30", borderRadius: 6,
    padding: "20px 24px", marginBottom: 16,
  },
  cardHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  taskId: { color: "#555", fontSize: 11, letterSpacing: 2 },
  badge: {
    fontSize: 11, padding: "3px 8px", borderRadius: 3, letterSpacing: 1,
    background: "#0a1a10", color: "#3ddc84", border: "1px solid #1a3a20",
  },
  badgeExpired: {
    fontSize: 11, padding: "3px 8px", borderRadius: 3, letterSpacing: 1,
    background: "#1a0a0a", color: "#ff6b6b", border: "1px solid #3a1a1a",
  },
  desc: { color: "#c0c0d8", marginBottom: 16, lineHeight: 1.6 },
  meta: { display: "flex", gap: 32 },
  metaItem: { display: "flex", flexDirection: "column", gap: 4 },
  metaLabel: { fontSize: 10, color: "#444", letterSpacing: 1, textTransform: "uppercase" },
  metaVal: { fontSize: 14, color: "#d0d0e0" },
};
