/**
 * server/index.js — PoLChain Admin Server
 *
 * Express server that provides:
 *   - Process management for miningLoop.js and autoMiner.js
 *   - SSE log streaming to the Admin panel
 *   - Quick-action endpoints (post task, finalize, redeploy)
 *   - Status endpoint for all services
 *
 * Run standalone: npm run server
 * Run with mining: npm run mining (starts all three concurrently)
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const express = require("express");
const { spawn, execSync } = require("child_process");
const { ethers } = require("ethers");
const http  = require("http");
const fs    = require("fs");
const path  = require("path");

const {
  ADDRESSES_PATH,
  readAddresses,
  getActiveTaskManagerAddress,
} = require("../scripts/lib/addresses");

const app  = express();
const PORT = 3001;
const ROOT = path.resolve(__dirname, "..");

// Python interpreter for the ZK prove server — prefer the project venv
// (created via zk/requirements.txt) and fall back to system python3.
const VENV_PYTHON = path.join(ROOT, ".venv", "bin", "python");
const PYTHON = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3";

// ---------------------------------------------------------------------------
// CORS — allow Vite dev server (5173) and any local origin
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.sendStatus(200); return; }
  next();
});
app.use(express.json());

// ---------------------------------------------------------------------------
// Log broadcast system — circular buffer + SSE fan-out
// ---------------------------------------------------------------------------
const LOG_MAX    = 200;   // lines kept in memory
const logBuffer  = [];    // string[]
const sseClients = new Set(); // Set<Response>

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function broadcast(raw) {
  const line = stripAnsi(raw).trimEnd();
  if (!line) return;
  logBuffer.push(line);
  if (logBuffer.length > LOG_MAX) logBuffer.shift();
  const payload = `data: ${JSON.stringify({ line })}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
}

function syslog(msg) {
  broadcast(`[server] ${msg}`);
  console.log(`[server] ${msg}`);
}

// ---------------------------------------------------------------------------
// Child process management
// ---------------------------------------------------------------------------
let loopProc  = null; // miningLoop.js
let minerProc = null; // autoMiner.js
let flaskProc = null; // zk/server/server.py

function isAlive(proc) {
  return proc !== null && proc.exitCode === null && !proc.killed;
}

function spawnManaged(script, label) {
  const proc = spawn("node", [path.join(ROOT, "scripts", script)], {
    cwd: ROOT,
    env: process.env,
  });

  proc.stdout.on("data", (data) => {
    data.toString().split("\n").forEach((l) => { if (l.trim()) broadcast(`[${label}] ${l}`); });
  });
  proc.stderr.on("data", (data) => {
    data.toString().split("\n").forEach((l) => { if (l.trim()) broadcast(`[${label}:err] ${l}`); });
  });
  proc.on("exit", (code, sig) => {
    broadcast(`[${label}] exited  code=${code ?? "—"}  signal=${sig ?? "—"}`);
  });

  return proc;
}

// Run a one-shot script and stream output to log, resolve when done.
function runScript(script, label) {
  return new Promise((resolve) => {
    syslog(`Running ${script}…`);
    const proc = spawn("node", [path.join(ROOT, "scripts", script)], {
      cwd: ROOT,
      env: process.env,
    });
    proc.stdout.on("data", (d) =>
      d.toString().split("\n").forEach((l) => { if (l.trim()) broadcast(`[${label}] ${l}`); })
    );
    proc.stderr.on("data", (d) =>
      d.toString().split("\n").forEach((l) => { if (l.trim()) broadcast(`[${label}:err] ${l}`); })
    );
    proc.on("exit", (code) => {
      broadcast(`[${label}] finished  exit=${code}`);
      resolve(code === 0);
    });
  });
}

// ---------------------------------------------------------------------------
// Flask / prove-server health check (port 5001)
// ---------------------------------------------------------------------------
function checkFlask() {
  return new Promise((resolve) => {
    const req = http.get({ host: "localhost", port: 5001, path: "/", timeout: 1500 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error",   () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /api/addresses — single source of truth for contract addresses
app.get("/api/addresses", (req, res) => {
  try {
    const addresses = readAddresses();
    res.json(addresses);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/status
app.get("/api/status", async (req, res) => {
  const flask = await checkFlask();
  res.json({
    loop:       isAlive(loopProc),
    miner:      isAlive(minerProc),
    flask,
    flaskProc:  isAlive(flaskProc),
    server:     true,
  });
});

// POST /api/prove-server/start
app.post("/api/prove-server/start", (req, res) => {
  if (isAlive(flaskProc)) {
    return res.json({ ok: false, message: "Prove server already running" });
  }
  syslog("Starting Flask prove server (zk/server/server.py)…");
  flaskProc = spawn(PYTHON, [path.join(ROOT, "zk", "server", "server.py")], {
    cwd: ROOT,
    env: process.env,
  });
  flaskProc.stdout.on("data", (data) => {
    data.toString().split("\n").forEach((l) => { if (l.trim()) broadcast(`[flask] ${l}`); });
  });
  flaskProc.stderr.on("data", (data) => {
    data.toString().split("\n").forEach((l) => { if (l.trim()) broadcast(`[flask] ${l}`); });
  });
  flaskProc.on("exit", (code, sig) => {
    broadcast(`[flask] exited  code=${code ?? "—"}  signal=${sig ?? "—"}`);
    flaskProc = null;
  });
  res.json({ ok: true });
});

// POST /api/prove-server/stop
app.post("/api/prove-server/stop", (req, res) => {
  let killed = false;

  // Kill the managed child process if we spawned it
  if (isAlive(flaskProc)) {
    syslog("Stopping Flask prove server (managed process)…");
    flaskProc.kill("SIGTERM");
    // Don't null out here — let the exit handler do it so isAlive() stays
    // accurate until the OS confirms the process is gone.
    killed = true;
  }

  // Also kill any externally-started process bound to port 5001 (e.g. started
  // via `npm run prove-server` or `python3 zk/server/server.py` directly).
  try {
    const pids = execSync("lsof -ti :5001", { timeout: 2000 }).toString().trim();
    if (pids) {
      for (const pid of pids.split("\n").filter(Boolean)) {
        syslog(`Killing external Flask process PID ${pid}…`);
        try { execSync(`kill -TERM ${pid}`, { timeout: 2000 }); } catch { /* already gone */ }
        killed = true;
      }
    }
  } catch { /* lsof found nothing on port 5001 */ }

  if (!killed) {
    return res.json({ ok: false, message: "Prove server not running" });
  }
  res.json({ ok: true });
});

// POST /api/mining/start
app.post("/api/mining/start", (req, res) => {
  if (isAlive(loopProc) || isAlive(minerProc)) {
    return res.json({ ok: false, message: "Already running" });
  }
  syslog("Starting miningLoop.js and autoMiner.js…");
  loopProc  = spawnManaged("miningLoop.js", "loop");
  minerProc = spawnManaged("autoMiner.js",  "miner");
  res.json({ ok: true });
});

// POST /api/mining/stop
app.post("/api/mining/stop", (req, res) => {
  syslog("Stopping mining processes…");
  if (isAlive(loopProc))  { loopProc.kill("SIGTERM");  loopProc  = null; }
  if (isAlive(minerProc)) { minerProc.kill("SIGTERM"); minerProc = null; }
  res.json({ ok: true });
});

// GET /api/logs  (SSE)
app.get("/api/logs", (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();

  // Replay buffer to new client
  for (const line of logBuffer) {
    res.write(`data: ${JSON.stringify({ line })}\n\n`);
  }

  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// POST /api/actions/post-task
app.post("/api/actions/post-task", async (req, res) => {
  const ok = await runScript("postTask.js", "action");
  res.json({ ok });
});

// POST /api/actions/finalize
app.post("/api/actions/finalize", async (req, res) => {
  const ok = await runScript("finalizeExpired.js", "action");
  res.json({ ok });
});

// POST /api/actions/redeploy
app.post("/api/actions/redeploy", async (req, res) => {
  const ok = await runScript("redeployTaskManager.js", "action");
  res.json({ ok });
});

// GET /api/proof/:taskId
app.get("/api/proof/:taskId", async (req, res) => {
  const taskId = Number(req.params.taskId);
  if (!Number.isInteger(taskId) || taskId < 1) {
    return res.status(400).json({ ok: false, error: "Invalid taskId" });
  }

  try {
    // ABIs come from contracts.js, addresses come from addresses.json (single source of truth)
    const contractsPath = path.join(ROOT, "frontend", "src", "contracts.js");
    const { TASK_MANAGER_ABI } = await import(new URL(`file://${contractsPath}`).href);

    const provider       = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
    const taskManagerAddr = getActiveTaskManagerAddress();
    const manager         = new ethers.Contract(taskManagerAddr, TASK_MANAGER_ABI, provider);

    const subs = await manager.getAllSubmissions(BigInt(taskId)).catch(() => []);
    if (subs.length === 0) {
      return res.json({ ok: true, taskId, winner: null, proof: null });
    }

    // Winning submission = highest score (matches on-chain finalize logic)
    const winner = subs.reduce((best, s) =>
      Number(s.score) > Number(best.score) ? s : best
    );

    const winnerInfo = {
      miner:        winner.miner,
      score:        Number(winner.score),
      gradientHash: winner.gradientHash,
      zkVerified:   winner.zkVerified,
    };

    // Read weight-chain proof written by prove_step.py (background process).
    // Check shards 0–3 and use the first file that exists.
    const tsProofsDir = path.join(ROOT, "zk", "training_step", "proofs");
    let weightChain = null;
    for (let shardId = 0; shardId <= 3; shardId++) {
      const wcFile = path.join(tsProofsDir, `task_${taskId}_shard_${shardId}.json`);
      if (fs.existsSync(wcFile)) {
        try {
          const wc = JSON.parse(fs.readFileSync(wcFile, "utf8"));
          weightChain = {
            input_weight_hash:  wc.input_weight_hash  ?? null,
            output_weight_hash: wc.output_weight_hash ?? null,
            loss:               wc.loss               ?? null,
            step_score:         wc.score              ?? null,
          };
        } catch { /* corrupt file — leave weightChain null */ }
        break;
      }
    }

    // Read proof file written by autoMiner after submitWithProof
    const proofFile = path.join(ROOT, "zk", "proofs", `task_${taskId}.json`);
    let proofPayload = null;
    if (fs.existsSync(proofFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(proofFile, "utf8"));
        proofPayload = {
          hex_proof:  raw.hex_proof ? raw.hex_proof.slice(0, 80) + "…" : null,
          instances:  raw.instances ?? null,
        };
        // Attach training metadata if present
        return res.json({
          ok:               true,
          taskId,
          winner:           winnerInfo,
          proof:            proofPayload,
          digits_targeted:  raw.digits_targeted  ?? null,
          augmentation:     raw.augmentation     ?? null,
          weight_chain:     weightChain,
        });
      } catch { /* fall through to proof:null */ }
    }

    res.json({ ok: true, taskId, winner: winnerInfo, proof: null, weight_chain: weightChain });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/simulate-attack  — fire a real fake-proof tx to show on-chain rejection
app.post("/api/simulate-attack", async (req, res) => {
  if (!process.env.PRIVATE_KEY) {
    return res.status(500).json({ ok: false, error: "PRIVATE_KEY not set in .env" });
  }
  try {
    const contractsPath = path.join(ROOT, "frontend", "src", "contracts.js");
    const { TASK_MANAGER_ABI } = await import(new URL(`file://${contractsPath}`).href);

    const provider        = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
    const wallet          = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const taskManagerAddr = getActiveTaskManagerAddress();
    const manager         = new ethers.Contract(taskManagerAddr, TASK_MANAGER_ABI, wallet);

    const total = await manager.totalTasks();
    if (Number(total) === 0) {
      return res.json({ ok: false, error: "No active task" });
    }

    const task = await manager.getTask(total);
    if (task.finalized || Number(task.deadline) * 1000 < Date.now()) {
      return res.json({ ok: false, error: "No active task" });
    }

    const taskId    = task.id;
    const fakeHash  = ethers.ZeroHash;          // bytes32(0)
    const fakeProof = "0x" + "00".repeat(100);  // 100 zero bytes
    const fakeInst  = [0n];                     // uint256[] instances

    syslog(`[attack] Submitting fake proof for task #${taskId}…`);

    let txHash = null;
    try {
      const tx = await manager.submitWithProof(
        taskId, fakeHash, 99n, fakeProof, fakeInst,
        { gasLimit: 300_000n },
      );
      txHash = tx.hash;
      syslog(`[attack] tx broadcast: ${txHash}`);
      await tx.wait();
      // Reaching here means the tx did not revert — unexpected
      return res.json({ ok: false, error: "Unexpected: transaction did not revert", txHash });
    } catch (e) {
      // Expected path — extract the revert reason
      const reason =
        e.reason ||
        (e.message?.includes("invalid ZK proof") ? "TaskManager: invalid ZK proof" : null) ||
        e.shortMessage ||
        e.message ||
        "Transaction reverted";
      syslog(`[attack] reverted as expected — ${reason}`);
      return res.json({ ok: false, revertReason: reason, txHash });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/launch  — full startup sequence with SSE progress stream
app.post("/api/launch", async (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();

  let aborted = false;
  req.on("close", () => { aborted = true; });

  function send(msg) {
    if (aborted) return;
    broadcast(`[launch] ${msg}`);
    res.write(`data: ${JSON.stringify({ line: msg })}\n\n`);
  }

  // Health-check Flask via /health (more specific than the status-poll /)
  function checkFlaskHealth() {
    return new Promise((resolve) => {
      const r = http.get({ host: "localhost", port: 5001, path: "/health", timeout: 1500 }, (resp) => {
        resp.resume();
        resolve(resp.statusCode < 500);
      });
      r.on("error",   () => resolve(false));
      r.on("timeout", () => { r.destroy(); resolve(false); });
    });
  }

  try {
    // ── Step 1: Prove server ─────────────────────────────────────────────────
    if (await checkFlaskHealth()) {
      send("Prove server already running ✓");
    } else {
      send("Starting prove server...");
      if (!isAlive(flaskProc)) {
        flaskProc = spawn(PYTHON, [path.join(ROOT, "zk", "server", "server.py")], {
          cwd: ROOT, env: process.env,
        });
        flaskProc.stdout.on("data", (data) => {
          data.toString().split("\n").forEach((l) => { if (l.trim()) broadcast(`[flask] ${l}`); });
        });
        flaskProc.stderr.on("data", (data) => {
          data.toString().split("\n").forEach((l) => { if (l.trim()) broadcast(`[flask] ${l}`); });
        });
        flaskProc.on("exit", (code, sig) => {
          broadcast(`[flask] exited  code=${code ?? "—"}  signal=${sig ?? "—"}`);
          flaskProc = null;
        });
      }
      let ready = false;
      for (let i = 0; i < 15 && !aborted; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        if (await checkFlaskHealth()) { ready = true; break; }
      }
      if (!ready) { send("Prove server failed to start ✗"); res.end(); return; }
      send("Prove server ready ✓");
    }

    if (aborted) { res.end(); return; }

    // ── Step 2: Contract liveness ────────────────────────────────────────────
    send("Checking contract...");
    try {
      const contractsPath = path.join(ROOT, "frontend", "src", "contracts.js");
      const { TASK_MANAGER_ABI, POL_TOKEN_ABI } = await import(new URL(`file://${contractsPath}`).href);
      const addresses       = readAddresses();
      const taskManagerAddr = getActiveTaskManagerAddress();
      const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
      const wallet   = process.env.PRIVATE_KEY
        ? new ethers.Wallet(process.env.PRIVATE_KEY, provider)
        : null;
      const manager  = new ethers.Contract(taskManagerAddr, TASK_MANAGER_ABI, wallet || provider);
      const total    = Number(await manager.totalTasks());
      send("Contract live ✓");

      // ── Step 2b: Post an initial task if chain is empty ─────────────────────
      if (total === 0 && wallet) {
        send("Chain is empty — posting initial task...");
        try {
          const token      = new ethers.Contract(addresses.POLToken, POL_TOKEN_ABI, wallet);
          const REWARD     = ethers.parseEther("100");
          const allowance  = await token.allowance(wallet.address, taskManagerAddr);
          if (allowance < REWARD) {
            send("Approving POL spend...");
            const approveTx = await token.approve(taskManagerAddr, ethers.MaxUint256);
            await approveTx.wait();
          }
          const deadline = Math.floor(Date.now() / 1000) + 60; // 60s block
          const initDesc = "Train a sentiment classifier on SST-2 dataset. Target accuracy > 82%.";
          const tx       = await manager.postTask(initDesc, 20, REWARD, BigInt(deadline),
            { gasPrice: ethers.parseUnits("0.1", "gwei"), gasLimit: 300_000n });
          await tx.wait();
          send("Initial task posted ✓");
        } catch (pe) {
          send(`Initial task post failed (non-fatal): ${pe.reason || pe.message}`);
        }
      }
    } catch (e) {
      const isCallEx = e.code === "CALL_EXCEPTION"
        || e.message?.includes("CALL_EXCEPTION")
        || e.message?.includes("could not decode result data");
      if (isCallEx) {
        send("Contract dead — redeploying...");
        const ok = await runScript("redeployTaskManager.js", "action");
        if (!ok) { send("Contract redeploy failed ✗"); res.end(); return; }
        send("Contract redeployed ✓");
      } else {
        send(`Contract check failed: ${e.message} ✗`);
        res.end(); return;
      }
    }

    if (aborted) { res.end(); return; }

    // ── Step 3: Mining processes ─────────────────────────────────────────────
    if (isAlive(loopProc) && isAlive(minerProc)) {
      send("Mining already running ✓");
    } else {
      send("Starting mining...");
      if (!isAlive(loopProc))  loopProc  = spawnManaged("miningLoop.js", "loop");
      if (!isAlive(minerProc)) minerProc = spawnManaged("autoMiner.js",  "miner");
      send("Mining started ✓");
    }

    send("PoLChain is live 🟢");
  } catch (e) {
    send(`Launch failed: ${e.message} ✗`);
  }

  res.end();
});

// POST /api/actions/reset-model
app.post("/api/actions/reset-model", async (req, res) => {
  // Read current mode — only reset files for the active mode
  let mode = "advanced";
  const modePath = path.join(ROOT, "server", "mode.json");
  try {
    if (fs.existsSync(modePath)) {
      const parsed = JSON.parse(fs.readFileSync(modePath, "utf8"));
      mode = parsed.mode === "basic" ? "basic" : "advanced";
    }
  } catch { /* default to advanced */ }

  const modelFile = mode === "basic" ? "global_model_basic.pth" : "global_model.pth";
  const logFile   = mode === "basic" ? "accuracy_log_basic.json" : "accuracy_log.json";
  const modelPath = path.join(ROOT, "zk", modelFile);
  const logPath   = path.join(ROOT, "zk", logFile);

  // Delete the model weights so training restarts from random init
  if (fs.existsSync(modelPath)) {
    fs.unlinkSync(modelPath);
    syslog(`Deleted ${modelFile}`);
  }

  // Append a reset marker to the accuracy log rather than deleting it,
  // so the full history accumulates and resets are visible in the graph.
  let log = [];
  if (fs.existsSync(logPath)) {
    try { log = JSON.parse(fs.readFileSync(logPath, "utf8")); } catch { log = []; }
  }
  const entryCountBefore = log.filter((e) => !e.reset).length;
  log.push({
    reset:               true,
    timestamp:           Math.floor(Date.now() / 1000),
    entry_count_before:  entryCountBefore,
  });
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
  syslog(`Appended reset marker to ${logFile}  (${entryCountBefore} data entries before reset)`);

  const message = `Reset ${mode} model: deleted ${modelFile} and appended reset marker to ${logFile} (${entryCountBefore} prior entries)`;
  syslog(message);
  res.json({ ok: true, message });
});

// GET /api/mode
app.get("/api/mode", (req, res) => {
  const modePath = path.join(ROOT, "server", "mode.json");
  try {
    if (fs.existsSync(modePath)) {
      const { mode } = JSON.parse(fs.readFileSync(modePath, "utf8"));
      return res.json({ mode: mode === "basic" ? "basic" : "advanced" });
    }
  } catch { /* fall through */ }
  res.json({ mode: "advanced" });
});

// POST /api/mode — streams progress as SSE when mode actually changes
app.post("/api/mode", async (req, res) => {
  const { mode } = req.body;
  if (mode !== "basic" && mode !== "advanced") {
    return res.status(400).json({ ok: false, error: "mode must be 'basic' or 'advanced'" });
  }

  const modePath = path.join(ROOT, "server", "mode.json");

  // Read current mode
  let currentMode = "advanced";
  try {
    if (fs.existsSync(modePath)) {
      const parsed = JSON.parse(fs.readFileSync(modePath, "utf8"));
      currentMode = parsed.mode === "basic" ? "basic" : "advanced";
    }
  } catch { /* default to advanced */ }

  if (currentMode === mode) {
    return res.json({ ok: true, message: "already in this mode" });
  }

  // Stream progress
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();

  function send(step, message) {
    broadcast(`[mode] ${message}`);
    res.write(`data: ${JSON.stringify({ step, message })}\n\n`);
  }

  try {
    const wasMining = isAlive(loopProc) || isAlive(minerProc);

    // Persist new mode immediately so child processes read it on next iteration
    fs.writeFileSync(modePath, JSON.stringify({ mode }, null, 2));
    syslog(`Mode switching: ${currentMode} → ${mode}`);

    if (wasMining) {
      send("stopping_mining", "Stopping mining...");
      if (isAlive(loopProc))  { loopProc.kill("SIGTERM");  loopProc  = null; }
      if (isAlive(minerProc)) { minerProc.kill("SIGTERM"); minerProc = null; }
      // Brief pause so the OS cleans up the processes before we redeploy
      await new Promise((r) => setTimeout(r, 1200));
    }

    send("redeploying", "Redeploying contract...");
    const ok = await runScript("redeployTaskManager.js", "action");
    if (!ok) {
      send("error", "Redeploy failed ✗");
      res.end();
      return;
    }

    if (wasMining) {
      send("starting_mining", "Starting mining...");
      loopProc  = spawnManaged("miningLoop.js", "loop");
      minerProc = spawnManaged("autoMiner.js",  "miner");
    }

    syslog(`Mode set to: ${mode}`);
    send("done", `Switched to ${mode} mode ✓`);
  } catch (e) {
    send("error", `Mode switch failed: ${e.message} ✗`);
  }

  res.end();
});

// GET /api/accuracy?mode=basic|advanced  — proxy to Flask /accuracy?mode=
app.get("/api/accuracy", (req, res) => {
  const mode = req.query.mode === "basic" ? "basic" : "advanced";
  const flaskReq = http.get(
    { host: "localhost", port: 5001, path: `/accuracy?mode=${mode}`, timeout: 8000 },
    (flaskRes) => {
      let body = "";
      flaskRes.on("data", (chunk) => { body += chunk; });
      flaskRes.on("end", () => {
        try {
          res.json(JSON.parse(body));
        } catch {
          res.status(502).json({ ok: false, error: "Invalid JSON from Flask" });
        }
      });
    },
  );
  flaskReq.on("error", (e) => res.status(502).json({ ok: false, error: e.message }));
  flaskReq.on("timeout", () => { flaskReq.destroy(); res.status(504).json({ ok: false, error: "Flask timeout" }); });
});

// GET /api/miner-stats
app.get("/api/miner-stats", (req, res) => {
  const statsPath = path.join(ROOT, "server", "miner-stats.json");
  const zero = { wins: 0, submissions: 0, totalScore: 0, bestScore: 0, lastScores: [] };
  if (fs.existsSync(statsPath)) {
    try {
      return res.json(JSON.parse(fs.readFileSync(statsPath, "utf8")));
    } catch { /* fall through */ }
  }
  res.json({ 0: { ...zero }, 1: { ...zero }, 2: { ...zero }, 3: { ...zero } });
});

// POST /api/miner-stats/reset
app.post("/api/miner-stats/reset", (req, res) => {
  const statsPath = path.join(ROOT, "server", "miner-stats.json");
  try {
    if (fs.existsSync(statsPath)) fs.unlinkSync(statsPath);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  syslog(`Admin server listening on http://localhost:${PORT}`);
});
