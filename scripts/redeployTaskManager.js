/**
 * redeployTaskManager.js — Deploy a fresh TaskManager, keep POLToken + Verifier.
 *
 * Reads/writes server/addresses.json (the single source of truth) and reads
 * server/mode.json so the new address lands in the correct mode-specific field
 * (TaskManagerBasic or TaskManagerAdvanced).
 *
 * Run once before starting the mining loop on a clean chain:
 *   node scripts/redeployTaskManager.js
 *
 * This script:
 *   1. Deploys a new TaskManager pointing at the existing POLToken
 *   2. Grants it unlimited POL allowance from the deployer wallet
 *   3. Calls setVerifier() to re-register the existing Halo2Verifier
 *   4. Writes the new TaskManager address to server/addresses.json
 */
require("dotenv").config();
const { ethers } = require("ethers");
const { pathToFileURL } = require("url");
const path = require("path");
const fs   = require("fs");

const {
  readAddresses,
  readMode,
  setTaskManagerAddress,
} = require("./lib/addresses");

async function main() {
  // ABIs come from contracts.js (frontend ESM module). Addresses come from addresses.json.
  const contractsUrl = pathToFileURL(
    path.resolve(__dirname, "../frontend/src/contracts.js")
  ).href;
  const { TASK_MANAGER_ABI } = await import(contractsUrl);

  const addresses = readAddresses();
  const mode      = readMode();
  const field     = mode === "basic" ? "TaskManagerBasic" : "TaskManagerAdvanced";

  const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
  const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const balance  = await provider.getBalance(wallet.address);

  console.log("Deployer:    ", wallet.address);
  console.log("Balance:     ", ethers.formatEther(balance), "ETH");
  console.log("Mode:        ", mode, ` (writing to ${field})`);
  console.log("POLToken:    ", addresses.POLToken, " (unchanged)");
  console.log("Verifier:    ", addresses.Verifier,  " (unchanged)");
  console.log("");

  // Load TaskManager artifact
  const artifactPath = path.resolve(
    __dirname, "../artifacts/contracts/TaskManager.sol/TaskManager.json"
  );
  if (!fs.existsSync(artifactPath)) {
    throw new Error("Artifact not found — run: npx hardhat compile");
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

  // 1. Deploy new TaskManager
  console.log("Deploying new TaskManager…");
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const manager = await factory.deploy(addresses.POLToken);
  await manager.waitForDeployment();
  const managerAddress = await manager.getAddress();
  console.log("TaskManager: ", managerAddress);

  // 2. Approve new TaskManager to spend deployer's full POL balance
  const TOKEN_ABI = [
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
  ];
  const token = new ethers.Contract(addresses.POLToken, TOKEN_ABI, wallet);
  console.log("\nApproving TaskManager for unlimited POL spend…");
  const approveTx = await token.approve(managerAddress, ethers.MaxUint256);
  await approveTx.wait();
  console.log("Approved.    tx:", approveTx.hash);

  // 3. Register the existing Halo2Verifier
  console.log("\nRegistering Halo2Verifier on new TaskManager…");
  const mgr   = new ethers.Contract(managerAddress, TASK_MANAGER_ABI, wallet);
  const setTx = await mgr.setVerifier(addresses.Verifier);
  await setTx.wait();
  console.log("setVerifier() confirmed.  tx:", setTx.hash);

  // 4. Persist the new address to the single source of truth
  setTaskManagerAddress(mode, managerAddress);
  console.log(`\naddresses.json updated: ${field} = ${managerAddress}`);
  console.log("\nDone — fresh chain ready. Frontend will pick it up via /api/addresses.");
}

main().catch((e) => { console.error(e); process.exit(1); });
