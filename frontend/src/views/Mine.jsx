/**
 * Mine — anyone with a wallet is a miner. The five-stage pipeline:
 *
 *   CONNECT → FUEL → TRAIN → PROVE → SUBMIT
 *
 * Train runs entirely in this tab (TensorFlow.js, lazy-loaded). Proving sends
 * the trained weights to PoLChain's prover — which can refuse service but
 * cannot fake the score, because the contract computes the score from the
 * proof's public logits. The visitor signs their own submitWithProof; their
 * address competes against Alpha-Delta on equal terms.
 *
 * The canonical ending is a LOSS — losing to a miner that has trained all era
 * is what a working market looks like. A win is a bonus.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { ADMIN_API, PROVE_SERVER, fetchAddresses } from "../config";
import { TASK_MANAGER_ABI_V2 } from "../contracts";
import { getReadProvider } from "../wallet";

const STAGES = ["Connect", "Fuel", "Train", "Prove", "Submit"];
const FAUCET = "https://portal.cdp.coinbase.com/products/faucet";

// ---------------------------------------------------------------------------
// Chain context — current era manager + live task, polled
// ---------------------------------------------------------------------------
function useEraTask() {
  const [ctx, setCtx] = useState({ status: "loading" });
  const readerRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const addresses = await fetchAddresses();
      const eras = addresses.eras || [];
      const era = eras.find((e) => !e.sealed) || eras[eras.length - 1];
      const managerAddr = era?.taskManager || addresses.TaskManagerAdvanced;

      if (!readerRef.current || readerRef.current.target !== managerAddr) {
        readerRef.current = new ethers.Contract(managerAddr, TASK_MANAGER_ABI_V2, getReadProvider());
      }
      const reader = readerRef.current;

      let sealed = false;
      try { sealed = await reader.isSealed(); } catch { /* not a V2 contract */ }
      if (!sealed) {
        setCtx({ status: "pre-era2", managerAddr });
        return;
      }

      const total = Number(await reader.totalTasks());
      if (total === 0) {
        setCtx({ status: "no-task", managerAddr, reader });
        return;
      }
      const task = await reader.getTask(BigInt(total));
      const challenge = await reader.getTaskChallenge(BigInt(total));
      const subs = await reader.getAllSubmissions(BigInt(total));
      setCtx({
        status: "live",
        managerAddr,
        reader,
        taskId: total,
        threshold: Number(task.threshold),
        deadline: Number(task.deadline),
        finalized: task.finalized,
        winner: task.winner,
        batchIdx: Number(challenge.batchIdx),
        reward: task.reward,
        submissions: subs.map((s) => ({
          miner: s.miner, score: Number(s.score), zkVerified: s.zkVerified,
        })),
      });
    } catch (e) {
      setCtx({ status: "error", error: e.message });
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 8000);
    return () => clearInterval(t);
  }, [refresh]);

  return { ctx, refresh };
}

// ---------------------------------------------------------------------------
// In-browser training (TensorFlow.js, lazy)
// ---------------------------------------------------------------------------
async function loadShard() {
  const res = await fetch(`${ADMIN_API}/api/visitor-shard`);
  if (!res.ok) throw new Error("visitor shard unavailable");
  const buf = new Uint8Array(await res.arrayBuffer());
  const n = 2000;
  const labels = buf.slice(0, n);
  const pixels = buf.slice(n);
  return { labels, pixels, n };
}

async function trainInBrowser({ onProgress }) {
  const tf = await import("@tensorflow/tfjs");
  await tf.ready();
  const { labels, pixels, n } = await loadShard();

  const X = tf.tensor2d(Float32Array.from(pixels, (v) => v / 255), [n, 784]);
  const Y = tf.oneHot(tf.tensor1d(labels, "int32"), 10);

  const split = 1600;
  const [Xtr, Xte] = [X.slice([0, 0], [split, 784]), X.slice([split, 0], [n - split, 784])];
  const [Ytr, Yte] = [Y.slice([0, 0], [split, 10]), Y.slice([split, 0], [n - split, 10])];

  const model = tf.sequential();
  model.add(tf.layers.dense({ units: 128, activation: "relu", inputShape: [784] }));
  model.add(tf.layers.dense({ units: 64, activation: "relu" }));
  model.add(tf.layers.dense({ units: 10 })); // raw logits — softmax lives in the loss
  model.compile({
    optimizer: tf.train.adam(1e-3),
    loss: (yTrue, yPred) => tf.losses.softmaxCrossEntropy(yTrue, yPred),
  });

  const losses = [];
  await model.fit(Xtr, Ytr, {
    epochs: 6,
    batchSize: 64,
    shuffle: true,
    callbacks: {
      onBatchEnd: (_, logs) => {
        losses.push(logs.loss);
        if (losses.length % 5 === 0) onProgress({ losses: [...losses] });
      },
      onEpochEnd: async (epoch) => {
        const pred = model.predict(Xte);
        const acc = (await tf.metrics.categoricalAccuracy(Yte, pred).mean().data())[0];
        pred.dispose();
        onProgress({ losses: [...losses], epoch: epoch + 1, acc });
      },
    },
  });

  const pred = model.predict(Xte);
  const acc = (await tf.metrics.categoricalAccuracy(Yte, pred).mean().data())[0];
  pred.dispose();

  // kernel shape is [in, out] — the prover transposes to torch layout
  const [k1, b1] = model.layers[0].getWeights();
  const [k2, b2] = model.layers[1].getWeights();
  const [k3, b3] = model.layers[2].getWeights();
  const weights = {
    fc1_w: k1.arraySync(), fc1_b: b1.arraySync(),
    fc2_w: k2.arraySync(), fc2_b: b2.arraySync(),
    fc3_w: k3.arraySync(), fc3_b: b3.arraySync(),
  };

  X.dispose(); Y.dispose(); Xtr.dispose(); Xte.dispose(); Ytr.dispose(); Yte.dispose();
  model.dispose();
  return { weights, localScore: Math.round(acc * 100) };
}

// ---------------------------------------------------------------------------
// Small bits
// ---------------------------------------------------------------------------
function LossSparkline({ losses }) {
  if (!losses || losses.length < 2) return null;
  const w = 320, h = 64;
  const max = Math.max(...losses), min = Math.min(...losses);
  const pts = losses.map((l, i) =>
    `${(i / (losses.length - 1)) * w},${h - ((l - min) / (max - min + 1e-9)) * (h - 6) - 3}`
  ).join(" ");
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <polyline points={pts} fill="none" stroke="var(--miner-you)" strokeWidth="1.5" />
    </svg>
  );
}

function Countdown({ deadline }) {
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, deadline - now);
  return <span>{Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</span>;
}

function badge(zk) {
  return zk
    ? { label: "PROVEN", color: "var(--success)" }
    : { label: "CLAIMED", color: "var(--text-tertiary)" };
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------
export default function Mine({ wallet, onConnect, connecting }) {
  const { ctx, refresh } = useEraTask();
  const [balance, setBalance] = useState(null);
  const [train, setTrain] = useState({ status: "idle" });   // idle|loading|training|done|error
  const [prove, setProve] = useState({ status: "idle" });   // idle|queued|proving|done|failed
  const [submit, setSubmit] = useState({ status: "idle" }); // idle|signing|pending|confirmed|error
  const [settle, setSettle] = useState(null);               // {won, winnerName, winnerScore, myScore, txHash}
  const [minerNames, setMinerNames] = useState({});
  const submittedTask = useRef(null);

  // named-miner address → name map for the standings rail
  useEffect(() => {
    fetch(`${ADMIN_API}/api/addresses`).then((r) => r.json()).then((d) => {
      const map = {};
      Object.values(d.minerWallets || {}).forEach((m) => { map[m.address.toLowerCase()] = m.name; });
      setMinerNames(map);
    }).catch(() => {});
  }, []);

  // gas balance for the Fuel stage
  useEffect(() => {
    if (!wallet?.signer?.provider) return;
    wallet.signer.provider.getBalance(wallet.address)
      .then((b) => setBalance(b)).catch(() => {});
  }, [wallet, submit.status]);

  // settle watcher — after our submission, watch for finalization
  useEffect(() => {
    if (submit.status !== "confirmed" || !ctx.reader || settle) return;
    const taskId = submittedTask.current;
    const t = setInterval(async () => {
      try {
        const task = await ctx.reader.getTask(BigInt(taskId));
        if (!task.finalized) return;
        clearInterval(t);
        const subs = await ctx.reader.getAllSubmissions(BigInt(taskId));
        const mine = subs.find((s) => s.miner.toLowerCase() === wallet.address.toLowerCase());
        const winner = subs.find((s) => s.miner.toLowerCase() === task.winner.toLowerCase());
        const winnerName = minerNames[task.winner.toLowerCase()] ||
          (task.winner.toLowerCase() === wallet.address.toLowerCase() ? "YOU" : task.winner.slice(0, 8));
        setSettle({
          won: task.winner.toLowerCase() === wallet.address.toLowerCase(),
          winnerName,
          winnerScore: winner ? Number(winner.score) : null,
          myScore: mine ? Number(mine.score) : null,
          winnerAddr: task.winner,
        });
      } catch { /* keep watching */ }
    }, 6000);
    return () => clearInterval(t);
  }, [submit.status, ctx.reader, wallet, minerNames, settle]);

  // ── stage index ───────────────────────────────────────────────────────────
  const fueled = balance != null && balance > ethers.parseEther("0.0005");
  let stageIdx = 0;
  if (wallet) stageIdx = 1;
  if (wallet && fueled) stageIdx = 2;
  if (train.status === "done") stageIdx = 3;
  if (prove.status === "done") stageIdx = 4;
  if (submit.status === "confirmed") stageIdx = 5;

  // ── handlers ──────────────────────────────────────────────────────────────
  const startTrain = useCallback(async () => {
    setTrain({ status: "loading" });
    setSettle(null);
    setProve({ status: "idle" });
    setSubmit({ status: "idle" });
    try {
      const result = await trainInBrowser({
        onProgress: (p) => setTrain((t) => ({ ...t, status: "training", ...p })),
      });
      setTrain((t) => ({ ...t, status: "done", ...result }));
    } catch (e) {
      setTrain({ status: "error", error: e.message });
    }
  }, []);

  const startProve = useCallback(async () => {
    if (ctx.status !== "live" || train.status !== "done") return;
    setProve({ status: "queued" });
    try {
      const res = await fetch(`${PROVE_SERVER}/v2/prove-visitor`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task_id: ctx.taskId, batch_idx: ctx.batchIdx, weights: train.weights,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      const jobId = data.job_id;
      const poll = setInterval(async () => {
        try {
          const j = await (await fetch(`${PROVE_SERVER}/v2/job/${jobId}`)).json();
          const q = await (await fetch(`${PROVE_SERVER}/v2/queue`)).json();
          if (j.status === "complete") {
            clearInterval(poll);
            setProve({ status: "done", result: j.result, taskId: ctx.taskId });
          } else if (j.status === "failed") {
            clearInterval(poll);
            setProve({ status: "failed", error: j.error });
          } else {
            const ahead = (q.active || []).filter((a) => a.kind === "named").length;
            setProve({ status: j.status === "proving" ? "proving" : "queued", ahead });
          }
        } catch { /* prover offline — keep state, honest blocking */ }
      }, 3000);
    } catch (e) {
      setProve({ status: "failed", error: e.message });
    }
  }, [ctx, train]);

  const startSubmit = useCallback(async () => {
    if (prove.status !== "done" || !wallet) return;
    setSubmit({ status: "signing" });
    try {
      const info = await (await fetch(`${PROVE_SERVER}/v2/info`)).json();
      if (!info.ok) throw new Error("prover /v2/info unavailable");
      const manager = new ethers.Contract(ctx.managerAddr, TASK_MANAGER_ABI_V2, wallet.signer);
      const r = prove.result;
      const tx = await manager.submitWithProof(
        BigInt(prove.taskId), r.gradient_hash, r.proof, r.instances, info.vka
      );
      submittedTask.current = prove.taskId;
      setSubmit({ status: "pending", txHash: tx.hash });
      await tx.wait();
      setSubmit({ status: "confirmed", txHash: tx.hash });
      refresh();
    } catch (e) {
      setSubmit({ status: "error", error: e.reason || e.shortMessage || e.message });
    }
  }, [prove, wallet, ctx, refresh]);

  const reset = useCallback(() => {
    setTrain({ status: "idle" });
    setProve({ status: "idle" });
    setSubmit({ status: "idle" });
    setSettle(null);
  }, []);

  // ── render ────────────────────────────────────────────────────────────────
  if (ctx.status === "pre-era2") {
    return (
      <div style={S.gate}>
        <div style={S.gateTitle}>Era 2 is not live yet</div>
        <div style={S.gateBody}>
          Open mining requires the Era-2 contract (proven scores, permissionless
          submission). The current contract at <code style={S.code}>{ctx.managerAddr}</code>{" "}
          is the Era-1 chain. Run <code style={S.code}>node scripts/startNewEra.js</code> to cut over.
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* cadence bar */}
      <div style={S.cadence}>
        {ctx.status === "live" ? (
          <>
            <span style={S.cadenceBlock}>BLOCK #{ctx.taskId}</span>
            <span style={S.cadenceItem}>challenge batch {ctx.batchIdx} · threshold {ctx.threshold}</span>
            <span style={S.cadenceItem}>
              {ctx.finalized ? "settled" : <>closes in <Countdown deadline={ctx.deadline} /></>}
            </span>
            <span style={{ ...S.cadenceItem, marginLeft: "auto" }}>
              New block, new draw from the committed pool — every proof is single-use.
            </span>
          </>
        ) : (
          <span style={S.cadenceItem}>
            {ctx.status === "error" ? `chain unreachable: ${ctx.error}` : "waiting for a task…"}
          </span>
        )}
      </div>

      <div style={S.layout}>
        {/* ── pipeline ── */}
        <div>
          <div style={S.stageRail}>
            {STAGES.map((s, i) => (
              <div key={s} style={S.stage(i < stageIdx, i === stageIdx)}>
                <span style={S.stageNum(i < stageIdx, i === stageIdx)}>{i < stageIdx ? "✓" : i + 1}</span>
                {s}
              </div>
            ))}
          </div>

          {/* settled overrides everything — the ending screen */}
          {settle ? (
            <div style={S.panel}>
              {settle.won ? (
                <>
                  <div style={{ ...S.bigVerdict, color: "var(--miner-you)" }}>BLOCK WON</div>
                  <div style={S.verdictBody}>
                    Your proven {settle.myScore} took block #{submittedTask.current}. 100 POL
                    just moved to your address — that transfer is on a public block explorer,
                    not in our database.
                  </div>
                  <a style={S.link} target="_blank" rel="noreferrer"
                     href={`https://sepolia.basescan.org/address/${wallet?.address}#tokentxns`}>
                    See the POL at your address on BaseScan ↗
                  </a>
                </>
              ) : (
                <>
                  <div style={{ ...S.bigVerdict, color: "var(--text-secondary)" }}>BLOCK LOST</div>
                  <div style={S.verdictBody}>
                    {settle.winnerName} took it {settle.winnerScore}–{settle.myScore}. You lost
                    to a miner that has been training all era. That's a working market — your
                    proof still beat every unproven claim on the block.
                  </div>
                </>
              )}
              <button style={S.primaryBtn} onClick={reset}>⟳ Retrain and try the next block</button>
            </div>
          ) : (
            <div style={S.panel}>
              {/* CONNECT */}
              {stageIdx === 0 && (
                <>
                  <div style={S.panelTitle}>A wallet is a mining license. No allowlist.</div>
                  <div style={S.panelBody}>
                    The Era-2 contract is ownerless — anyone may submit work, and the
                    contract computes proven scores itself. Connect to compete against
                    Alpha, Beta, Gamma and Delta under identical rules.
                  </div>
                  <button style={S.primaryBtn} onClick={onConnect} disabled={connecting}>
                    {connecting ? "Connecting…" : "Connect Wallet"}
                  </button>
                </>
              )}

              {/* FUEL */}
              {stageIdx === 1 && (
                <>
                  <div style={S.panelTitle}>Fuel — Base Sepolia gas</div>
                  <div style={S.panelBody}>
                    Submitting a proof is an on-chain transaction (~1.9M gas — fractions of a
                    cent on Base). Balance: {balance == null ? "…" : `${ethers.formatEther(balance).slice(0, 8)} ETH`}.
                  </div>
                  <a style={S.link} href={FAUCET} target="_blank" rel="noreferrer">
                    Base Sepolia faucet ↗
                  </a>
                </>
              )}

              {/* TRAIN */}
              {stageIdx === 2 && (
                <>
                  <div style={S.panelTitle}>Train — in this tab</div>
                  <div style={S.panelBody}>
                    Your shard: 2,000 MNIST samples no named miner trains on. Nothing
                    leaves this tab during training — proving will send your weights to
                    PoLChain's prover.
                  </div>
                  {train.status === "idle" && (
                    <button style={S.primaryBtn} onClick={startTrain}>▶ Train (≈10s)</button>
                  )}
                  {train.status === "loading" && <div style={S.mono}>downloading shard…</div>}
                  {train.status === "training" && (
                    <div>
                      <LossSparkline losses={train.losses} />
                      <div style={S.mono}>
                        epoch {train.epoch ?? "…"}/6
                        {train.acc != null && <> · local accuracy {(train.acc * 100).toFixed(1)}%</>}
                      </div>
                    </div>
                  )}
                  {train.status === "error" && <div style={S.errText}>{train.error}</div>}
                </>
              )}

              {/* PROVE */}
              {stageIdx === 3 && (
                <>
                  <div style={S.panelTitle}>Prove — Halo2, weights private</div>
                  <div style={S.panelBody}>
                    YOUR SCORE: <b style={{ color: "var(--miner-you)" }}>{train.localScore}</b> on
                    your local 400-image test. The chain only believes the {`${8}`} images it
                    challenged you on. Your weights go to PoLChain's prover (never on-chain) —
                    it could refuse service; it cannot fake your score. Self-hosting via{" "}
                    <code style={S.code}>ezkl</code> is supported.
                  </div>
                  {prove.status === "idle" && (
                    <button style={S.primaryBtn} onClick={startProve}
                            disabled={ctx.status !== "live" || ctx.finalized}>
                      ▶ Prove on challenge batch {ctx.status === "live" ? ctx.batchIdx : "…"} (≈60s)
                    </button>
                  )}
                  {(prove.status === "queued" || prove.status === "proving") && (
                    <div style={S.mono}>
                      {prove.status === "queued" && prove.ahead > 0
                        ? `a named miner is proving — you're next (guests outrank bots)`
                        : prove.status === "queued" ? "queued…" : "proving your forward pass…"}
                      <div style={S.pulse} />
                    </div>
                  )}
                  {prove.status === "failed" && (
                    <div style={S.errText}>
                      Prover unavailable: {prove.error}. No silent fallback — when the prover
                      is down, nobody gets a proven score, including our own miners.
                    </div>
                  )}
                </>
              )}

              {/* SUBMIT */}
              {stageIdx === 4 && (
                <>
                  <div style={S.panelTitle}>Submit — your wallet, your block</div>
                  <div style={S.panelBody}>
                    Proof ready. Predicted on-chain score:{" "}
                    <b style={{ color: "var(--miner-you)" }}>{prove.result.predicted_score}</b>{" "}
                    (local: {train.localScore} on 400 images — the chain grades only the 8 it
                    challenged you on). The contract will recompute this number from your
                    proof's public logits; the score is not a parameter.
                  </div>
                  {submit.status === "idle" && (
                    <button style={S.primaryBtn} onClick={startSubmit}>✍ Sign submitWithProof</button>
                  )}
                  {submit.status === "signing" && <div style={S.mono}>waiting for your wallet…</div>}
                  {submit.status === "pending" && <div style={S.mono}>tx pending: {submit.txHash?.slice(0, 18)}…</div>}
                  {submit.status === "error" && <div style={S.errText}>{submit.error}</div>}
                </>
              )}

              {/* CONFIRMED, waiting on settle */}
              {stageIdx === 5 && !settle && (
                <>
                  <div style={S.panelTitle}>On the block — pulsing orange</div>
                  <div style={S.panelBody}>
                    Your proven submission is on-chain.{" "}
                    <a style={S.link} target="_blank" rel="noreferrer"
                       href={`https://sepolia.basescan.org/tx/${submit.txHash}`}>tx ↗</a>{" "}
                    When the window closes, anyone — including you — can call finalize.
                    Settlement is contract logic, not operator judgment.
                  </div>
                  <button
                    style={S.primaryBtn}
                    onClick={async () => {
                      try {
                        const manager = new ethers.Contract(ctx.managerAddr, TASK_MANAGER_ABI_V2, wallet.signer);
                        const tx = await manager.finalizeTask(BigInt(submittedTask.current));
                        await tx.wait();
                        refresh();
                      } catch (e) {
                        /* deadline not reached yet — the watcher will settle it */
                      }
                    }}
                    disabled={ctx.status === "live" && !ctx.finalized && ctx.deadline * 1000 > Date.now()}
                  >
                    ⚖ Finalize block #{submittedTask.current} yourself
                    {ctx.status === "live" && ctx.deadline * 1000 > Date.now() && !ctx.finalized && (
                      <> (opens in <Countdown deadline={ctx.deadline} />)</>
                    )}
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* ── standings rail ── */}
        <div style={S.rail}>
          <div style={S.railTitle}>THE COMPETITION — BLOCK #{ctx.status === "live" ? ctx.taskId : "…"}</div>
          {ctx.status === "live" && ctx.submissions.length === 0 && (
            <div style={S.mono}>no submissions yet</div>
          )}
          {ctx.status === "live" && [...ctx.submissions]
            .sort((a, b) => (b.zkVerified - a.zkVerified) || (b.score - a.score))
            .map((s, i) => {
              const you = wallet && s.miner.toLowerCase() === wallet.address.toLowerCase();
              const name = you ? "YOU" : (minerNames[s.miner.toLowerCase()] || `${s.miner.slice(0, 8)}…`);
              const b = badge(s.zkVerified);
              return (
                <div key={i} style={S.railRow(you)}>
                  <span style={{ color: you ? "var(--miner-you)" : "var(--text-primary)", fontWeight: you ? 700 : 500 }}>
                    {name}
                  </span>
                  <span style={{ ...S.railBadge, color: b.color, borderColor: b.color }}>{b.label}</span>
                  <span style={S.railScore}>{s.score}</span>
                </div>
              );
            })}
          <div style={S.railFoot}>
            Proven beats claimed, always — a forged 99 loses to a proven 12.
            Scores here are read from the contract, not this server.
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
const S = {
  gate: {
    padding: "60px 0", textAlign: "center",
  },
  gateTitle: { fontSize: 20, fontWeight: 700, color: "var(--text-primary)", marginBottom: 12 },
  gateBody: { fontSize: 13, color: "var(--text-secondary)", maxWidth: 560, margin: "0 auto", lineHeight: 1.7 },
  cadence: {
    display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap",
    padding: "10px 16px", marginBottom: 22,
    background: "var(--bg-elevated)", border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
    fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)",
  },
  cadenceBlock: { color: "var(--accent)", fontWeight: 700, letterSpacing: "0.08em" },
  cadenceItem: { color: "var(--text-tertiary)" },
  layout: { display: "grid", gridTemplateColumns: "1fr 320px", gap: 22, alignItems: "start" },
  stageRail: { display: "flex", gap: 6, marginBottom: 18 },
  stage: (done, active) => ({
    display: "flex", alignItems: "center", gap: 8,
    padding: "8px 14px", borderRadius: "var(--radius-sm)",
    border: `1px solid ${active ? "var(--miner-you)" : "var(--border)"}`,
    background: active ? "rgba(255,122,69,0.07)" : "var(--bg-elevated)",
    color: done ? "var(--success)" : active ? "var(--text-primary)" : "var(--text-tertiary)",
    fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.06em",
    fontWeight: active ? 700 : 500,
  }),
  stageNum: (done, active) => ({
    width: 16, height: 16, borderRadius: "50%", display: "inline-flex",
    alignItems: "center", justifyContent: "center", fontSize: 9,
    border: `1px solid ${done ? "var(--success)" : active ? "var(--miner-you)" : "var(--border-strong)"}`,
    color: done ? "var(--success)" : active ? "var(--miner-you)" : "var(--text-tertiary)",
  }),
  panel: {
    background: "var(--bg-elevated)", border: "1px solid var(--border)",
    borderRadius: "var(--radius-xl)", padding: "26px 28px", minHeight: 240,
  },
  panelTitle: { fontSize: 16, fontWeight: 700, color: "var(--text-primary)", marginBottom: 10 },
  panelBody: { fontSize: 13, lineHeight: 1.7, color: "var(--text-secondary)", marginBottom: 18, maxWidth: 640 },
  primaryBtn: {
    background: "var(--miner-you)", color: "var(--bg-base)", border: "none",
    padding: "11px 22px", borderRadius: "var(--radius-sm)", cursor: "pointer",
    fontFamily: "var(--font-sans)", fontWeight: 700, fontSize: 12.5,
    letterSpacing: "0.04em", boxShadow: "0 0 24px rgba(255,122,69,0.25)",
  },
  link: { color: "var(--accent)", fontSize: 12.5, fontFamily: "var(--font-mono)" },
  mono: { fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-secondary)", marginTop: 10 },
  errText: { fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--danger)", marginTop: 10, lineHeight: 1.6 },
  pulse: {
    marginTop: 12, width: 120, height: 3, borderRadius: 2,
    background: "linear-gradient(90deg, transparent, var(--miner-you), transparent)",
    animation: "pulse-glow 1.4s ease-in-out infinite",
  },
  bigVerdict: {
    fontFamily: "var(--font-mono)", fontSize: 30, fontWeight: 800,
    letterSpacing: "0.12em", marginBottom: 14,
  },
  verdictBody: { fontSize: 13.5, lineHeight: 1.75, color: "var(--text-secondary)", maxWidth: 620, marginBottom: 18 },
  rail: {
    background: "var(--bg-elevated)", border: "1px solid var(--border)",
    borderRadius: "var(--radius-xl)", padding: "18px 18px",
    position: "sticky", top: 20,
  },
  railTitle: {
    fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.16em",
    color: "var(--text-tertiary)", marginBottom: 14,
  },
  railRow: (you) => ({
    display: "flex", alignItems: "center", gap: 10,
    padding: "9px 10px", borderRadius: "var(--radius-sm)", marginBottom: 6,
    border: `1px solid ${you ? "var(--miner-you)" : "var(--border)"}`,
    background: you ? "rgba(255,122,69,0.06)" : "transparent",
    fontFamily: "var(--font-mono)", fontSize: 12,
    animation: you ? "pulse-glow 2s ease-in-out infinite" : "none",
  }),
  railBadge: {
    fontSize: 8.5, letterSpacing: "0.12em", fontWeight: 700,
    border: "1px solid", borderRadius: 3, padding: "2px 6px", marginLeft: "auto",
  },
  railScore: { fontWeight: 700, color: "var(--text-primary)", width: 28, textAlign: "right" },
  railFoot: {
    marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border)",
    fontSize: 10.5, lineHeight: 1.6, color: "var(--text-tertiary)",
  },
  code: { background: "var(--bg-overlay)", padding: "1px 6px", borderRadius: 4, fontFamily: "var(--font-mono)", fontSize: 11 },
};
