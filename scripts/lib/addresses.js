/**
 * scripts/lib/addresses.js — Single source of truth for deployed contract addresses.
 *
 * Reads/writes server/addresses.json. Both backend scripts and the admin server
 * use this module so there is exactly one place that holds the live addresses.
 *
 * Frontend reads the same data via GET /api/addresses on the admin server.
 */
const fs = require("fs");
const path = require("path");

const ROOT           = path.resolve(__dirname, "../..");
const ADDRESSES_PATH = path.join(ROOT, "server", "addresses.json");
const MODE_PATH      = path.join(ROOT, "server", "mode.json");

function readAddresses() {
  return JSON.parse(fs.readFileSync(ADDRESSES_PATH, "utf8"));
}

function writeAddresses(addresses) {
  fs.writeFileSync(ADDRESSES_PATH, JSON.stringify(addresses, null, 2) + "\n");
}

function readMode() {
  try {
    if (fs.existsSync(MODE_PATH)) {
      const { mode } = JSON.parse(fs.readFileSync(MODE_PATH, "utf8"));
      return mode === "basic" ? "basic" : "advanced";
    }
  } catch { /* ignore */ }
  return "advanced";
}

/** Returns the TaskManager address for the given mode (defaults to current mode). */
function getActiveTaskManagerAddress(mode = readMode()) {
  const addresses = readAddresses();
  return mode === "basic" ? addresses.TaskManagerBasic : addresses.TaskManagerAdvanced;
}

/** Atomically update the TaskManager address for one mode. */
function setTaskManagerAddress(mode, address) {
  const addresses = readAddresses();
  if (mode === "basic") addresses.TaskManagerBasic = address;
  else                  addresses.TaskManagerAdvanced = address;
  writeAddresses(addresses);
  return addresses;
}

module.exports = {
  ADDRESSES_PATH,
  MODE_PATH,
  readAddresses,
  writeAddresses,
  readMode,
  getActiveTaskManagerAddress,
  setTaskManagerAddress,
};
