/**
 * redeployTaskManager.js — Deploy a fresh TaskManager, keep POLToken + Verifier.
 *
 * Run once before starting the mining loop on a clean chain:
 *   node scripts/redeployTaskManager.js
 *
 * This script:
 *   1. Deploys a new TaskManager pointing at the existing POLToken
 *   2. Grants it unlimited POL allowance from the deployer wallet
 *   3. Calls setVerifier() to re-register the existing Halo2Verifier
 *   4. Patches frontend/src/contracts.js with the new TaskManager address
 */
require("dotenv").config();
const { ethers } = require("ethers");
const { pathToFileURL } = require("url");
const path = require("path");
const fs   = require("fs");

async function main() {
  const contractsUrl = pathToFileURL(
    path.resolve(__dirname, "../frontend/src/contracts.js")
  ).href;
  const { ADDRESSES, TASK_MANAGER_ABI } = await import(contractsUrl);

  const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
  const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const balance  = await provider.getBalance(wallet.address);

  console.log("Deployer:    ", wallet.address);
  console.log("Balance:     ", ethers.formatEther(balance), "ETH");
  console.log("POLToken:    ", ADDRESSES.POLToken, " (unchanged)");
  console.log("Verifier:    ", ADDRESSES.Verifier,  " (unchanged)");
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
  const manager = await factory.deploy(ADDRESSES.POLToken);
  await manager.waitForDeployment();
  const managerAddress = await manager.getAddress();
  console.log("TaskManager: ", managerAddress);

  // 2. Approve new TaskManager to spend deployer's full POL balance
  const tokenArtifact = path.resolve(
    __dirname, "../artifacts/@openzeppelin/contracts/token/ERC20/IERC20.sol/IERC20.json"
  );
  // Use minimal ERC-20 ABI instead of the full artifact
  const TOKEN_ABI = [
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
  ];
  const token = new ethers.Contract(ADDRESSES.POLToken, TOKEN_ABI, wallet);
  console.log("\nApproving TaskManager for unlimited POL spend…");
  const approveTx = await token.approve(managerAddress, ethers.MaxUint256);
  await approveTx.wait();
  console.log("Approved.    tx:", approveTx.hash);

  // 3. Register the existing Halo2Verifier
  console.log("\nRegistering Halo2Verifier on new TaskManager…");
  const mgr = new ethers.Contract(managerAddress, TASK_MANAGER_ABI, wallet);
  const setTx = await mgr.setVerifier(ADDRESSES.Verifier);
  await setTx.wait();
  console.log("setVerifier() confirmed.  tx:", setTx.hash);

  // 4. Patch frontend/src/contracts.js
  const contractsPath = path.resolve(__dirname, "../frontend/src/contracts.js");
  let src = fs.readFileSync(contractsPath, "utf8");
  src = src.replace(
    /TaskManager:\s*"[^"]*"/,
    `TaskManager: "${managerAddress}"`
  );
  fs.writeFileSync(contractsPath, src, "utf8");
  console.log("\ncontracts.js updated:");
  console.log("  TaskManager:", managerAddress);
  console.log("\nDone — fresh chain ready. Run: npm run mining");
}

main().catch((e) => { console.error(e); process.exit(1); });
