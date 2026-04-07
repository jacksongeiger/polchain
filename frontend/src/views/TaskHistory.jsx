import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { TASK_MANAGER_ABI } from "../contracts";
import { getReadProvider, formatPOL, formatDeadline, shortAddress } from "../wallet";
import { ADMIN_API, fetchAddresses, pickTaskManager, BUILD_TIME_ADDRESSES } from "../config";

function getManager(addr, provider) {
  return new ethers.Contract(addr, TASK_MANAGER_ABI, provider);
}

export default function TaskHistory() {
  const [tasks, setTasks] = useState([]);
  const [submissionCounts, setSubmissionCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeMode, setActiveMode] = useState("advanced");
  const [addresses,  setAddresses]  = useState(BUILD_TIME_ADDRESSES);

  useEffect(() => {
    fetch(`${ADMIN_API}/api/mode`)
      .then((r) => r.json())
      .then((d) => { if (d.mode) setActiveMode(d.mode); })
      .catch(() => {});
    fetchAddresses().then((a) => { if (a) setAddresses(a); });
  }, []);

  const taskManagerAddr = pickTaskManager(addresses, activeMode);

  useEffect(() => {
    if (!taskManagerAddr) return;
    const manager = getManager(taskManagerAddr, getReadProvider());
    (async () => {
      try {
        const total = await manager.totalTasks();
        const all = [];
        for (let i = 1n; i <= total; i++) all.push(await manager.getTask(i));

        // Only finalized or past-deadline tasks for history
        const history = all.filter(
          (t) => t.finalized || Date.now() >= Number(t.deadline) * 1000
        );
        setTasks([...history].reverse()); // newest first

        // Load submission counts in parallel
        const counts = {};
        await Promise.all(
          history.map(async (t) => {
            counts[t.id.toString()] = Number(await manager.getSubmissionCount(t.id));
          })
        );
        setSubmissionCounts(counts);
      } catch (e) {
        const isCallEx =
          e.code === "CALL_EXCEPTION" ||
          e.message?.includes("CALL_EXCEPTION") ||
          e.message?.includes("could not decode result data");
        if (isCallEx) {
          // Stale address — refetch from admin server, the effect will re-run.
          fetchAddresses().then((fresh) => { if (fresh) setAddresses(fresh); });
        } else {
          setError(e.message);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [taskManagerAddr]);

  if (loading) return <p style={S.notice}>Loading history…</p>;
  if (error) return <p style={{ ...S.notice, color: "#ff6b6b" }}>{error}</p>;
  if (tasks.length === 0) return <p style={S.notice}>No completed tasks yet.</p>;

  return (
    <div>
      <h2 style={S.heading}>Block History</h2>
      {tasks.map((task) => {
        const count = submissionCounts[task.id.toString()] ?? "—";
        return (
          <div key={task.id.toString()} style={S.row}>
            <div style={S.rowTop}>
              <span style={S.taskId}>BLOCK #{task.id.toString()}</span>
              <span style={task.finalized ? S.badgeDone : S.badgeExpired}>
                {task.finalized ? "FINALIZED" : "EXPIRED (not finalized)"}
              </span>
            </div>

            <p style={S.desc}>{task.description}</p>

            <div style={S.cols}>
              <div>
                <div style={S.colLabel}>Reward</div>
                <div style={{ color: "#3ddc84" }}>{formatPOL(task.reward)} POL</div>
              </div>
              <div>
                <div style={S.colLabel}>Min Score</div>
                <div>{task.threshold.toString()}/100</div>
              </div>
              <div>
                <div style={S.colLabel}>Submissions</div>
                <div>{count}</div>
              </div>
              <div>
                <div style={S.colLabel}>Deadline</div>
                <div style={{ fontSize: 12, color: "#666" }}>{formatDeadline(task.deadline)}</div>
              </div>
              {task.finalized && task.winner !== ethers.ZeroAddress && (
                <div>
                  <div style={S.colLabel}>Winner</div>
                  <div style={{ color: "#a0f0a0" }}>{shortAddress(task.winner)}</div>
                </div>
              )}
              {task.finalized && task.winner === ethers.ZeroAddress && (
                <div>
                  <div style={S.colLabel}>Winner</div>
                  <div style={{ color: "#666" }}>None (reward refunded)</div>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const S = {
  notice: { color: "#666", padding: "40px 0", textAlign: "center" },
  heading: { color: "#a0b0ff", marginBottom: 20, fontSize: 16, letterSpacing: 1 },
  row: {
    background: "#0e0e1a", border: "1px solid #1e1e30", borderRadius: 6,
    padding: "18px 22px", marginBottom: 14,
  },
  rowTop: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  taskId: { fontSize: 11, color: "#555", letterSpacing: 2 },
  badgeDone: {
    fontSize: 11, padding: "3px 8px", borderRadius: 3, letterSpacing: 1,
    background: "#0a1a10", color: "#3ddc84", border: "1px solid #1a3a20",
  },
  badgeExpired: {
    fontSize: 11, padding: "3px 8px", borderRadius: 3, letterSpacing: 1,
    background: "#1a0a0a", color: "#ff6b6b", border: "1px solid #3a1a1a",
  },
  desc: { color: "#888", marginBottom: 16, fontSize: 13 },
  cols: { display: "flex", gap: 32, flexWrap: "wrap" },
  colLabel: { fontSize: 10, color: "#444", letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 },
};
