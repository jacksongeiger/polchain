require("dotenv").config();
const { ethers } = require("ethers");
const { pathToFileURL } = require("url");
const path = require("path");

const REWARD = ethers.parseEther("100");
const THRESHOLD = 40;
const DEADLINE = Math.floor(Date.now() / 1000) + 60 * 60 * 24; // 24h from now
const DESCRIPTION = "Train a sentiment classifier on SST-2 dataset. Target accuracy > 82%.";

async function main() {
  // contracts.js is ESM (frontend package has "type":"module"), so use dynamic import
  const contractsUrl = pathToFileURL(path.resolve(__dirname, "../frontend/src/contracts.js")).href;
  const { ADDRESSES, TASK_MANAGER_ABI } = await import(contractsUrl);

  const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

  console.log("Posting task from:", wallet.address);
  console.log("TaskManager:      ", ADDRESSES.TaskManager);
  console.log("Reward:            100 POL");
  console.log("Threshold:        ", THRESHOLD);
  console.log("Deadline:         ", new Date(DEADLINE * 1000).toLocaleString());
  console.log("");

  const manager = new ethers.Contract(ADDRESSES.TaskManager, TASK_MANAGER_ABI, wallet);

  const tx = await manager.postTask(DESCRIPTION, THRESHOLD, REWARD, DEADLINE);
  console.log("Tx sent:", tx.hash);
  const receipt = await tx.wait();

  const event = receipt.logs
    .map((l) => { try { return manager.interface.parseLog(l); } catch { return null; } })
    .find((e) => e && e.name === "TaskPosted");

  if (event) {
    console.log("Task ID:", event.args.taskId.toString());
  }
  console.log("Done.");
}

main().catch((e) => { console.error(e); process.exit(1); });
