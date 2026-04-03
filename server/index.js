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
const { spawn } = require("child_process");
const http  = require("http");
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
  if (!isAlive(flaskProc)) {
    return res.json({ ok: false, message: "Prove server not running" });
  }
  syslog("Stopping Flask prove server…");
  flaskProc.kill("SIGTERM");
  flaskProc = null;
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

// POST /api/actions/reset-model
app.post("/api/actions/reset-model", async (req, res) => {
  const fs = require("fs");
  const modelPath = path.join(ROOT, "zk", "global_model.pth");
  const logPath   = path.join(ROOT, "zk", "accuracy_log.json");
  const deleted   = [];

  for (const [p, label] of [[modelPath, "global_model.pth"], [logPath, "accuracy_log.json"]]) {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      deleted.push(label);
      syslog(`Deleted ${label}`);
    }
  }

  const message = deleted.length
    ? `Reset model: deleted ${deleted.join(", ")}`
    : "Reset model: nothing to delete (already clean)";
  syslog(message);
  res.json({ ok: true, message });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  syslog(`Admin server listening on http://localhost:${PORT}`);
});
