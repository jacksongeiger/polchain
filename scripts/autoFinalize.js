/**
 * autoFinalize.js — runs finalizeExpired.js every 60 seconds.
 * Leave this running and tasks are finalized automatically when they expire.
 *
 * Usage: npm run auto-finalize
 */
const { execSync } = require("child_process");
const path = require("path");

const INTERVAL_MS   = 60_000;
const SCRIPT        = path.resolve(__dirname, "finalizeExpired.js");

function run() {
  const ts = new Date().toLocaleTimeString();
  console.log(`\n[${ts}] ── Running finalizeExpired ──────────────────────`);
  try {
    execSync(`node "${SCRIPT}"`, { stdio: "inherit" });
  } catch {
    // finalizeExpired exits non-zero on fatal errors; keep the loop alive
  }
  console.log(`[${ts}] Next check in ${INTERVAL_MS / 1000}s…`);
}

run();
setInterval(run, INTERVAL_MS);
