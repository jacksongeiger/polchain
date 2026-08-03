/**
 * smokeEra.js — PHASE 2 of a safe era cutover: drive ONE real block against the
 * staged contract before anything becomes public.
 *
 * This does not reimplement mining. It spawns the REAL miningLoop.js and
 * autoMiner.js with POLCHAIN_TASKMANAGER pointed at the staged contract, then
 * watches the chain for the event sequence a healthy block must produce:
 *
 *     TaskPosted -> BaseEstablished -> ProvenWorkSubmitted -> TaskFinalized
 *
 * So the thing under test is the production wiring, not a test harness copy.
 * On success it marks the staging file smokeTested, which is what unlocks
 * scripts/promoteEra.js.
 *
 * Requires the prove server on :5001 (npm run prove-server).
 *
 * Usage: node scripts/smokeEra.js [--timeout 900]
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const { ethers } = require("ethers");
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");
const STAGING_PATH = path.join(ROOT, "server", "staging-era.json");
const PROVE_SERVER = "http://localhost:5001";

const argTimeout = (() => {
  const i = process.argv.indexOf("--timeout");
  return i > -1 ? Number(process.argv[i + 1]) : 900;
})();

const C = { g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", d: "\x1b[2m", x: "\x1b[0m" };
const log = (m) => console.log(`${C.d}[smoke]${C.x} ${m}`);

async function main() {
  if (!fs.existsSync(STAGING_PATH)) {
    console.error(`\nNo staged era. Run: node scripts/deployEra.js\n`);
    process.exit(1);
  }
  const staged = JSON.parse(fs.readFileSync(STAGING_PATH, "utf8"));

  // Prove server must be up — establishBase and the miner both depend on it.
  try {
    const info = await (await fetch(`${PROVE_SERVER}/v2/info`)).json();
    if (!info.ok) throw new Error("not ready");
    const digest = ethers.keccak256(ethers.concat(info.vka));
    if (digest !== staged.vkaDigest) {
      console.error(`\nProve server VKA digest ${digest}`);
      console.error(`does not match staged      ${staged.vkaDigest}`);
      console.error(`The prover and the contract disagree — aborting.\n`);
      process.exit(1);
    }
    log(`prove server up, VKA matches staged contract`);
  } catch (e) {
    console.error(`\nProve server unreachable at ${PROVE_SERVER} (${e.message}).`);
    console.error(`Start it: npm run prove-server\n`);
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(
    process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org"
  );
  const contractsUrl = pathToFileURL(path.join(ROOT, "frontend/src/contracts.js")).href;
  const { TASK_MANAGER_ABI_V3 } = await import(contractsUrl);
  const manager = new ethers.Contract(staged.taskManager, TASK_MANAGER_ABI_V3, provider);

  console.log(`\n─── PHASE 2: SMOKE TEST (staged contract, still invisible) ───\n`);
  log(`target ${staged.taskManager}`);
  log(`spawning the real miningLoop + autoMiner with POLCHAIN_TASKMANAGER override`);
  log(`watching for TaskPosted -> BaseEstablished -> ProvenWorkSubmitted -> TaskFinalized`);
  log(`timeout ${argTimeout}s\n`);

  const env = {
    ...process.env,
    POLCHAIN_TASKMANAGER: staged.taskManager,
    POLCHAIN_VERIFIER: staged.verifier,
  };
  const children = [];
  const spawnChild = (name, script) => {
    const c = spawn("node", [path.join(ROOT, "scripts", script)], { env, cwd: ROOT });
    c.stdout.on("data", (d) => process.stdout.write(`${C.d}[${name}]${C.x} ${d}`));
    c.stderr.on("data", (d) => process.stderr.write(`${C.y}[${name}]${C.x} ${d}`));
    children.push(c);
    return c;
  };

  const seen = { TaskPosted: null, BaseEstablished: null, ProvenWorkSubmitted: null, TaskFinalized: null };
  let taskId = null;

  spawnChild("loop", "miningLoop.js");
  spawnChild("miner", "autoMiner.js");

  /**
   * Poll queryFilter over block ranges rather than manager.on().
   * Filter-based subscriptions (eth_newFilter/eth_getFilterChanges) are expired
   * aggressively by public Base Sepolia RPCs — "filter not found" floods the log
   * and events are missed entirely, which reads as a failed block when the chain
   * is actually fine. Polling explicit ranges has no server-side state.
   */
  const deadline = Date.now() + argTimeout * 1000;
  let fromBlock = await provider.getBlockNumber();
  let outcome = "timeout";

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 8_000));
    let toBlock;
    try {
      toBlock = await provider.getBlockNumber();
    } catch { continue; }
    if (toBlock < fromBlock) continue;

    let logs = [];
    try {
      logs = await manager.queryFilter("*", fromBlock, toBlock);
    } catch (e) {
      log(`${C.y}log scan failed (${e.shortMessage || e.message}) — retrying${C.x}`);
      continue;
    }
    fromBlock = toBlock + 1;

    for (const ev of logs) {
      const name = ev.fragment?.name;
      const a = ev.args;
      if (!name) continue;
      if (name === "TaskPosted" && taskId === null) {
        taskId = a.taskId;
        seen.TaskPosted = { taskId: a.taskId.toString(), batchIdx: a.batchIdx?.toString() };
        log(`${C.g}TaskPosted${C.x} #${a.taskId} (batch ${a.batchIdx})`);
      } else if (taskId === null || a.taskId !== taskId) {
        continue;
      } else if (name === "BaseEstablished") {
        seen.BaseEstablished = { baseScore: a.baseScore.toString() };
        log(`${C.g}BaseEstablished${C.x} #${a.taskId} base=${a.baseScore}`);
      } else if (name === "ProvenWorkSubmitted") {
        (seen.ProvenWorkSubmitted ||= []).push({ miner: a.miner });
        log(`${C.g}ProvenWorkSubmitted${C.x} #${a.taskId} by ${a.miner}`);
      } else if (name === "WorkSubmitted") {
        log(`${C.d}WorkSubmitted (claimed)${C.x} #${a.taskId} by ${a.miner}`);
      } else if (name === "RewardPaid") {
        log(`${C.g}RewardPaid${C.x} #${a.taskId} ${a.miner} marginal=${a.marginal} reward=${ethers.formatEther(a.reward)} POL`);
      } else if (name === "TaskFinalized") {
        seen.TaskFinalized = {
          totalMarginal: a.totalMarginal.toString(),
          rewardPaid: ethers.formatEther(a.rewardPaid),
          winners: a.winners.toString(),
        };
        log(`${C.g}TaskFinalized${C.x} #${a.taskId} winners=${a.winners} paid=${ethers.formatEther(a.rewardPaid)} POL`);
      }
    }
    if (seen.TaskFinalized) { outcome = "finalized"; break; }
  }

  children.forEach((c) => { try { c.kill("SIGTERM"); } catch {} });
  try { manager.removeAllListeners(); } catch {}

  // Verdict
  console.log(`\n─── RESULT ───\n`);
  const req = [
    ["TaskPosted", !!seen.TaskPosted],
    ["BaseEstablished", !!seen.BaseEstablished],
    ["ProvenWorkSubmitted", !!(seen.ProvenWorkSubmitted && seen.ProvenWorkSubmitted.length)],
    ["TaskFinalized", !!seen.TaskFinalized],
  ];
  for (const [k, ok] of req) console.log(`  ${ok ? C.g + "PASS" : C.r + "FAIL"}${C.x}  ${k}`);

  const baseOk = seen.BaseEstablished && Number(seen.BaseEstablished.baseScore) > 0;
  if (seen.BaseEstablished && !baseOk) {
    console.log(`\n${C.y}NOTE: baseScore is 0 — the base proof did not land before finalize.${C.x}`);
    console.log(`${C.y}Rewards still pay out, but every score counts as full improvement,${C.x}`);
    console.log(`${C.y}so the "improvement over base" story will not read on camera.${C.x}`);
  }

  const passed = req.every(([, ok]) => ok);
  if (!passed) {
    console.log(`\n${C.r}SMOKE TEST FAILED${C.x} (${outcome}).`);
    console.log(`The staged contract stays staged; addresses.json was never touched.`);
    console.log(`Fix, then: rm ${path.relative(ROOT, STAGING_PATH)} && node scripts/deployEra.js\n`);
    process.exit(1);
  }

  staged.smokeTested = true;
  staged.smokeTestedAt = new Date().toISOString();
  staged.smokeResult = seen;
  fs.writeFileSync(STAGING_PATH, JSON.stringify(staged, null, 2) + "\n");

  console.log(`\n${C.g}SMOKE TEST PASSED${C.x} — one full block ran on the staged contract.`);
  console.log(`Marked smokeTested in ${path.relative(ROOT, STAGING_PATH)}.`);
  console.log(`\nNext:  node scripts/promoteEra.js\n`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
