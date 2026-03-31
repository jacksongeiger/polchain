require("dotenv").config();
const { ethers } = require("ethers");
const { pathToFileURL } = require("url");
const path = require("path");
const fs = require("fs");

async function main() {
  // Load ABIs/addresses from ESM contracts.js
  const contractsUrl = pathToFileURL(path.resolve(__dirname, "../frontend/src/contracts.js")).href;
  const { ADDRESSES, TASK_MANAGER_ABI } = await import(contractsUrl);

  const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  console.log("Deployer:", wallet.address);

  // Load compiled Verifier artifact (Halo2Verifier)
  const artifactPath = path.resolve(__dirname, "../artifacts/contracts/Verifier.sol/Halo2Verifier.json");
  if (!fs.existsSync(artifactPath)) {
    throw new Error("Artifact not found — run: npx hardhat compile");
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

  // Deploy Verifier.sol
  console.log("Deploying Halo2Verifier…");
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const verifier = await factory.deploy();
  await verifier.waitForDeployment();
  const verifierAddress = await verifier.getAddress();
  console.log("Halo2Verifier deployed:", verifierAddress);

  // Register it on TaskManager
  console.log("Calling setVerifier() on TaskManager…");
  const manager = new ethers.Contract(ADDRESSES.TaskManager, TASK_MANAGER_ABI, wallet);
  const tx = await manager.setVerifier(verifierAddress);
  console.log("Tx sent:", tx.hash);
  await tx.wait();
  console.log("setVerifier() confirmed.");

  // Patch frontend/src/contracts.js in-place
  const contractsPath = path.resolve(__dirname, "../frontend/src/contracts.js");
  let src = fs.readFileSync(contractsPath, "utf8");
  src = src.replace(
    /Verifier:\s*"[^"]*"/,
    `Verifier:    "${verifierAddress}"`
  );
  fs.writeFileSync(contractsPath, src, "utf8");
  console.log("contracts.js updated with Verifier address.");
  console.log("Done.");
}

main().catch((e) => { console.error(e); process.exit(1); });
