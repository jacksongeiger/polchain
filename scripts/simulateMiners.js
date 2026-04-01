/**
 * simulateMiners.js — PoLChain miner race simulator
 *
 * Spins up 4 simulated miners that concurrently hit the local prove-server,
 * then race to submit their ZK-verified gradient proofs to TaskManager.
 *
 * Usage: npm run simulate
 *        (prove-server must be running: npm run prove-server)
 */
require("dotenv").config();
const { ethers } = require("ethers");
const { pathToFileURL } = require("url");
const path = require("path");

const TASK_ID    = 4;
const SERVER_URL = "http://localhost:5001/prove";
const MINERS     = ["Miner Alpha", "Miner Beta", "Miner Gamma", "Miner Delta"];

// Task 2 parameters — posted automatically if the task doesn't exist yet
const TASK_DESCRIPTION = "Train a gradient boosted classifier on synthetic tabular data. Target accuracy > 45%.";
const TASK_THRESHOLD   = 45;   // low enough for all four miners to qualify
const TASK_REWARD      = ethers.parseEther("200");
const TASK_DEADLINE    = () => Math.floor(Date.now() / 1000) + 60 * 60 * 24;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function ts() {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

const COL = {
  reset:  "\x1b[0m",
  dim:    "\x1b[2m",
  bold:   "\x1b[1m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  blue:   "\x1b[34m",
  purple: "\x1b[35m",
  cyan:   "\x1b[36m",
  red:    "\x1b[31m",
  grey:   "\x1b[90m",
};

const MINER_COLORS = [COL.cyan, COL.yellow, COL.green, COL.purple];

function log(minerIndex, msg) {
  const name  = MINERS[minerIndex];
  const color = MINER_COLORS[minerIndex];
  console.log(`${COL.grey}[${ts()}]${COL.reset} ${color}${name.padEnd(12)}${COL.reset}  ${msg}`);
}

function header(title) {
  const bar = "─".repeat(62);
  console.log(`\n${COL.bold}┌${bar}┐${COL.reset}`);
  console.log(`${COL.bold}│  ${title.padEnd(60)}│${COL.reset}`);
  console.log(`${COL.bold}└${bar}┘${COL.reset}\n`);
}

// ---------------------------------------------------------------------------
// Proof parsing — mirrors frontend/src/views/SubmitGradient.jsx
// little-endian 32-byte field elements → big-endian uint256[]
// ---------------------------------------------------------------------------
function parseProofJson(proofJson) {
  if (!proofJson.hex_proof || !Array.isArray(proofJson.instances?.[0])) {
    throw new Error("Unrecognised proof.json format");
  }
  const proofBytes = proofJson.hex_proof;
  const instances  = proofJson.instances[0].map((hexLE) => {
    const bigEndian = hexLE.match(/.{2}/g).reverse().join("");
    return BigInt("0x" + bigEndian);
  });
  return { proofBytes, instances };
}

// ---------------------------------------------------------------------------
// Stream a proof from the prove-server via SSE (POST → ReadableStream)
// ---------------------------------------------------------------------------
async function streamProve(minerIndex) {
  const name = MINERS[minerIndex];

  log(minerIndex, `connecting to prove-server (task=${TASK_ID}, miner_id=${minerIndex})…`);

  let res;
  try {
    res = await fetch(SERVER_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ task_id: TASK_ID, miner_id: minerIndex }),
    });
  } catch (e) {
    throw new Error(`Cannot reach prove-server at ${SERVER_URL} — is it running? (npm run prove-server)`);
  }

  if (!res.ok) throw new Error(`Server returned HTTP ${res.status}`);

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let   buffer  = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep partial last line

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      let ev;
      try { ev = JSON.parse(line.slice(6)); } catch { continue; }

      if (ev.stage === "error") {
        throw new Error(ev.message);
      }

      if (ev.stage === "loading") {
        log(minerIndex, `loading task data…`);

      } else if (ev.stage === "training" && ev.message.startsWith("Training complete")) {
        // "Training complete — loss X → Y  (Δ ±Z)  acc P%"
        const parts = ev.message.split("—")[1]?.trim() ?? ev.message;
        log(minerIndex, `training complete — ${parts}`);

      } else if (ev.stage === "computing" && ev.score !== undefined) {
        log(minerIndex, `${COL.bold}gradient quality score: ${ev.score}/100${COL.reset}`);

      } else if (ev.stage === "proving" && ev.message.includes("Proving")) {
        log(minerIndex, `generating ZK proof…`);

      } else if (ev.stage === "verifying") {
        log(minerIndex, `verifying proof…`);

      } else if (ev.stage === "done") {
        const sizeTag = ev.message.match(/[\d.]+\s*KB/)?.[0] ?? "";
        log(minerIndex, `${COL.green}proof verified ✓${COL.reset}  score=${ev.score}/100  ${COL.grey}${sizeTag}${COL.reset}`);
        return {
          score:        ev.score,
          gradientHash: ev.gradient_hash,
          proofData:    parseProofJson(ev.proof),
        };
      }
    }
  }

  throw new Error("SSE stream ended without a 'done' event");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  // ── Load contracts ────────────────────────────────────────────────────────
  const contractsUrl = pathToFileURL(
    path.resolve(__dirname, "../frontend/src/contracts.js")
  ).href;
  const { ADDRESSES, TASK_MANAGER_ABI, POL_TOKEN_ABI } = await import(contractsUrl);

  const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
  const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const manager  = new ethers.Contract(ADDRESSES.TaskManager, TASK_MANAGER_ABI, wallet);
  const token    = new ethers.Contract(ADDRESSES.POLToken,    POL_TOKEN_ABI,    wallet);

  header(`PoLChain Miner Simulator — Task #${TASK_ID}`);
  console.log(`  TaskManager : ${ADDRESSES.TaskManager}`);
  console.log(`  Wallet      : ${wallet.address}`);
  console.log(`  Miners      : ${MINERS.join(", ")}\n`);

  // ── Ensure task #2 exists ─────────────────────────────────────────────────
  let task;
  try {
    task = await manager.getTask(TASK_ID);
    console.log(`  Task #${TASK_ID}: "${task.description}"`);
    console.log(`  Threshold: ${task.threshold}/100  Reward: ${ethers.formatEther(task.reward)} POL`);
  } catch {
    console.log(`  Task #${TASK_ID} not found — posting it now…`);
    const allowance = await token.allowance(wallet.address, ADDRESSES.TaskManager);
    if (allowance < TASK_REWARD) {
      console.log("  Approving POL spend…");
      const approveTx = await token.approve(ADDRESSES.TaskManager, ethers.MaxUint256);
      await approveTx.wait();
    }
    const postTx = await manager.postTask(
      TASK_DESCRIPTION, TASK_THRESHOLD, TASK_REWARD, TASK_DEADLINE()
    );
    const receipt = await postTx.wait();
    const event = receipt.logs
      .map((l) => { try { return manager.interface.parseLog(l); } catch { return null; } })
      .find((e) => e?.name === "TaskPosted");
    task = await manager.getTask(TASK_ID);
    console.log(`  Task #${TASK_ID} posted (tx: ${postTx.hash.slice(0, 20)}…)`);
    console.log(`  "${task.description}"`);
    console.log(`  Threshold: ${task.threshold}/100  Reward: ${ethers.formatEther(task.reward)} POL`);
  }
  console.log();

  // ── Race: all miners prove concurrently ───────────────────────────────────
  console.log(`  ${COL.bold}Starting race — all miners begin simultaneously${COL.reset}\n`);

  // Tx submissions are serialised through this mutex to avoid nonce conflicts
  // (all miners share one wallet, so only one tx can be in-flight at a time)
  let txMutex = Promise.resolve();

  const results = [];

  async function runMiner(minerIndex) {
    const name = MINERS[minerIndex];

    // 1. Generate proof (concurrent — server queues them internally)
    let proofResult;
    try {
      proofResult = await streamProve(minerIndex);
    } catch (e) {
      log(minerIndex, `${COL.red}proof failed: ${e.message}${COL.reset}`);
      results.push({ name, minerIndex, score: null, txHash: null, success: false, error: e.message });
      return;
    }

    const { score, gradientHash, proofData } = proofResult;

    // 2. Submit transaction (serialised through mutex)
    await new Promise((resolve) => {
      txMutex = txMutex.then(async () => {
        try {
          log(minerIndex, `submitting ZK proof (score=${score})…`);
          const tx = await manager.submitWithProof(
            BigInt(TASK_ID),
            gradientHash,
            score,
            proofData.proofBytes,
            proofData.instances,
          );
          log(minerIndex, `tx sent: ${tx.hash.slice(0, 22)}…`);
          const receipt = await tx.wait();
          log(minerIndex, `${COL.green}confirmed${COL.reset} in block ${receipt.blockNumber}`);
          results.push({ name, minerIndex, score, gradientHash, txHash: tx.hash, success: true });
        } catch (e) {
          const reason = e.reason || e.message;
          log(minerIndex, `${COL.red}tx failed: ${reason}${COL.reset}`);
          results.push({ name, minerIndex, score, txHash: null, success: false, error: reason });
        }
        resolve();
      });
    });
  }

  // Fire all four miners at the same time
  await Promise.all(MINERS.map((_, i) => runMiner(i)));

  // ── Leaderboard ───────────────────────────────────────────────────────────
  header(`Leaderboard — Task #${TASK_ID}`);

  let onChain = [];
  try {
    onChain = await manager.getAllSubmissions(TASK_ID);
  } catch (e) {
    console.log(`  (Could not fetch on-chain submissions: ${e.message})\n`);
  }

  if (onChain.length === 0) {
    console.log("  No on-chain submissions found — all miners may have failed.\n");
  } else {
    // Sort by score desc; ties broken by submission order (index in array = first = wins)
    const ranked = [...onChain]
      .map((s, i) => ({ index: i, score: Number(s.score), zkVerified: s.zkVerified, miner: s.miner }))
      .sort((a, b) => b.score - a.score || a.index - b.index);

    const medals = ["🥇", "🥈", "🥉"];
    const threshold = Number(task.threshold);

    ranked.forEach((s, rank) => {
      // Match submission back to a local miner name by looking up whose txHash landed
      const local  = results.find((r) => r.success && r.score === s.score) ?? null;
      const label  = local ? local.name : `${s.miner.slice(0, 8)}…`;
      const medal  = medals[rank] ?? `  #${rank + 1}`;
      const zkTag  = s.zkVerified ? `${COL.green} [ZK✓]${COL.reset}` : "";
      const beats  = s.score >= threshold
        ? `${COL.green}✓ beats threshold${COL.reset}`
        : `${COL.red}✗ below threshold${COL.reset}`;

      console.log(
        `  ${medal}  ${label.padEnd(14)}` +
        `  score=${COL.bold}${String(s.score).padStart(3)}${COL.reset}/100` +
        `${zkTag}  ${beats}`
      );
    });

    const winner = ranked[0];
    const winnerLocal = results.find((r) => r.success && r.score === winner.score);
    const winnerName  = winnerLocal ? winnerLocal.name : winner.miner.slice(0, 10) + "…";
    console.log(`\n  ${COL.bold}Currently winning: ${winnerName} (${winner.score}/100)${COL.reset}`);

    if (winner.score < threshold) {
      console.log(`  ${COL.yellow}⚠  No submission beats the threshold (${threshold}) — task may go unawarded.${COL.reset}`);
    }
  }

  // ── Summary table (local results) ─────────────────────────────────────────
  console.log(`\n  ${"Name".padEnd(14)}  ${"Score".padEnd(6)}  ${"Tx".padEnd(22)}  Status`);
  console.log("  " + "─".repeat(60));
  for (const r of results.sort((a, b) => (b.score ?? -1) - (a.score ?? -1))) {
    const score  = r.score !== null ? `${r.score}/100` : "n/a  ";
    const txCol  = r.txHash ? COL.grey + r.txHash.slice(0, 20) + "…" + COL.reset : "—";
    const status = r.success ? `${COL.green}submitted${COL.reset}` : `${COL.red}failed${COL.reset}`;
    console.log(`  ${r.name.padEnd(14)}  ${score.padEnd(6)}  ${txCol.padEnd(22)}  ${status}`);
  }
  console.log();
}

main().catch((e) => {
  console.error(`\n${COL.red}Fatal: ${e.message}${COL.reset}`);
  process.exit(1);
});
