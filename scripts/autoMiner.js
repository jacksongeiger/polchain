/**
 * autoMiner.js — Era 2 named miners (Alpha, Beta, Gamma, Delta).
 *
 * Per task: ONE miner per block proves (rotation by taskId % 4) — it trains on
 * its shard, then the prove server compiles its actual trained weights against
 * the frozen challenge circuit and produces a Halo2 proof for THIS task's
 * challenge batch. The proven submission carries no score: the contract
 * computes it from the proof's public logits.
 *
 * The other three miners train and submit their REAL locally-measured scores
 * via submitWork — honest CLAIMED entries that can never outrank any proof.
 * There is no simulated-score fallback anywhere: if the prove server is down,
 * miners go silent and say so, they do not invent numbers.
 *
 * Era-1 relics deliberately absent: shared wallet + nonce juggling (each miner
 * owns a wallet), base±jitter scores, basic/advanced modes, one-block-delayed
 * proofs (challenge binding makes pre-proving impossible — that is the point).
 */

require("dotenv").config();
const { ethers } = require("ethers");
const { pathToFileURL } = require("url");
const path = require("path");
const fs   = require("fs");

const { getActiveTaskManagerAddress } = require("./lib/addresses");
const { getMinerWallets, getFeeOpts } = require("./lib/wallets");

process.on("unhandledRejection", (reason) => {
  console.error(`[auto-miner] UNHANDLED REJECTION: ${reason?.stack ?? reason}`);
});

// ---------------------------------------------------------------------------
// Miners — shard index matches miner id; identity is the wallet, not a label
// ---------------------------------------------------------------------------
const MINERS = [
  { name: "Miner Alpha", id: 0, shard: 0 },
  { name: "Miner Beta",  id: 1, shard: 1 },
  { name: "Miner Gamma", id: 2, shard: 2 },
  { name: "Miner Delta", id: 3, shard: 3 },
];

const PROVE_SERVER   = "http://localhost:5001";
const VKA_PATH       = path.resolve(__dirname, "../zk/v2/vka.json");
const SUBMIT_MARGIN  = 25;     // stop submitting this many seconds before deadline
const POLL_INTERVAL  = 5_000;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
const COL = {
  reset: "\x1b[0m", bold: "\x1b[1m", grey: "\x1b[90m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m",
};
const MINER_COLORS = [COL.cyan, COL.yellow, COL.green, COL.magenta];
const ts = () => new Date().toISOString().slice(11, 19);
const slog = (msg) =>
  console.log(`${COL.grey}[${ts()}]${COL.reset} ${COL.yellow}[auto-miner] ${COL.reset}${msg}`);
const mlog = (id, msg) =>
  console.log(`${COL.grey}[${ts()}]${COL.reset} ${MINER_COLORS[id]}${MINERS[id].name.padEnd(12)}${COL.reset}  ${msg}`);

// ---------------------------------------------------------------------------
// Miner stats — persisted to server/miner-stats.json (untracked runtime state)
// ---------------------------------------------------------------------------
const STATS_PATH = path.resolve(__dirname, "../server/miner-stats.json");
const minerStats = Object.fromEntries(
  MINERS.map((m) => [m.id, { wins: 0, submissions: 0, totalScore: 0, bestScore: 0, lastScores: [], proven: 0 }])
);

function saveStats() {
  try { fs.writeFileSync(STATS_PATH, JSON.stringify(minerStats, null, 2)); } catch { /* ignore */ }
}
function recordSubmission(id, score, proven) {
  const s = minerStats[id];
  s.submissions++;
  s.totalScore += score;
  if (proven) s.proven = (s.proven || 0) + 1;
  if (score > s.bestScore) s.bestScore = score;
  s.lastScores.push(score);
  if (s.lastScores.length > 10) s.lastScores.shift();
  saveStats();
}
function recordWin(id) { minerStats[id].wins++; saveStats(); }

// ---------------------------------------------------------------------------
// Prove-server clients
// ---------------------------------------------------------------------------
async function postJson(url, body, timeoutMs = 15_000) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res.json();
}

/** Fast path: real shard training, real test-set score. No ZK. */
async function trainForScore(miner, taskId) {
  try {
    const data = await postJson(`${PROVE_SERVER}/train`,
      { task_id: taskId, miner_id: miner.id }, 180_000);
    if (data.ok) {
      mlog(miner.id, `trained — real score ${data.score}/100 (acc ${(data.accuracy * 100).toFixed(1)}%)`);
      return { score: data.score, hash: data.gradient_hash };
    }
    mlog(miner.id, `${COL.red}/train refused: ${JSON.stringify(data).slice(0, 120)}${COL.reset}`);
  } catch (e) {
    mlog(miner.id, `${COL.red}/train unreachable (${e.message}) — sitting out honestly${COL.reset}`);
  }
  return null; // no fake numbers, ever
}

/** Start an Era-2 prove job: train + compile + witness + prove on the server. */
async function startProveJob(miner, taskId, batchIdx) {
  try {
    const data = await postJson(`${PROVE_SERVER}/v2/prove`,
      { task_id: taskId, batch_idx: batchIdx, miner_id: miner.id });
    if (data.ok) {
      mlog(miner.id, `prove job ${data.job_id.slice(0, 8)}… started (batch ${batchIdx})`);
      return data.job_id;
    }
    mlog(miner.id, `${COL.red}/v2/prove refused: ${data.error}${COL.reset}`);
  } catch (e) {
    mlog(miner.id, `${COL.red}/v2/prove unreachable: ${e.message}${COL.reset}`);
  }
  return null;
}

async function pollJob(jobId) {
  const res = await fetch(`${PROVE_SERVER}/v2/job/${jobId}`,
    { signal: AbortSignal.timeout(5_000) });
  return res.json();
}

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------
function loadVka() {
  return JSON.parse(fs.readFileSync(VKA_PATH, "utf8")).words;
}

async function submitProven(managers, miner, taskId, result, vka) {
  const m = managers[miner.id];
  const fees = await getFeeOpts(m.runner.provider, 3_000_000n);
  mlog(miner.id, `${COL.green}submitting PROOF${COL.reset} — predicted on-chain score ` +
    `${COL.bold}${result.predicted_score}${COL.reset} (local ${result.local_score ?? "—"})`);
  const tx = await m.submitWithProof(
    BigInt(taskId), result.gradient_hash, result.proof, result.instances, vka, fees
  );
  await tx.wait();
  mlog(miner.id, `${COL.green}PROVEN ✓${COL.reset}  tx: ${tx.hash}`);
  recordSubmission(miner.id, result.predicted_score, true);
  return result.predicted_score;
}

async function submitClaimed(managers, miner, taskId, score, hash) {
  const m = managers[miner.id];
  const fees = await getFeeOpts(m.runner.provider);
  mlog(miner.id, `submitting CLAIMED — score ${score}/100 from ${m.runner.address.slice(0, 8)}…`);
  const tx = await m.submitWork(BigInt(taskId), hash, BigInt(score), fees);
  await tx.wait();
  mlog(miner.id, `${COL.green}claimed ✓${COL.reset}  tx: ${tx.hash}`);
  recordSubmission(miner.id, score, false);
  return score;
}

// ---------------------------------------------------------------------------
// One round — prover rotation + claimed entries
// ---------------------------------------------------------------------------
async function runRound(reader, managers, taskId, vka) {
  let task, challenge;
  try {
    task = await reader.getTask(BigInt(taskId));
    challenge = await reader.getTaskChallenge(BigInt(taskId));
  } catch (e) {
    slog(`${COL.red}could not load task #${taskId}: ${e.reason || e.message}${COL.reset}`);
    return;
  }
  const threshold = Number(task.threshold);
  const deadline  = Number(task.deadline);
  const batchIdx  = Number(challenge.batchIdx);
  const proverId  = taskId % MINERS.length;

  slog(`Block #${taskId} — challenge batch ${batchIdx}, threshold ${threshold}, ` +
    `prover this block: ${MINERS[proverId].name}`);

  const results = [];

  // Claimed path: everyone except the prover trains and submits a real score.
  const claimedWork = MINERS.filter((m) => m.id !== proverId).map(async (miner) => {
    const trained = await trainForScore(miner, taskId);
    if (!trained) return;
    if (trained.score < threshold) {
      mlog(miner.id, `score ${trained.score} below threshold ${threshold} — skipping`);
      return;
    }
    if (Math.floor(Date.now() / 1000) >= deadline - 5) {
      mlog(miner.id, "window closed before submission");
      return;
    }
    try {
      const score = await submitClaimed(managers, miner, taskId, trained.score, trained.hash);
      results.push({ minerId: miner.id, score, proven: false });
    } catch (e) {
      mlog(miner.id, `${COL.red}submit error: ${e.reason || e.message}${COL.reset}`);
    }
  });

  // Proven path: rotation miner runs the full prove pipeline.
  const provenWork = (async () => {
    const miner = MINERS[proverId];
    const jobId = await startProveJob(miner, taskId, batchIdx);
    if (!jobId) return;

    let trainedFallback = null;
    while (true) {
      const secsLeft = deadline - Math.floor(Date.now() / 1000);
      if (secsLeft <= SUBMIT_MARGIN) {
        // honest fallback: the proof missed the window — submit the real
        // local score as CLAIMED, visibly second-class. Never a fake number.
        mlog(miner.id, `${COL.yellow}proof missed the window${COL.reset}`);
        if (trainedFallback && trainedFallback.score >= threshold && secsLeft > 5) {
          try {
            const score = await submitClaimed(managers, miner, taskId,
              trainedFallback.score, trainedFallback.hash);
            results.push({ minerId: miner.id, score, proven: false });
          } catch (e) {
            mlog(miner.id, `${COL.red}fallback submit error: ${e.reason || e.message}${COL.reset}`);
          }
        }
        return;
      }

      let job;
      try { job = await pollJob(jobId); } catch { await sleep(3000); continue; }

      if (job.status === "complete") {
        const r = { ...job.result, local_score: job.local_score };
        if (r.predicted_score < threshold) {
          mlog(miner.id, `proven score ${r.predicted_score} below threshold — not submitting`);
          return;
        }
        try {
          const score = await submitProven(managers, miner, taskId, r, vka);
          results.push({ minerId: miner.id, score, proven: true });
        } catch (e) {
          mlog(miner.id, `${COL.red}proof submit error: ${e.reason || e.message}${COL.reset}`);
        }
        return;
      }
      if (job.status === "failed") {
        mlog(miner.id, `${COL.red}prove job failed: ${job.error}${COL.reset} — honest CLAIMED fallback`);
        trainedFallback = await trainForScore(miner, taskId);
        if (trainedFallback && trainedFallback.score >= threshold) {
          try {
            const score = await submitClaimed(managers, miner, taskId,
              trainedFallback.score, trainedFallback.hash);
            results.push({ minerId: miner.id, score, proven: false });
          } catch (e2) {
            mlog(miner.id, `${COL.red}fallback submit error: ${e2.reason || e2.message}${COL.reset}`);
          }
        }
        return;
      }
      if (job.status === "training" && job.local_score != null && !trainedFallback) {
        trainedFallback = { score: job.local_score, hash: job.gradient_hash };
      }
      await sleep(4000);
    }
  })();

  await Promise.all([...claimedWork, provenWork]);

  if (results.length > 0) {
    // proven beats claimed, then score — mirror of the contract's ranking
    const best = results.reduce((a, b) =>
      (b.proven !== a.proven ? (b.proven ? b : a) : (b.score > a.score ? b : a)));
    recordWin(best.minerId);
    mlog(best.minerId, `${COL.green}round leader — ${best.proven ? "PROVEN" : "claimed"} ${best.score}${COL.reset}`);
  }
  slog(`Block #${taskId} round complete (${results.length} submissions)`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const contractsUrl = pathToFileURL(
    path.resolve(__dirname, "../frontend/src/contracts.js")
  ).href;
  const { TASK_MANAGER_ABI_V2 } = await import(contractsUrl);

  const taskManagerAddr = getActiveTaskManagerAddress();
  const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
  const reader   = new ethers.Contract(taskManagerAddr, TASK_MANAGER_ABI_V2, provider);
  const wallets  = getMinerWallets(provider);
  const managers = wallets.map((w) => reader.connect(w));
  const vka      = loadVka();

  slog("=== PoLChain Auto-Miner — Era 2 (proven scores) ===");
  slog(`TaskManagerV2: ${taskManagerAddr}`);
  wallets.forEach((w, i) => slog(`${MINERS[i].name}: ${w.address}`));
  slog(`VKA: ${vka.length} words | prove rotation: 1 miner/block | no simulated scores\n`);

  try {
    const saved = JSON.parse(fs.readFileSync(STATS_PATH, "utf8"));
    for (const m of MINERS) if (saved[m.id]) Object.assign(minerStats[m.id], saved[m.id]);
    slog("Miner stats loaded from disk");
  } catch { /* start fresh */ }

  let lastHandledId = 0;
  let lastSeenBlock = 0;

  const heartbeat = setInterval(() => {
    slog(`heartbeat — polling every ${POLL_INTERVAL / 1000}s | last block seen: #${lastSeenBlock}`);
  }, 30_000);
  heartbeat.unref();

  while (true) {
    try {
      const total = Number(await reader.totalTasks());
      if (total > lastHandledId) {
        for (let id = lastHandledId + 1; id <= total; id++) {
          let task;
          try { task = await reader.getTask(BigInt(id)); } catch { continue; }
          const secsLeft = Number(task.deadline) - Math.floor(Date.now() / 1000);
          lastSeenBlock = id;
          if (!task.finalized && secsLeft > SUBMIT_MARGIN + 10) {
            slog(`New Block #${id} (${secsLeft}s left) — starting round`);
            runRound(reader, managers, id, vka).catch((e) =>
              slog(`${COL.red}Round #${id} error: ${e.message}${COL.reset}`));
          } else {
            slog(`Block #${id} closed or too late (finalized=${task.finalized}, ${secsLeft}s left) — skipping`);
          }
        }
        lastHandledId = total;
      }
    } catch (e) {
      slog(`${COL.red}poll error: ${e.message}${COL.reset}`);
    }
    await sleep(POLL_INTERVAL);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
