/**
 * promoteEra.js — PHASE 3 of a safe era cutover: make the staged era live.
 *
 * Reads server/staging-era.json (written by scripts/deployEra.js), re-verifies
 * the staged contract against the chain, backs up server/addresses.json, then
 * calls startEra() — sealing the previous era into the archive and appending the
 * new one. This is the ONLY step that is publicly visible, and it is a single
 * file write, so it is also the only step that can be undone.
 *
 *   node scripts/promoteEra.js              promote the staged era
 *   node scripts/promoteEra.js --rollback   restore the most recent backup
 *   node scripts/promoteEra.js --skip-smoke promote without a smoke test (loud)
 *
 * After promoting, rebuild the frontend so its build-time address snapshot
 * matches, and clear localStorage on the demo machine (stale cached address).
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const { ethers } = require("ethers");
const path = require("path");
const fs = require("fs");

const { ADDRESSES_PATH, readAddresses, currentEra, startEra } = require("./lib/addresses");

const ROOT = path.resolve(__dirname, "..");
const STAGING_PATH = path.join(ROOT, "server", "staging-era.json");
const BACKUP_DIR = path.join(ROOT, "server", "addresses-backups");

function backups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".json")).sort();
}

function rollback() {
  const all = backups();
  if (!all.length) {
    console.error(`No backups in ${path.relative(ROOT, BACKUP_DIR)} — nothing to roll back to.`);
    process.exit(1);
  }
  const latest = all[all.length - 1];
  const before = currentEra();
  fs.copyFileSync(path.join(BACKUP_DIR, latest), ADDRESSES_PATH);
  const after = currentEra();
  console.log(`\nRolled back addresses.json from ${latest}`);
  console.log(`  was:  Era ${before?.era} @ ${before?.taskManager}`);
  console.log(`  now:  Era ${after?.era} @ ${after?.taskManager}`);
  console.log(`\nRestart the mining stack and rebuild the frontend.\n`);
}

async function main() {
  if (process.argv.includes("--rollback")) return rollback();

  if (!fs.existsSync(STAGING_PATH)) {
    console.error(`\nNo staged era at ${path.relative(ROOT, STAGING_PATH)}.`);
    console.error(`Run: node scripts/deployEra.js\n`);
    process.exit(1);
  }
  const staged = JSON.parse(fs.readFileSync(STAGING_PATH, "utf8"));

  if (!staged.smokeTested && !process.argv.includes("--skip-smoke")) {
    console.error(`\nRefusing to promote: this era has not been smoke-tested.`);
    console.error(`Run: node scripts/smokeEra.js`);
    console.error(`(or re-run with --skip-smoke to promote anyway)\n`);
    process.exit(1);
  }
  if (!staged.smokeTested) {
    console.warn(`\n\x1b[33mWARNING: promoting an era that was never smoke-tested.\x1b[0m\n`);
  }

  // Re-verify the staged contract against the chain before making it public.
  const provider = new ethers.JsonRpcProvider(
    process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org"
  );
  const mgr = new ethers.Contract(staged.taskManager, [
    "function isSealed() view returns (bool)",
    "function numBatches() view returns (uint256)",
    "function vkaDigest() view returns (bytes32)",
    "function batchDataDigest() view returns (bytes32)",
  ], provider);

  console.log(`\n─── PHASE 3: PROMOTE ───\n`);
  console.log(`Staged taskManager: ${staged.taskManager}`);
  console.log(`Staged at:          ${staged.stagedAt}`);
  console.log(`Smoke tested:       ${staged.smokeTested}\n`);

  const refuse = (why) => {
    console.error(`\nRefusing to promote — ${why}. addresses.json was NOT changed.\n`);
    process.exit(1);
  };

  // Bail on a dead address before attempting any contract call, so a wrong or
  // stale staging file reports plainly instead of throwing a decode error.
  const code = await provider.getCode(staged.taskManager);
  console.log(`  ${"contract exists".padEnd(18)} ${code !== "0x" ? "OK" : "FAIL"}`);
  if (code === "0x") refuse(`no contract at ${staged.taskManager} on chain ${(await provider.getNetwork()).chainId}`);

  let checks;
  try {
    checks = {
      "isSealed":        await mgr.isSealed(),
      "numBatches":      Number(await mgr.numBatches()) === staged.numBatches,
      "vkaDigest":       (await mgr.vkaDigest()) === staged.vkaDigest,
      "batchDataDigest": (await mgr.batchDataDigest()) === staged.batchDataDigest,
    };
  } catch (e) {
    refuse(`staged address is not a TaskManagerV3 (${e.shortMessage || e.message})`);
  }
  for (const [k, v] of Object.entries(checks)) console.log(`  ${k.padEnd(18)} ${v ? "OK" : "FAIL"}`);
  if (!Object.values(checks).every(Boolean)) refuse(`staged contract failed verification`);

  // Back up addresses.json before the only destructive write in this flow.
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(BACKUP_DIR, `addresses-${stamp}.json`);
  fs.copyFileSync(ADDRESSES_PATH, backupPath);
  console.log(`\nBacked up addresses.json -> ${path.relative(ROOT, backupPath)}`);

  // Final on-chain block count for the era being sealed.
  const prev = currentEra();
  const sealCounts = {};
  if (prev?.taskManager) {
    try {
      const old = new ethers.Contract(prev.taskManager,
        ["function totalTasks() view returns (uint256)"], provider);
      sealCounts.blocksPosted = Number(await old.totalTasks());
    } catch { /* keep recorded counts */ }
  }

  const era = startEra({
    taskManager: staged.taskManager,
    verifier: staged.verifier,
    label: `Era ${(prev?.era || 1) + 1} — proof of improvement`,
    extra: {
      vkaDigest: staged.vkaDigest,
      batchDataDigest: staged.batchDataDigest,
      numBatches: staged.numBatches,
      n: staged.n,
      sealTx: staged.sealTx,
    },
    sealCounts,
  });

  fs.renameSync(STAGING_PATH, STAGING_PATH.replace(/\.json$/, `-promoted-${stamp}.json`));

  console.log(`\nEra ${era.era} IS LIVE.`);
  console.log(`Era ${prev?.era} sealed as an archive${sealCounts.blocksPosted != null ? ` (${sealCounts.blocksPosted} blocks)` : ""}.`);
  console.log(`BaseScan: https://sepolia.basescan.org/address/${staged.taskManager}`);
  console.log(`\nNow:`);
  console.log(`  npm run frontend:build      # refresh the bundled address snapshot`);
  console.log(`  clear localStorage on the demo machine`);
  console.log(`  npm run mining              # + npm run prove-server`);
  console.log(`\nUndo:  node scripts/promoteEra.js --rollback\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
