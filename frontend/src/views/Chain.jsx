import { useEffect, useRef, useState, useCallback } from "react";
import { ethers } from "ethers";
import { ADDRESSES, TASK_MANAGER_ABI } from "../contracts";
import { getReadProvider, shortAddress } from "../wallet";

const BASESCAN  = "https://sepolia.basescan.org";
const ZERO_HASH = "0x" + "0".repeat(64);

// Named miners matching autoMiner.js — all share one wallet, so we match
// on-chain submissions to miner slots by score proximity to each base.
const MINER_PROFILES = [
  { name: "Miner Alpha", color: "#6b8fff", base: 82 },
  { name: "Miner Beta",  color: "#f0c040", base: 50 },
  { name: "Miner Gamma", color: "#3ddc84", base: 92 },
  { name: "Miner Delta", color: "#b07fff", base: 83 },
];

function getManager(p) {
  return new ethers.Contract(ADDRESSES.TaskManager, TASK_MANAGER_ABI, p);
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
// Finalized block card
// ---------------------------------------------------------------------------
function BlockCard({ block }) {
  return (
    <div style={{
      ...S.block,
      background:  block.noWinner ? "#100808" : "#080e10",
      borderColor: block.noWinner ? "#3a1a1a" : "#1a3a2a",
    }}>
      <div style={S.blockHeader}>
        <span style={{ ...S.blockNum, color: block.noWinner ? "#ff6b6b" : "#3ddc84" }}>
          BLOCK #{block.id}
        </span>
        {!block.noWinner && (
          <span style={block.zkVerified ? S.zkBadge : S.basicBadge}>
            {block.zkVerified ? "ZK✓" : "BASIC"}
          </span>
        )}
      </div>

      {block.noWinner ? (
        <div style={S.fieldGroup}>
          <span style={{ ...S.label, color: "#5a2020" }}>RESULT</span>
          <span style={{ ...S.mono, color: "#ff6b6b" }}>No winner</span>
        </div>
      ) : (
        <>
          <div style={S.fieldGroup}>
            <span style={S.label}>MINER</span>
            <span style={{ ...S.mono, color: "#a0f0a0" }}>{shortAddress(block.miner)}</span>
          </div>
          <div style={S.fieldGroup}>
            <span style={S.label}>SCORE</span>
            <span style={{ ...S.mono, color: "#d0d0e0" }}>{block.score}/100</span>
          </div>
        </>
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
function MinerCard({ slot, isWinner, isLeading, finalized }) {
  const submitted = slot.sub !== null;
  const score     = submitted ? Number(slot.sub.score) : null;
  const subTime   = submitted ? Number(slot.sub.submittedAt) * 1000 : null;

  return (
    <div
      className={isWinner ? "winner-flash" : ""}
      style={{
        ...SL.card,
        background:  isWinner ? "#061410" : submitted ? "#08100e" : "#080810",
        borderColor: isWinner ? "#2a6a3a" : submitted ? "#183828" : "#1a1a2a",
        transition:  "background 0.6s, border-color 0.6s",
      }}
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
      ) : (
        <div style={SL.waiting}>Waiting…</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live Mining section — polls every 5s
// ---------------------------------------------------------------------------
function LiveMining({ onBlockFinalized }) {
  const [liveTask,   setLiveTask]   = useState(null);
  const [slots,      setSlots]      = useState(() => MINER_PROFILES.map((p) => ({ ...p, sub: null })));
  const [countdown,  setCountdown]  = useState("");
  const prevFinalizedRef = useRef(false);
  const prevTaskIdRef    = useRef(0);

  // Poll contract every 5s
  useEffect(() => {
    if (!ADDRESSES.TaskManager) return;
    const manager = getManager(getReadProvider());

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

  return (
    <div style={SL.section}>
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
        {slots.map((slot) => {
          const isWinner  = winningSlot?.name === slot.name;
          const isLeading = slot.sub !== null && Number(slot.sub.score) === leadingScore && leadingScore >= 0;
          return (
            <MinerCard
              key={slot.name}
              slot={slot}
              isWinner={isWinner}
              isLeading={isLeading}
              finalized={liveTask.finalized}
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
async function loadChain(manager) {
  const total = Number(await manager.totalTasks());
  if (total === 0) return { blocks: [], pending: null };

  const allTasks = [];
  for (let i = 1; i <= total; i++) {
    allTasks.push(await manager.getTask(BigInt(i)));
  }

  const now       = Date.now();
  const finalized = allTasks.filter((t) => t.finalized);
  const active    = allTasks.filter((t) => !t.finalized && now < Number(t.deadline) * 1000);

  const blocks = [];
  let prevHash = ZERO_HASH;

  for (const task of finalized) {
    let winnerSub = null;
    if (task.winner !== ethers.ZeroAddress) {
      const subs = await manager.getAllSubmissions(task.id);
      winnerSub  = subs.find((s) => s.miner.toLowerCase() === task.winner.toLowerCase()) ?? null;
    }

    let txHash = null;
    try {
      const evts = await manager.queryFilter(manager.filters.TaskFinalized(task.id));
      if (evts.length > 0) txHash = evts[0].transactionHash;
    } catch { /* non-fatal */ }

    const gradHash = winnerSub?.gradientHash ?? ZERO_HASH;
    blocks.push({
      id:         Number(task.id),
      miner:      task.winner,
      score:      winnerSub ? Number(winnerSub.score) : null,
      zkVerified: winnerSub?.zkVerified ?? false,
      gradHash,
      timestamp:  winnerSub ? Number(winnerSub.submittedAt) * 1000 : null,
      txHash,
      prevHash,
      noWinner:   task.winner === ethers.ZeroAddress,
    });
    prevHash = gradHash;
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
  const [blocks,  setBlocks]  = useState(null);
  const [pending, setPending] = useState(null);
  const [error,   setError]   = useState("");
  const scrollRef   = useRef(null);
  const managerRef  = useRef(null);
  const loadingRef  = useRef(false);

  const doLoad = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const { blocks: b, pending: p } = await loadChain(managerRef.current);
      setBlocks(b);
      setPending(p);
    } catch (e) {
      setError(e.message);
    } finally {
      loadingRef.current = false;
    }
  }, []);

  // Initial load
  useEffect(() => {
    if (!ADDRESSES.TaskManager) return;
    managerRef.current = getManager(getReadProvider());
    doLoad();
  }, [doLoad]);

  // Scroll to end when chain changes
  useEffect(() => {
    if (blocks !== null && scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, [blocks, pending]);

  if (!ADDRESSES.TaskManager) {
    return <p style={S.notice}>Contract not deployed. Update ADDRESSES in contracts.js.</p>;
  }
  if (error)          return <p style={{ ...S.notice, color: "#ff6b6b" }}>{error}</p>;
  if (blocks === null) return <p style={S.notice}>Loading chain…</p>;

  const minedCount = blocks.filter((b) => !b.noWinner).length;

  return (
    <div>
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
      <LiveMining onBlockFinalized={doLoad} />

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
  statVal:   { fontSize: 22, fontWeight: "bold", color: "#3ddc84", fontFamily: "monospace" },
  statLabel: { fontSize: 9, color: "#444", letterSpacing: 1.2, textTransform: "uppercase" },

  scrollOuter: { overflowX: "auto", paddingBottom: 12, marginBottom: 8, scrollbarWidth: "thin", scrollbarColor: "#1e1e30 transparent" },
  chainRow:    { display: "flex", alignItems: "center", minWidth: "max-content", padding: "12px 4px 4px" },

  block: {
    width: 186, minHeight: 188, borderRadius: 6, padding: "12px 14px", flexShrink: 0,
    fontFamily: "'Courier New', Courier, monospace", background: "#08080e",
    border: "1px solid #1e1e30", boxSizing: "border-box",
  },
  blockHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  blockNum:    { fontSize: 10, fontWeight: "bold", letterSpacing: 1 },
  zkBadge:    { fontSize: 8, color: "#3ddc84", border: "1px solid #1a4a2a", borderRadius: 3, padding: "1px 5px", letterSpacing: 0.5, fontFamily: "monospace" },
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
};
