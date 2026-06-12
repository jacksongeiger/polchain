/**
 * scripts/lib/addresses.js — Single source of truth for deployed contract addresses.
 *
 * Reads/writes server/addresses.json (schema 2). Both backend scripts and the
 * admin server use this module; the frontend reads the same data via
 * GET /api/addresses.
 *
 * Schema 2 introduces ERAS — contract generations. Each era entry records its
 * TaskManager + Verifier; sealing an era freezes its chain as a browsable
 * archive and a new era mines on a fresh contract. The legacy top-level keys
 * (TaskManagerAdvanced/Basic, Verifier) are kept as mirrors of the CURRENT era
 * so older code paths and the frontend's build-time bundle keep working.
 *
 * Basic/advanced "modes" are retired: Era 1 ran two parallel managers behind a
 * UI toggle that silently redeployed contracts. Era boundaries are explicit
 * operator events now (scripts/startNewEra.js).
 */
const fs = require("fs");
const path = require("path");

const ROOT           = path.resolve(__dirname, "../..");
const ADDRESSES_PATH = path.join(ROOT, "server", "addresses.json");

function readAddresses() {
  return JSON.parse(fs.readFileSync(ADDRESSES_PATH, "utf8"));
}

function writeAddresses(addresses) {
  fs.writeFileSync(ADDRESSES_PATH, JSON.stringify(addresses, null, 2) + "\n");
}

/** The era currently mining: the last unsealed entry (or the last entry). */
function currentEra(addresses = readAddresses()) {
  const eras = addresses.eras || [];
  return eras.find((e) => !e.sealed) || eras[eras.length - 1] || null;
}

/** All eras, oldest first. */
function listEras(addresses = readAddresses()) {
  return addresses.eras || [];
}

/** @deprecated modes are retired — always "advanced". Removed with the last caller. */
function readMode() {
  return "advanced";
}

/** TaskManager address of the current era (legacy mirror as fallback). */
function getActiveTaskManagerAddress() {
  const addresses = readAddresses();
  const era = currentEra(addresses);
  return (era && era.taskManager) || addresses.TaskManagerAdvanced;
}

/** Verifier address of the current era (legacy mirror as fallback). */
function getActiveVerifierAddress() {
  const addresses = readAddresses();
  const era = currentEra(addresses);
  return (era && era.verifier) || addresses.Verifier;
}

/**
 * Seal the current era (records final block counts) and append the next one.
 * Mirrors the new era's addresses into the legacy top-level keys so every
 * legacy consumer follows the cutover automatically. Used by startNewEra.js.
 */
function startEra({ taskManager, verifier, label, extra = {}, sealCounts = {} }) {
  const addresses = readAddresses();
  addresses.eras = addresses.eras || [];
  const prev = currentEra(addresses);
  if (prev && !prev.sealed) {
    prev.sealed   = true;
    prev.sealedAt = new Date().toISOString();
    Object.assign(prev, sealCounts);
  }
  const era = {
    era: (prev ? prev.era : 0) + 1,
    label: label || `Era ${(prev ? prev.era : 0) + 1}`,
    taskManager,
    verifier,
    sealed: false,
    startedAt: new Date().toISOString(),
    ...extra,
  };
  addresses.eras.push(era);
  // Legacy mirrors track the current era.
  addresses.TaskManagerAdvanced = taskManager;
  addresses.TaskManagerBasic    = taskManager;
  addresses.Verifier            = verifier;
  writeAddresses(addresses);
  return era;
}

/** @deprecated Era-1 helper kept for redeployTaskManager.js until startNewEra.js replaces it. */
function setTaskManagerAddress(mode, address) {
  const addresses = readAddresses();
  if (mode === "basic") addresses.TaskManagerBasic = address;
  else                  addresses.TaskManagerAdvanced = address;
  writeAddresses(addresses);
  return addresses;
}

module.exports = {
  ADDRESSES_PATH,
  readAddresses,
  writeAddresses,
  currentEra,
  listEras,
  readMode,
  getActiveTaskManagerAddress,
  getActiveVerifierAddress,
  startEra,
  setTaskManagerAddress,
};
