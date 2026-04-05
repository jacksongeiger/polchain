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

const app  = express();
const PORT = 3001;
const ROOT = path.resolve(__dirname, "..");

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
  flaskProc = spawn("python3", [path.join(ROOT, "zk", "server", "server.py")], {
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
    // Lazy-load contracts so server starts even if contracts.js is missing
    const contractsPath = path.join(ROOT, "frontend", "src", "contracts.js");
    const { ADDRESSES, TASK_MANAGER_ABI } = await import(
      new URL(`file://${contractsPath}`).href
    );

    const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
    const manager  = new ethers.Contract(ADDRESSES.TaskManager, TASK_MANAGER_ABI, provider);

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

// POST /api/actions/reset-model
app.post("/api/actions/reset-model", async (req, res) => {
  const modelPath = path.join(ROOT, "zk", "global_model.pth");
  const logPath   = path.join(ROOT, "zk", "accuracy_log.json");

  // Delete the model weights so training restarts from random init
  if (fs.existsSync(modelPath)) {
    fs.unlinkSync(modelPath);
    syslog("Deleted global_model.pth");
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
  syslog(`Appended reset marker to accuracy_log.json  (${entryCountBefore} data entries before reset)`);

  const message = `Reset model: weights cleared, reset marker appended to log (${entryCountBefore} prior entries)`;
  syslog(message);
  res.json({ ok: true, message });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  syslog(`Admin server listening on http://localhost:${PORT}`);
});
