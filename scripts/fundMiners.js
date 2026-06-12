/**
 * fundMiners.js — derive the four miner wallets and top each up to TARGET_ETH
 * from the deployer, then record the address map in server/addresses.json so
 * the frontend can attribute on-chain submissions to named miners.
 *
 * Idempotent: re-running only sends the shortfall, skips funded wallets.
 *
 * Run: node scripts/fundMiners.js
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const { ethers } = require("ethers");
const { MINER_NAMES, getMinerWallets, getDeployerWallet, getFeeOpts } = require("./lib/wallets");
const { readAddresses, writeAddresses } = require("./lib/addresses");

const TARGET_ETH = "0.03";

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org");
  const deployer = getDeployerWallet(provider);
  const miners   = getMinerWallets(provider);
  const target   = ethers.parseEther(TARGET_ETH);

  console.log(`Deployer: ${deployer.address} (${ethers.formatEther(await provider.getBalance(deployer.address))} ETH)`);

  const minerWallets = {};
  for (let id = 0; id < miners.length; id++) {
    const addr = miners[id].address;
    minerWallets[id] = { name: MINER_NAMES[id], address: addr };
    const bal = await provider.getBalance(addr);
    if (bal >= target) {
      console.log(`${MINER_NAMES[id].padEnd(12)} ${addr}  ${ethers.formatEther(bal)} ETH — funded ✓`);
      continue;
    }
    const topUp = target - bal;
    const fees  = await getFeeOpts(provider, 21_000n);
    const tx    = await deployer.sendTransaction({ to: addr, value: topUp, ...fees });
    await tx.wait();
    console.log(`${MINER_NAMES[id].padEnd(12)} ${addr}  +${ethers.formatEther(topUp)} ETH  tx: ${tx.hash}`);
  }

  const addresses = readAddresses();
  addresses.minerWallets = minerWallets;
  writeAddresses(addresses);
  console.log("\nminerWallets recorded in server/addresses.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
