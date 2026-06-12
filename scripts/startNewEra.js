/**
 * startNewEra.js — Era cutover. Replaces the destructive redeployTaskManager.js
 * (which silently swapped the live contract underneath the UI).
 *
 * An era boundary is an explicit, irreversible event:
 *   1. Deploy Halo2VerifierReusable and register the frozen circuit's VKA
 *   2. Deploy TaskManagerV2 pinned to (vkaDigest, batchDataDigest, numBatches)
 *   3. Load all challenge-batch commitments + packed labels in chunks
 *   4. seal() — verify the pool against the pinned digest, renounce setup:
 *      the contract has zero privileged functions from this moment
 *   5. Approve POL for the operator's task posting
 *   6. Seal the previous era in server/addresses.json (final block counts read
 *      from its chain) and append the new era; legacy mirror keys follow
 *
 * Run once: node scripts/startNewEra.js
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const { ethers } = require("ethers");
const path = require("path");
const fs = require("fs");

const { readAddresses, startEra, currentEra } = require("./lib/addresses");
const { getDeployerWallet, getFeeOpts } = require("./lib/wallets");

const CHUNK = 50; // batches per loadBatches tx

function artifact(rel) {
  const p = path.resolve(__dirname, "../artifacts/contracts", rel);
  if (!fs.existsSync(p)) throw new Error(`${rel} artifact missing — npx hardhat compile`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org");
  const deployer = getDeployerWallet(provider);
  const addresses = readAddresses();
  const pool = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../zk/challenge_commitments.json"), "utf8"));
  const vka  = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../zk/v2/vka.json"), "utf8")).words;

  const commitments = pool.batches.map((b) => BigInt(b.commitment));
  const labels      = pool.batches.map((b) => BigInt(b.packedLabels));
  const vkaDigest   = ethers.keccak256(ethers.concat(vka));
  const batchDigest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["uint256[]", "uint256[]"], [commitments, labels])
  );

  console.log(`Deployer:        ${deployer.address}`);
  console.log(`Pool:            ${pool.numBatches} batches of N=${pool.n}`);
  console.log(`vkaDigest:       ${vkaDigest}`);
  console.log(`batchDataDigest: ${batchDigest}\n`);

  // 1. Verifier + VKA registration
  const verArt = artifact("VerifierV2Reusable.sol/Halo2VerifierReusable.json");
  const verFactory = new ethers.ContractFactory(verArt.abi, verArt.bytecode, deployer);
  const verifier = await verFactory.deploy(await getFeeOpts(provider, 3_000_000n));
  await verifier.waitForDeployment();
  console.log(`Halo2VerifierReusable: ${await verifier.getAddress()}`);

  const regTx = await verifier.registerVka(vka, await getFeeOpts(provider, 1_000_000n));
  await regTx.wait();
  console.log(`VKA registered:        ${regTx.hash}`);

  // 2. TaskManagerV3 (Proof of Improvement — marginal-reward split)
  const mgrArt = artifact("TaskManagerV3.sol/TaskManagerV3.json");
  const mgrFactory = new ethers.ContractFactory(mgrArt.abi, mgrArt.bytecode, deployer);
  const manager = await mgrFactory.deploy(
    addresses.POLToken, await verifier.getAddress(), vkaDigest, batchDigest,
    pool.numBatches, await getFeeOpts(provider, 4_000_000n)
  );
  await manager.waitForDeployment();
  const managerAddr = await manager.getAddress();
  console.log(`TaskManagerV2:         ${managerAddr}`);

  // 3. Challenge pool, chunked
  for (let i = 0; i < commitments.length; i += CHUNK) {
    const tx = await manager.loadBatches(
      commitments.slice(i, i + CHUNK), labels.slice(i, i + CHUNK),
      await getFeeOpts(provider, 6_000_000n)
    );
    await tx.wait();
    console.log(`  loadBatches[${i}..${Math.min(i + CHUNK, commitments.length) - 1}]  ${tx.hash}`);
  }

  // 4. Seal — ownerless from here
  const sealTx = await manager.seal(await getFeeOpts(provider, 3_000_000n));
  await sealTx.wait();
  console.log(`SEALED (ownerless):    ${sealTx.hash}`);

  // 5. POL approval for the operator's posting
  const erc20 = new ethers.Contract(addresses.POLToken,
    ["function approve(address,uint256) returns (bool)"], deployer);
  const apTx = await erc20.approve(managerAddr, ethers.MaxUint256, await getFeeOpts(provider, 100_000n));
  await apTx.wait();
  console.log(`POL approved:          ${apTx.hash}`);

  // 6. Seal the old era with final on-chain counts, append the new one
  const prev = currentEra();
  let sealCounts = {};
  if (prev && prev.taskManager) {
    try {
      const old = new ethers.Contract(prev.taskManager,
        ["function totalTasks() view returns (uint256)"], provider);
      sealCounts.blocksPosted = Number(await old.totalTasks());
    } catch { /* keep recorded counts */ }
  }
  const era = startEra({
    taskManager: managerAddr,
    verifier: await verifier.getAddress(),
    label: `Era ${ (prev?.era || 1) + 1 } — proof of improvement`,
    extra: {
      vkaDigest,
      batchDataDigest: batchDigest,
      numBatches: pool.numBatches,
      n: pool.n,
      sealTx: sealTx.hash,
    },
    sealCounts,
  });

  console.log(`\nEra ${era.era} live. addresses.json updated; legacy mirrors now point at V2.`);
  console.log(`BaseScan: https://sepolia.basescan.org/address/${managerAddr}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
