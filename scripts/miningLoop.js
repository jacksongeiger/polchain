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

const { readAddresses, readMode, getActiveTaskManagerAddress } = require("./lib/addresses");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const TASK_DURATION = 60;           // seconds — 1-minute blocks
const REWARD        = ethers.parseEther("100");
const THRESHOLD     = 20;           // minimum score a miner must achieve
const RETRY_DELAY   = 30_000;       // ms to wait after a recoverable error

const GAS_PRICE          = ethers.parseUnits("0.1", "gwei"); // explicit low gas price
const GAS_LIMIT          = 300_000n;                           // safe ceiling for all txs
const GAS_OPTS           = { gasPrice: GAS_PRICE, gasLimit: GAS_LIMIT };
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
async function getLastTask(manager) {
  const total = Number(await manager.totalTasks());
  if (total === 0) return null;
  return manager.getTask(BigInt(total));
}

async function finalizeTask(manager, taskId) {
  log(`Finalizing Task #${taskId}…`);
  try {
    const tx      = await manager.finalizeTask(BigInt(taskId), GAS_OPTS);
    const receipt = await tx.wait();

    let winner = null;
    let reward = null;
    for (const entry of receipt.logs) {
      try {
        const parsed = manager.interface.parseLog(entry);
        if (parsed.name === "TaskFinalized") {
          winner = parsed.args.winner;
          reward = parsed.args.reward;
        }
      } catch { /* skip unparseable logs */ }
    }

    let winnerScore = 0;
    if (winner && winner !== ethers.ZeroAddress) {
      let scoreStr = "?";
      try {
        log(`Fetching submissions for task #${taskId} to find winner score…`);
        const subs = await manager.getAllSubmissions(BigInt(taskId));
        log(`getAllSubmissions returned ${subs.length} submission(s) for task #${taskId}:`);
        for (const s of subs) {
          log(`  miner=${s.miner}  score=${s.score}  zkVerified=${s.zkVerified}`);
        }

        if (subs.length === 0) {
          log(`No submissions returned — winner_score will be 0`);
        } else {
          // The winner is whichever submission has the highest score (contract logic).
          // Finding max score across all submissions is more robust than address-matching,
          // which can silently miss if there's any case/type discrepancy.
          const best = subs.reduce((a, b) => (Number(b.score) > Number(a.score) ? b : a));
          scoreStr    = best.score.toString();
          winnerScore = Number(best.score);
          log(`Highest-scoring submission: miner=${best.miner}  score=${winnerScore}`);

          // Sanity-check: confirm it matches the on-chain winner address
          if (best.miner.toLowerCase() !== winner.toLowerCase()) {
            log(`Warning: highest scorer ${best.miner} != on-chain winner ${winner} — using on-chain winner's score`);
            const winnerSub = subs.find((s) => s.miner.toLowerCase() === winner.toLowerCase());
            if (winnerSub) {
              scoreStr    = winnerSub.score.toString();
              winnerScore = Number(winnerSub.score);
              log(`Corrected to winner's actual score: ${winnerScore}`);
            }
          }
        }
      } catch (e) {
        log(`getAllSubmissions error (winner_score defaulting to 0): ${e.reason || e.message}`);
      }
      log(`Task #${taskId} finalized — winner: ${winner}  score: ${scoreStr}/100  reward: ${ethers.formatEther(reward)} POL`);
    } else {
      log(`Task #${taskId} finalized — no valid submissions, reward refunded to owner.`);
    }
    spawnAggregate(taskId, winnerScore);
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
    const tx      = await manager.postTask(desc, threshold, REWARD, BigInt(deadline), GAS_OPTS);
    const receipt = await tx.wait();

    let taskId = null;
    for (const entry of receipt.logs) {
      try {
        const parsed = manager.interface.parseLog(entry);
        if (parsed.name === "TaskPosted") taskId = Number(parsed.args.taskId);
      } catch { /* skip */ }
    }

    const deadlineStr = new Date(deadline * 1000).toLocaleTimeString();
    log(`Task #${taskId} posted — deadline in ${duration}s (${deadlineStr})`);
    return { taskId, deadline };
  } catch (e) {
    log(`Post error: ${e.reason || e.message}`);
    return null;
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
  const { TASK_MANAGER_ABI, POL_TOKEN_ABI } = await import(contractsUrl);

  const addresses       = readAddresses();
  const startMode       = readMode();
  const taskManagerAddr = getActiveTaskManagerAddress(startMode);

  const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
  const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const manager  = new ethers.Contract(taskManagerAddr, TASK_MANAGER_ABI, wallet);
  const token    = new ethers.Contract(addresses.POLToken, POL_TOKEN_ABI, wallet);

  log("=== PoLChain Mining Loop ===");
  log(`TaskManager: ${taskManagerAddr}  [mode=${startMode}]`);
  log(`Wallet:      ${wallet.address}`);
  log(`Block time:  ${TASK_DURATION}s  Reward: ${ethers.formatEther(REWARD)} POL`);
  log(`Gas price:   ${ethers.formatUnits(GAS_PRICE, "gwei")} gwei  limit: ${GAS_LIMIT}`);
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
      // Read mode on every iteration so changes take effect on the next block
      const mode           = readMode();
      const blockDuration  = mode === "basic" ? 30 : TASK_DURATION;
      const blockThreshold = mode === "basic" ? 10 : THRESHOLD;

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
      log(`No active task found — posting new one… [mode=${mode} duration=${blockDuration}s threshold=${blockThreshold}]`);
      const result = await postTask(manager, descIndex, blockDuration, blockThreshold);
      if (!result) {
        log(`Post failed — retrying in 30s…`);
        await sleep(RETRY_DELAY);
        continue;
      }

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
