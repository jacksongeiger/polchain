const { ethers } = require("hardhat");

const INITIAL_SUPPLY = ethers.parseEther("1000000");

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log("Deployer:   ", deployer.address);
  console.log("Balance:    ", ethers.formatEther(balance), "ETH");
  console.log("Network:    ", network.name, `(chainId ${network.chainId})`);
  console.log("");

  // 1. Deploy POLToken — mints 1,000,000 POL to deployer
  console.log("Deploying POLToken...");
  const POLToken = await ethers.getContractFactory("POLToken");
  const token = await POLToken.deploy();
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  console.log("POLToken:   ", tokenAddress);

  // 2. Deploy TaskManager with POLToken address
  console.log("Deploying TaskManager...");
  const TaskManager = await ethers.getContractFactory("TaskManager");
  const manager = await TaskManager.deploy(tokenAddress);
  await manager.waitForDeployment();
  const managerAddress = await manager.getAddress();
  console.log("TaskManager:", managerAddress);

  // 3. Approve TaskManager to spend the full 1,000,000 POL supply from deployer
  console.log("\nApproving TaskManager to spend 1,000,000 POL...");
  const approveTx = await token.approve(managerAddress, INITIAL_SUPPLY);
  await approveTx.wait();
  console.log("Approved.   tx:", approveTx.hash);

  console.log("\n--- Deployment complete ---");
  console.log(`POLToken:    ${tokenAddress}`);
  console.log(`TaskManager: ${managerAddress}`);
  console.log("\nUpdate ADDRESSES in frontend/src/contracts.js with the above.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
