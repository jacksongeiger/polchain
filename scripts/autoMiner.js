/**
 * autoMiner.js — PoLChain automatic miner with async ZK proofs
 *
 * One-block-delayed ZK submission:
 *   • When a new block is posted, each miner immediately starts generating a
 *     real Halo2 ZK proof via POST /prove/async (non-blocking).
 *   • At the same time, if a miner has a completed proof from the previous
 *     block, that proof is submitted on-chain via submitWithProof().
 *   • If no proof is ready, the miner falls back to submitWork() so blocks
 *     are never missed while proof generation is in progress.
 *
 * Run alongside miningLoop.js via: npm run mining
 */
require("dotenv").config();
const { ethers } = require("ethers");
const { pathToFileURL } = require("url");
const path   = require("path");
const crypto = require("crypto");

// Catch unhandled promise rejections so they appear in the log instead of
// silently killing the process (Node ≥ 15 exits on unhandledRejection by default).
process.on("unhandledRejection", (reason) => {
  console.error(`[auto-miner] UNHANDLED REJECTION: ${reason?.stack ?? reason}`);
});

// ---------------------------------------------------------------------------
// Miner profiles — shard index matches miner_id (0-3)
// base scores are fallbacks when the Flask prove-server is unreachable
// ---------------------------------------------------------------------------
const MINERS = [
  { name: "Miner Alpha", id: 0, shard: 0, base: 82 },
  { name: "Miner Beta",  id: 1, shard: 1, base: 50 },
  { name: "Miner Gamma", id: 2, shard: 2, base: 92 },
  { name: "Miner Delta", id: 3, shard: 3, base: 83 },
];

const PROVE_SERVER = "http://localhost:5001";

const VARIANCE        = 5;    // ±5 score jitter for fallback local scores

const GAS_PRICE = ethers.parseUnits("0.1", "gwei");
const GAS_LIMIT = 300_000n;
const GAS_OPTS  = { gasPrice: GAS_PRICE, gasLimit: GAS_LIMIT };

// ---------------------------------------------------------------------------
// Per-miner proof state
// ---------------------------------------------------------------------------
// status: 'idle' | 'proving' | 'ready' | 'failed'
const proofState = MINERS.map(() => ({
  status:    "idle",
  taskId:    null,   // which task this proof is for
  jobId:     null,   // server-assigned job UUID
  proofJson: null,   // full ezkl proof JSON (hex_proof + instances)
  score:     null,
  gradHash:  null,
  startedAt: null,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function ts()      { return new Date().toISOString().slice(11, 19); }
function rand(lo, hi) { return lo + Math.floor(Math.random() * (hi - lo + 1)); }

const COL = {
  reset: "\x1b[0m", bold: "\x1b[1m",
  cyan: "\x1b[36m", yellow: "\x1b[33m", green: "\x1b[32m",
  purple: "\x1b[35m", red: "\x1b[31m", grey: "\x1b[90m",
};
const MINER_COLORS = [COL.cyan, COL.yellow, COL.green, COL.purple];

function mlog(id, msg) {
  const col = MINER_COLORS[id] ?? COL.reset;
  console.log(`${COL.grey}[${ts()}]${COL.reset} ${col}${MINERS[id].name.padEnd(12)}${COL.reset}  ${msg}`);
}
function slog(msg) {
  console.log(`${COL.grey}[${ts()}]${COL.reset} ${COL.yellow}[auto-miner] ${COL.reset} ${msg}`);
}

function computeScoreLocal(miner) {
  const jitter = rand(-VARIANCE, VARIANCE);
  return Math.min(100, Math.max(0, miner.base + jitter));
}

function computeGradientHash(miner, taskId, score) {
  // Deterministic-ish hash (matches server's compute_gradient_hash when called
  // with the same task_id/miner_id/score)
  return "0x" + crypto
    .createHash("sha256")
    .update(`${miner.id}:${taskId}:${score}:${Math.floor(Date.now() / 1000)}`)
    .digest("hex");
}

/**
 * Parse ezkl proof JSON into contract-ready (proofBytes, instances).
 * Mirrors parseProofJson() in SubmitGradient.jsx:
 *   instances are little-endian 32-byte field elements → reverse to big-endian uint256.
 */
function parseProofForContract(proofJson) {
  if (!proofJson.hex_proof || !Array.isArray(proofJson.instances?.[0])) {
    throw new Error("Unexpected proof.json format — expected hex_proof and instances");
  }
  const proofBytes = proofJson.hex_proof;
  const instances  = proofJson.instances[0].map((hexLE) => {
    const bigEndian = hexLE.match(/.{2}/g).reverse().join("");
    return BigInt("0x" + bigEndian);
  });
  return { proofBytes, instances };
}

/**
 * Compute the server-matching gradient hash: sha256(task_id || miner_id || score)
 * using big-endian uint32 packing, matching server.py's struct.pack(">III", ...).
 */
function computeGradientHashDeterministic(taskId, minerId, score) {
  const buf = Buffer.alloc(12);
  buf.writeUInt32BE(taskId,  0);
  buf.writeUInt32BE(minerId, 4);
  buf.writeUInt32BE(score,   8);
  return "0x" + crypto.createHash("sha256").update(buf).digest("hex");
}

// ---------------------------------------------------------------------------
// Async proof management
// ---------------------------------------------------------------------------

/**
 * Fire off a POST /prove/async request for this miner + task.
 * Returns immediately — does not wait for proof completion.
 */
async function startProving(miner, taskId) {
  const state    = proofState[miner.id];
  state.status   = "proving";
  state.taskId   = taskId;
  state.jobId    = null;
  state.proofJson = null;
  state.score    = null;
  state.gradHash = null;
  state.startedAt = Date.now();

  mlog(miner.id, `starting ZK proof for block #${taskId}…`);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(`${PROVE_SERVER}/prove/async`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ task_id: taskId, miner_id: miner.id }),
      signal:  controller.signal,
    });
    clearTimeout(timer);
    const data = await res.json();
    if (data.ok) {
      state.jobId = data.job_id;
      mlog(miner.id, `ZK job ${data.job_id.slice(0, 8)}… started for block #${taskId}`);
    } else {
      state.status = "failed";
      mlog(miner.id, `${COL.red}prove/async error: ${data.error}${COL.reset}`);
    }
  } catch (e) {
    state.status = "failed";
    mlog(miner.id, `${COL.red}prove/async unreachable: ${e.message}${COL.reset}`);
  }
}

/**
 * Poll GET /prove/status/<job_id> for every miner currently proving.
 * Updates proofState in-place when a job completes or fails.
 */
async function pollAllProofStatuses() {
  for (const miner of MINERS) {
    const state = proofState[miner.id];
    if (state.status !== "proving" || !state.jobId) continue;

    try {
      const res = await fetch(`${PROVE_SERVER}/prove/status/${state.jobId}`, {
        signal: AbortSignal.timeout(5_000),
      });
      const data = await res.json();

      if (data.status === "complete") {
        state.status   = "ready";
        state.proofJson = data.proof;
        state.score    = data.score;
        state.gradHash = data.gradient_hash;
        const elapsed  = Math.round((Date.now() - state.startedAt) / 1000);
        mlog(miner.id, `${COL.green}Proof ready ✓${COL.reset} for block #${state.taskId}  (${elapsed}s)`);
      } else if (data.status === "failed") {
        state.status = "failed";
        mlog(miner.id, `${COL.red}Proof failed for block #${state.taskId}: ${data.error}${COL.reset}`);
      }
    } catch { /* non-fatal — will retry on next poll */ }
  }
}

// ---------------------------------------------------------------------------
// Get score + hash from /train (fast path, no ZK)
// ---------------------------------------------------------------------------
async function getScoreAndHash(miner, taskId) {
  const url = `${PROVE_SERVER}/train`;
  mlog(miner.id, `calling ${url}  task_id=${taskId}  miner_id=${miner.id}`);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ task_id: taskId, miner_id: miner.id }),
      signal:  controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      if (data.ok) {
        mlog(miner.id, `real MNIST score: ${data.score}/100  (acc ${(data.accuracy * 100).toFixed(1)}%)`);
        return { score: data.score, hash: data.gradient_hash };
      }
      mlog(miner.id, `${COL.red}server ok=false: ${JSON.stringify(data)}${COL.reset}`);
    } else {
      const body = await res.text().catch(() => "(unreadable)");
      mlog(miner.id, `${COL.red}HTTP ${res.status}: ${body}${COL.reset}`);
    }
  } catch (e) {
    mlog(miner.id, `${COL.red}fetch error: ${e.name}: ${e.message}${COL.reset}`);
  }
  const score = computeScoreLocal(miner);
  const hash  = computeGradientHash(miner, taskId, score);
  mlog(miner.id, `falling back to local score: ${score}/100`);
  return { score, hash };
}

// ---------------------------------------------------------------------------
// Handle a single task round
// ---------------------------------------------------------------------------
async function runRound(manager, taskId, threshold) {
  slog(`Block #${taskId} posted — ${MINERS.length} miners will compete (threshold: ${threshold}/100)`);

  // Poll in-flight proofs first so we have fresh state
  await pollAllProofStatuses();

  // ── Phase 1: submit ready proofs from previous block (or fall back) ──────
  slog(`Checking for ready proofs from previous blocks…`);

  // Train fetches run in parallel for miners that need the fallback path.
  const trainResults = await Promise.all(
    MINERS.map((m) =>
      proofState[m.id].status === "ready"
        ? Promise.resolve(null)
        : getScoreAndHash(m, taskId)
    )
  );

  // Resolve each miner's score/hash/proof before touching the chain
  const submissions = MINERS.map((miner, i) => {
    const state = proofState[miner.id];
    let score, hash, useProof, proofBytes, instances;

    if (state.status === "ready") {
      score    = state.score;
      hash     = computeGradientHashDeterministic(taskId, miner.id, score);
      useProof = true;
      try {
        ({ proofBytes, instances } = parseProofForContract(state.proofJson));
      } catch (e) {
        mlog(miner.id, `${COL.red}proof parse error: ${e.message} — falling back to submitWork${COL.reset}`);
        useProof = false;
        const fb = trainResults[i] || { score: computeScoreLocal(miner), hash: computeGradientHash(miner, taskId, computeScoreLocal(miner)) };
        score = fb.score; hash = fb.hash;
      }
    } else {
      useProof = false;
      const fb = trainResults[i];
      score = fb.score; hash = fb.hash;
    }

    return { miner, state, score, hash, useProof, proofBytes, instances };
  });

  // Fetch base nonce once — assign nonce+i to each miner to avoid conflicts
  let baseNonce;
  try {
    baseNonce = await manager.runner.getNonce("pending");
    slog(`Base nonce for this round: ${baseNonce}`);
  } catch (e) {
    slog(`${COL.red}Could not fetch nonce: ${e.message} — aborting round${COL.reset}`);
    return;
  }

  // Submit sequentially with explicit nonces — no delay needed between txs
  let nonceOffset = 0;
  for (const { miner, state, score, hash, useProof, proofBytes, instances } of submissions) {
    // Verify task still open before each send
    try {
      const task = await manager.getTask(BigInt(taskId));
      const now  = Math.floor(Date.now() / 1000);
      if (task.finalized || now >= Number(task.deadline)) {
        mlog(miner.id, `block #${taskId} closed — stopping submissions`);
        break;
      }
      if (score < threshold) {
        mlog(miner.id, `score ${score} below threshold ${threshold} — skipping`);
        continue; // no tx sent, so don't consume a nonce slot
      }
    } catch { break; }

    const nonce = baseNonce + nonceOffset;
    nonceOffset++;

    try {
      let tx;
      if (useProof) {
        mlog(miner.id, `${COL.green}submitting ZK proof (block #${state.taskId}→#${taskId})${COL.reset}  score: ${COL.bold}${score}/100${COL.reset}  nonce: ${nonce}`);
        tx = await manager.submitWithProof(
          BigInt(taskId), hash, BigInt(score), proofBytes, instances,
          { ...GAS_OPTS, gasLimit: 2_000_000n, nonce }
        );
      } else {
        mlog(miner.id, `submitting (basic) — score: ${COL.bold}${score}/100${COL.reset}  nonce: ${nonce}`);
        tx = await manager.submitWork(BigInt(taskId), hash, BigInt(score), { ...GAS_OPTS, nonce });
      }
      await tx.wait();
      if (useProof) {
        mlog(miner.id, `${COL.green}ZK✓ confirmed${COL.reset}  score: ${score}  tx: ${tx.hash}`);
        state.status = "idle"; // proof consumed
      } else {
        mlog(miner.id, `${COL.green}confirmed${COL.reset}  score: ${score}  tx: ${tx.hash}`);
      }
      startProving(miner, taskId).catch((e) =>
        mlog(miner.id, `${COL.red}startProving error: ${e.message}${COL.reset}`)
      );
    } catch (e) {
      const reason = e.reason || e.message || "";
      if (reason.includes("deadline passed") || reason.includes("finalized")) {
        mlog(miner.id, `block closed before tx confirmed — stopping submissions`);
        break;
      } else {
        mlog(miner.id, `${COL.red}tx error: ${reason}${COL.reset}`);
      }
    }
  }

  slog(`Block #${taskId} round complete — proofs starting per-miner after confirmed submissions`);
}

// ---------------------------------------------------------------------------
// Clear any 'ready' proof state that survived a restart or block transition.
// Keeps 'proving' entries only if they have an active jobId — the background
// poller will resolve them to 'ready' or 'failed' naturally.
// ---------------------------------------------------------------------------
function resetStaleProofState() {
  for (const state of proofState) {
    if (state.status === "ready") {
      mlog(proofState.indexOf(state), `clearing stale 'ready' proof state (task #${state.taskId})`);
      state.status   = "idle";
      state.taskId   = null;
      state.jobId    = null;
      state.proofJson = null;
      state.score    = null;
      state.gradHash = null;
      state.startedAt = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Background proof status poller (runs independently of block rounds)
// ---------------------------------------------------------------------------
async function proofPoller() {
  while (true) {
    await sleep(30_000); // poll every 30s
    await pollAllProofStatuses();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const contractsUrl = pathToFileURL(
    path.resolve(__dirname, "../frontend/src/contracts.js")
  ).href;
  const { ADDRESSES, TASK_MANAGER_ABI } = await import(contractsUrl);

  const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
  const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const manager  = new ethers.Contract(ADDRESSES.TaskManager, TASK_MANAGER_ABI, wallet);

  const POLL_INTERVAL  = 5_000;
  const MIN_TIME_LEFT  = 20;

  slog("=== PoLChain Auto-Miner (async ZK) ===");
  slog(`TaskManager: ${ADDRESSES.TaskManager}`);
  slog(`Wallet:      ${wallet.address}`);
  slog(`Miners:      ${MINERS.map((m) => m.name).join(", ")}`);
  slog(`Mode:        ZK proof generation async — one-block-delayed submission`);
  slog(`Polling every ${POLL_INTERVAL / 1000}s\n`);

  // Clear any stale 'ready' proof states from a previous run
  resetStaleProofState();

  // Start background proof status poller
  proofPoller().catch((e) => slog(`${COL.red}proofPoller crashed: ${e.message}${COL.reset}`));

  let lastHandledId = 0;
  let lastSeenBlock = 0;

  // Heartbeat — confirms the polling loop is alive even when no new blocks appear
  const heartbeat = setInterval(() => {
    const proofSummary = proofState
      .map((s, i) => `M${i}:${s.status}`)
      .join(" ");
    slog(`heartbeat — polling every ${POLL_INTERVAL / 1000}s | last block seen: #${lastSeenBlock} | proofs: [${proofSummary}]`);
  }, 15_000);
  heartbeat.unref(); // don't block process exit

  while (true) {
    try {
      const total = Number(await manager.totalTasks());

      if (total > lastHandledId) {
        for (let id = lastHandledId + 1; id <= total; id++) {
          let task;
          try {
            task = await manager.getTask(BigInt(id));
          } catch (e) {
            slog(`Could not fetch task #${id}: ${e.message}`);
            continue;
          }

          const now      = Math.floor(Date.now() / 1000);
          const secsLeft = Number(task.deadline) - now;
          lastSeenBlock  = id;
          if (!task.finalized && secsLeft > 0) {
            if (secsLeft < MIN_TIME_LEFT) {
              slog(`Block #${id} skipped — only ${secsLeft}s remaining (< ${MIN_TIME_LEFT}s threshold)`);
            } else {
              slog(`New Block #${id} detected (${secsLeft}s left) — starting round`);
              resetStaleProofState();
              runRound(manager, id, Number(task.threshold)).catch((e) =>
                slog(`${COL.red}Round #${id} error: ${e.message}${COL.reset}`)
              );
            }
          } else {
            slog(`Block #${id} already closed (finalized=${task.finalized}, secsLeft=${secsLeft}) — skipping`);
          }
        }
        lastHandledId = total;
      }
    } catch (e) {
      slog(`Poll error: ${e.message}`);
    }

    await sleep(POLL_INTERVAL);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
