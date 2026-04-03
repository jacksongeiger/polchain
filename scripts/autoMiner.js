/**
 * autoMiner.js — PoLChain automatic miner
 *
 * Watches for TaskPosted events on-chain. When a new task appears,
 * all 4 miners compete by submitting their gradient hashes and scores.
 * Miners use submitWork() (trust-based) rather than submitWithProof()
 * because EZKL proof generation takes ~10 minutes per miner, which
 * exceeds the 10-minute block window when 4 miners run sequentially.
 * Full ZK proving is available via the frontend's Auto-Prove mode.
 *
 * Run alongside miningLoop.js via: npm run mining
 */
require("dotenv").config();
const { ethers } = require("ethers");
const { pathToFileURL } = require("url");
const path   = require("path");
const crypto = require("crypto");

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

const VARIANCE        = 5;    // ±5 score jitter per round
const MIN_DELAY_MS    = 2_000;
const MAX_DELAY_MS    = 8_000;

const GAS_PRICE = ethers.parseUnits("0.1", "gwei");
const GAS_LIMIT = 300_000n;
const GAS_OPTS  = { gasPrice: GAS_PRICE, gasLimit: GAS_LIMIT };

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

function computeScoreLocal(miner, taskId) {
  const jitter = rand(-VARIANCE, VARIANCE);
  return Math.min(100, Math.max(0, miner.base + jitter));
}

function computeGradientHash(miner, taskId, score) {
  // Deterministic-ish hash that changes each round via Date.now()
  return "0x" + crypto
    .createHash("sha256")
    .update(`${miner.id}:${taskId}:${score}:${Math.floor(Date.now() / 1000)}`)
    .digest("hex");
}

/**
 * Try to get a real MNIST training score from the Flask prove-server.
 * Falls back to local jitter-based score if the server is unreachable.
 */
async function getScoreAndHash(miner, taskId) {
  const url = `${PROVE_SERVER}/train`;
  mlog(miner.id, `calling ${url}  task_id=${taskId}  miner_id=${miner.id}`);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000); // 120s — training takes ~15-20s
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ task_id: taskId, miner_id: miner.id }),
      signal:  controller.signal,
    });
    clearTimeout(timer);
    mlog(miner.id, `${url} → HTTP ${res.status}`);
    if (res.ok) {
      const data = await res.json();
      if (data.ok) {
        mlog(miner.id, `real MNIST score from server: ${data.score}/100  (acc ${(data.accuracy * 100).toFixed(1)}%)`);
        return { score: data.score, hash: data.gradient_hash };
      }
      mlog(miner.id, `${COL.red}server returned ok=false: ${JSON.stringify(data)}${COL.reset}`);
    } else {
      const body = await res.text().catch(() => "(unreadable)");
      mlog(miner.id, `${COL.red}HTTP ${res.status} from prove-server: ${body}${COL.reset}`);
    }
  } catch (e) {
    mlog(miner.id, `${COL.red}fetch error: ${e.name}: ${e.message}${COL.reset}`);
  }
  const score = computeScoreLocal(miner, taskId);
  const hash  = computeGradientHash(miner, taskId, score);
  mlog(miner.id, `falling back to local score: ${score}/100`);
  return { score, hash };
}

// ---------------------------------------------------------------------------
// Handle a single task round
// ---------------------------------------------------------------------------
async function runRound(manager, taskId, threshold) {
  slog(`Block #${taskId} posted — ${MINERS.length} miners will compete (threshold: ${threshold}/100)`);

  // Fire all /train requests simultaneously so training runs in parallel
  slog(`Fetching scores for all ${MINERS.length} miners in parallel…`);
  const scoreResults = await Promise.all(
    MINERS.map((miner) => getScoreAndHash(miner, taskId))
  );

  // Serialise transactions through a mutex (all miners share one wallet)
  let txMutex = Promise.resolve();

  // Stagger on-chain submissions with random delays (simulates network latency)
  const minerPromises = MINERS.map(async (miner, i) => {
    const { score, hash } = scoreResults[i];

    const delay = rand(MIN_DELAY_MS, MAX_DELAY_MS);
    await sleep(delay);

    // Verify task still open before queuing the tx
    try {
      const task = await manager.getTask(BigInt(taskId));
      const now  = Math.floor(Date.now() / 1000);
      if (task.finalized || now >= Number(task.deadline)) {
        mlog(miner.id, `block #${taskId} closed — too slow, skipping`);
        return;
      }
      if (score < threshold) {
        mlog(miner.id, `score ${score} below threshold ${threshold} — skipping`);
        return;
      }
    } catch {
      return;
    }

    // Queue the on-chain submission
    await new Promise((resolve) => {
      txMutex = txMutex.then(async () => {
        try {
          mlog(miner.id, `submitting — score: ${COL.bold}${score}/100${COL.reset}`);
          const tx = await manager.submitWork(BigInt(taskId), hash, BigInt(score), GAS_OPTS);
          await tx.wait();
          mlog(
            miner.id,
            `${COL.green}Miner ${miner.name} submitted${COL.reset} — score: ${score}  txHash: ${tx.hash}`
          );
        } catch (e) {
          const reason = e.reason || e.message || "";
          if (reason.includes("deadline passed") || reason.includes("finalized")) {
            mlog(miner.id, `block closed before tx confirmed — skipping`);
          } else {
            mlog(miner.id, `${COL.red}tx error: ${reason}${COL.reset}`);
          }
        }
        resolve();
      });
    });
  });

  await Promise.all(minerPromises);
  await txMutex; // drain any queued txs
  slog(`Block #${taskId} round complete`);
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

  const POLL_INTERVAL  = 5_000; // ms — poll every 5 seconds
  const MIN_TIME_LEFT  = 20;    // seconds — skip block if less than this remains

  slog("=== PoLChain Auto-Miner ===");
  slog(`TaskManager: ${ADDRESSES.TaskManager}`);
  slog(`Wallet:      ${wallet.address}`);
  slog(`Miners:      ${MINERS.map((m) => m.name).join(", ")}`);
  slog(`Variance:    ±${VARIANCE} score per round`);
  slog(`Polling every ${POLL_INTERVAL / 1000}s (filter subscriptions not supported on Base Sepolia RPC)\n`);

  // Track the last task ID we've already handled so we never double-submit.
  let lastHandledId = 0;

  // Poll loop — replaces contract.on() / filter-based subscriptions
  while (true) {
    try {
      const total = Number(await manager.totalTasks());

      if (total > lastHandledId) {
        // One or more new tasks appeared since last poll
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
          if (!task.finalized && secsLeft > 0) {
            if (secsLeft < MIN_TIME_LEFT) {
              slog(`Block #${id} skipped — only ${secsLeft}s remaining, not enough time to submit`);
            } else {
              slog(`New Block #${id} detected (${secsLeft}s left) — miners will compete`);
              runRound(manager, id, Number(task.threshold)).catch((e) =>
                slog(`${COL.red}Round #${id} error: ${e.message}${COL.reset}`)
              );
            }
          } else {
            slog(`Block #${id} already closed — skipping`);
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
