/**
 * miningLoop.js — PoLChain infinite block producer
 *
 * Keeps the chain growing like Bitcoin:
 *   1. Check for an already-active task → wait for it to expire
 *   2. Finalize the expired task (pays winner, refunds owner if no subs)
 *   3. Post the next task immediately with a 10-minute deadline
 *   4. Wait for that task to expire, then repeat
 *
 * Run alongside autoMiner.js via: npm run mining
 */
require("dotenv").config();
const { ethers } = require("ethers");
const { pathToFileURL } = require("url");
const { spawn }  = require("child_process");
const path = require("path");
const fs   = require("fs");

const { readAddresses, getActiveTaskManagerAddress } = require("./lib/addresses");

// ---------------------------------------------------------------------------
// Config — Era 2
// ---------------------------------------------------------------------------
// Window must cover train (~15s) + per-proof compile/witness/prove (~65s,
// spike G5 P95 62.4s) + submission margin, for the rotation prover AND a
// possible visitor sharing the serial prove queue. 240s is the honest price
// of verification; the cadence bar in the UI says so rather than hiding it.
const TASK_DURATION = 240;
const REWARD        = ethers.parseEther("100");
// Proven scores at N=8 are multiples of 12 (integer division of 12.5) — the
// threshold admits any nonzero-competence proof while still rejecting zeros.
const THRESHOLD     = 12;
const RETRY_DELAY   = 30_000;       // ms to wait after a recoverable error
const MODEL_PATH    = path.resolve(__dirname, "../zk/global_model.pth");

/** sha256 of the current global model — binds each task to its model lineage. */
function currentModelHash() {
  try {
    const crypto = require("crypto");
    return "0x" + crypto.createHash("sha256").update(fs.readFileSync(MODEL_PATH)).digest("hex");
  } catch {
    return "0x" + "00".repeat(32); // pre-genesis: no model yet
  }
}

// Live EIP-1559 fees from lib/wallets.js — a pinned legacy gasPrice stalls
// whenever Base Sepolia's base fee drifts above it.
const { getFeeOpts }     = require("./lib/wallets");
const GAS_LIMIT          = 300_000n;                           // legacy V1 ceiling — see gasFor()
const LOW_BALANCE_WEI    = ethers.parseEther("0.0001");        // pause threshold

const DESCRIPTIONS = [
  "Train a sentiment classifier on SST-2 dataset. Target accuracy > 82%.",
  "Train an image classifier on CIFAR-10 subset. Target accuracy > 70%.",
  "Train a tabular classifier on UCI Adult dataset. Target accuracy > 80%.",
  "Train a regression model on Boston Housing data. Target R² > 0.70.",
  "Train a text toxicity detector on CivilComments. Target AUC > 0.88.",
  "Train a fraud detection model on synthetic transactions. Target F1 > 0.75.",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function ts()      { return new Date().toISOString().slice(11, 19); }
function log(msg)  { console.log(`[${ts()}] ${msg}`); }

// Python interpreter — prefer the project venv (zk/requirements.txt), fall
// back to system python3. Mirrors server/index.js.
const VENV_PYTHON = path.resolve(__dirname, "../.venv/bin/python");
const PYTHON = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3";

function spawnAggregate(taskId, winnerScore) {
  const aggregatePath = path.resolve(__dirname, "../zk/aggregate.py");
  const args = [aggregatePath, "--task_id", String(taskId), "--winner_score", String(winnerScore)];
  log(`Spawning aggregate.py with args: ${args.slice(1).join(" ")}`);
  const py = spawn(PYTHON, args, { detached: true, stdio: "inherit" });
  py.unref();
  log(`Aggregate spawned for task #${taskId} (winner_score=${winnerScore})`);
}

// ---------------------------------------------------------------------------
// Core actions
// ---------------------------------------------------------------------------
/**
 * Gas limit from a LIVE estimate + 50% headroom, not a fixed ceiling.
 *
 * The old flat GAS_LIMIT (300k) was calibrated against Era 1's V1. V3 costs
 * more and, worse, varies: postTask stores modelHash + batchIdx on top of V1's
 * struct (measured 337,248 — it silently burned the whole 300k and reverted on
 * the first live block), and finalizeTask loops the marginal-reward payout over
 * every proven miner, so its cost scales with participation. A fixed number is
 * the wrong shape for both. Falls back only if the estimate itself reverts.
 */
async function gasFor(contract, method, args, fallback) {
  try {
    const est = await contract[method].estimateGas(...args);
    return (est * 3n) / 2n;
  } catch (e) {
    log(`gas estimate for ${method} failed (${e.shortMessage || e.message}) — using ${fallback}`);
    return fallback;
  }
}

async function getLastTask(manager) {
  const total = Number(await manager.totalTasks());
  if (total === 0) return null;
  return manager.getTask(BigInt(total));
}

async function finalizeTask(manager, taskId) {
  log(`Finalizing Task #${taskId}…`);
  try {
    const limit   = await gasFor(manager, "finalizeTask", [BigInt(taskId)], 2_000_000n);
    const tx      = await manager.finalizeTask(BigInt(taskId), await getFeeOpts(manager.runner.provider, limit));
    const receipt = await tx.wait();

    // V3 TaskFinalized(taskId, totalMarginal, rewardPaid, winners) — no single
    // winner. Aggregation merges the best PROVEN model, so we feed it the top
    // proven score among submissions (the model that improved the chain most).
    let rewardPaid = 0n, winners = 0;
    for (const entry of receipt.logs) {
      try {
        const parsed = manager.interface.parseLog(entry);
        if (parsed.name === "TaskFinalized") {
          rewardPaid = parsed.args.rewardPaid;
          winners    = Number(parsed.args.winners);
        }
      } catch { /* skip */ }
    }

    let topProven = 0;
    try {
      const subs = await manager.getAllSubmissions(BigInt(taskId));
      for (const s of subs) {
        if (s.zkVerified && Number(s.score) > topProven) topProven = Number(s.score);
      }
    } catch (e) {
      log(`getAllSubmissions error (topProven defaulting to 0): ${e.reason || e.message}`);
    }

    if (winners > 0) {
      log(`Task #${taskId} finalized — ${winners} improver(s) paid ${ethers.formatEther(rewardPaid)} POL; top proven ${topProven}/100`);
    } else {
      log(`Task #${taskId} finalized — nobody beat the base, reward refunded to poster.`);
    }
    spawnAggregate(taskId, topProven);
    return true;
  } catch (e) {
    log(`Finalize error: ${e.reason || e.message}`);
    return false;
  }
}

async function postTask(manager, descIndex, duration, threshold) {
  const desc     = DESCRIPTIONS[descIndex % DESCRIPTIONS.length];
  const deadline = Math.floor(Date.now() / 1000) + duration;

  log(`Posting next task: "${desc.slice(0, 72)}"`);
  try {
    const args    = [desc, threshold, REWARD, BigInt(deadline), currentModelHash()];
    const limit   = await gasFor(manager, "postTask", args, 800_000n);
    const tx      = await manager.postTask(...args,
                                           await getFeeOpts(manager.runner.provider, limit));
    const receipt = await tx.wait();

    let taskId = null;
    for (const entry of receipt.logs) {
      try {
        const parsed = manager.interface.parseLog(entry);
        if (parsed.name === "TaskPosted") taskId = Number(parsed.args.taskId);
      } catch { /* skip */ }
    }

    let batchIdx = null;
    for (const entry of receipt.logs) {
      try {
        const parsed = manager.interface.parseLog(entry);
        if (parsed.name === "TaskPosted") batchIdx = Number(parsed.args.batchIdx);
      } catch { /* skip */ }
    }

    const deadlineStr = new Date(deadline * 1000).toLocaleTimeString();
    log(`Task #${taskId} posted — batch ${batchIdx}, deadline in ${duration}s (${deadlineStr})`);
    return { taskId, deadline, batchIdx };
  } catch (e) {
    log(`Post error: ${e.reason || e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Establish the base score — prove the current global model on the block's
// challenge and submit it via establishBase. Marginal rewards are measured
// against this baseline, so it must land before the block finalizes.
// ---------------------------------------------------------------------------
const PROVE_SERVER = "http://localhost:5001";

/**
 * The prove server is BLOCKED for the full duration of a proof — the EZKL prove
 * step is CPU-bound native code holding the GIL, so Flask cannot answer any HTTP
 * request while it runs. Measured: idle polls return in 0.01s, a poll issued
 * during a proof takes 27s. The old 5s poll timeout therefore aborted the base
 * proof on every real block — establishBase could never have succeeded, leaving
 * baseScore at 0 and silently erasing the marginal-improvement story.
 * 90s = ~3x the measured 31s prove time.
 */
const PROVE_HTTP_TIMEOUT = 90_000;
const VKA = (() => {
  try { return require("../zk/v2/vka.json").words; } catch { return null; }
})();

async function establishBase(manager, taskId, batchIdx) {
  if (!VKA) { log("No zk/v2/vka.json — skipping base (rewards degrade to absolute score)"); return; }
  try {
    const start = await fetch(`${PROVE_SERVER}/v2/prove-base`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: taskId, batch_idx: batchIdx }),
      signal: AbortSignal.timeout(PROVE_HTTP_TIMEOUT),
    }).then((r) => r.json());
    if (!start.ok) { log(`base prove refused: ${start.error}`); return; }

    // poll until the base proof is ready (shares the serial prover)
    for (let i = 0; i < 60; i++) {
      await sleep(3_000);
      const job = await fetch(`${PROVE_SERVER}/v2/job/${start.job_id}`,
        { signal: AbortSignal.timeout(PROVE_HTTP_TIMEOUT) }).then((r) => r.json());
      if (job.status === "complete") {
        const r = job.result;
        const tx = await manager.establishBase(BigInt(taskId), r.proof, r.instances, VKA,
          await getFeeOpts(manager.runner.provider, 3_000_000n));
        await tx.wait();
        log(`Base established for #${taskId} — baseScore ${r.predicted_score}  tx: ${tx.hash}`);
        return;
      }
      if (job.status === "failed") { log(`base prove failed: ${job.error}`); return; }
    }
    log(`base proof timed out for #${taskId} — rewards degrade to absolute score this block`);
  } catch (e) {
    log(`establishBase error: ${e.reason || e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
async function main() {
  log("Mining loop started");

  const contractsUrl = pathToFileURL(
    path.resolve(__dirname, "../frontend/src/contracts.js")
  ).href;
  const { TASK_MANAGER_ABI_V3: TASK_MANAGER_ABI, POL_TOKEN_ABI } = await import(contractsUrl);

  const addresses       = readAddresses();
  const taskManagerAddr = getActiveTaskManagerAddress();

  const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
  const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const manager  = new ethers.Contract(taskManagerAddr, TASK_MANAGER_ABI, wallet);
  const token    = new ethers.Contract(addresses.POLToken, POL_TOKEN_ABI, wallet);

  log("=== PoLChain Mining Loop ===");
  log(`TaskManagerV2 (Era 2): ${taskManagerAddr}`);
  log(`Wallet:      ${wallet.address}`);
  log(`Block time:  ${TASK_DURATION}s  Reward: ${ethers.formatEther(REWARD)} POL`);
  log(`Gas:         live EIP-1559 fee data, limit ${GAS_LIMIT}`);
  log(`Low-balance: pause below ${ethers.formatEther(LOW_BALANCE_WEI)} ETH`);
  log("");

  // Approve unlimited POL spend once (idempotent)
  const allowance = await token.allowance(wallet.address, taskManagerAddr);
  if (allowance < REWARD * 10_000n) {
    log("Approving unlimited POL spend on TaskManager…");
    const tx = await token.approve(taskManagerAddr, ethers.MaxUint256);
    await tx.wait();
    log("Approved.");
  }

  let descIndex = 0;

  while (true) {
    try {
      const blockDuration  = TASK_DURATION;
      const blockThreshold = THRESHOLD;

      // Gas guard — log balance and pause if critically low
      const balance = await provider.getBalance(wallet.address);
      log(`Balance: ${ethers.formatEther(balance)} ETH`);
      if (balance < LOW_BALANCE_WEI) {
        log(`⚠️  Low gas — add Sepolia ETH to ${wallet.address}`);
        await sleep(60_000);
        continue;
      }

      log(`Checking for active task…`);
      const last = await getLastTask(manager);
      const now  = Math.floor(Date.now() / 1000);

      // Case 1 — active task exists, wait for it to expire
      if (last && !last.finalized && now < Number(last.deadline)) {
        const secsLeft = Number(last.deadline) - now;
        log(`Active task found — Task #${Number(last.id)} expires in ${secsLeft}s. Waiting…`);
        await sleep((secsLeft + 5) * 1000); // +5s buffer for block propagation
        continue;
      }

      // Case 2 — expired but not yet finalized, finalize it
      if (last && !last.finalized && now >= Number(last.deadline)) {
        log(`Task #${Number(last.id)} expired and unfinalized — finalizing now…`);
        const ok = await finalizeTask(manager, Number(last.id));
        if (!ok) {
          log(`Finalization failed — retrying in 30s…`);
          await sleep(RETRY_DELAY);
          continue;
        }
        descIndex = Number(last.id); // keep description rotation in sync with chain height
      }

      // Case 3 — chain is empty or last task finalized → post next task
      log(`No active task found — posting new one… [duration=${blockDuration}s threshold=${blockThreshold}]`);
      const result = await postTask(manager, descIndex, blockDuration, blockThreshold);
      if (!result) {
        log(`Post failed — retrying in 30s…`);
        await sleep(RETRY_DELAY);
        continue;
      }

      // Establish the marginal-reward baseline before miners' proofs land.
      await establishBase(manager, result.taskId, result.batchIdx);

      // Wait for this task's deadline
      const secsUntilDeadline = result.deadline - Math.floor(Date.now() / 1000);
      log(`Waiting ${secsUntilDeadline}s for task to expire…`);
      await sleep((secsUntilDeadline + 5) * 1000);

    } catch (e) {
      log(`Unexpected error: ${e.message} — retrying in 30s`);
      await sleep(RETRY_DELAY);
    }
  }
}

main().catch((e) => {
  console.error("Mining loop crashed:");
  console.error(e);
  process.exit(1);
});
