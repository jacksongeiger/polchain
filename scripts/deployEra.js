/**
 * deployEra.js — PHASE 1 of a safe era cutover: deploy, but do NOT go live.
 *
 * Does everything scripts/startNewEra.js does on-chain (deploy verifier, register
 * the VKA, deploy TaskManagerV3, load the challenge pool, seal, approve POL) and
 * then writes the result to server/staging-era.json — NOT server/addresses.json.
 *
 * The on-chain half is irreversible, but it is also INVISIBLE: nothing in the
 * stack resolves a contract except through addresses.json, so the live era keeps
 * running untouched while the staged contract sits unreferenced.
 *
 *   1. node scripts/deployEra.js     <- you are here (irreversible, invisible)
 *   2. node scripts/smokeEra.js      <- drive one real block against the stage
 *   3. node scripts/promoteEra.js    <- reversible, public: the era goes live
 *
 * If step 2 fails: delete server/staging-era.json, fix, and run step 1 again.
 * The orphaned contract is a dead address nobody ever pointed at.
 *
 * Usage: node scripts/deployEra.js [--force]
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const { ethers } = require("ethers");
const path = require("path");
const fs = require("fs");

const { readAddresses, currentEra } = require("./lib/addresses");
const { getDeployerWallet, getFeeOpts } = require("./lib/wallets");

const CHUNK = 50;
const ROOT = path.resolve(__dirname, "..");
const STAGING_PATH = path.join(ROOT, "server", "staging-era.json");
const MIN_ETH = ethers.parseEther("0.05"); // cutover measured at ~13.1M gas

function artifact(rel) {
  const p = path.join(ROOT, "artifacts/contracts", rel);
  if (!fs.existsSync(p)) throw new Error(`${rel} artifact missing — npx hardhat compile`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function main() {
  const force = process.argv.includes("--force");

  if (fs.existsSync(STAGING_PATH) && !force) {
    console.error(`\nRefusing to run: ${path.relative(ROOT, STAGING_PATH)} already exists.`);
    const existing = JSON.parse(fs.readFileSync(STAGING_PATH, "utf8"));
    console.error(`A staged era is already pending:`);
    console.error(`  taskManager ${existing.taskManager}`);
    console.error(`  stagedAt    ${existing.stagedAt}`);
    console.error(`\nPromote it (scripts/promoteEra.js), delete the file to abandon it,`);
    console.error(`or re-run with --force to stage a replacement.\n`);
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(
    process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org"
  );
  const deployer = getDeployerWallet(provider);
  const addresses = readAddresses();
  const pool = JSON.parse(fs.readFileSync(path.join(ROOT, "zk/challenge_commitments.json"), "utf8"));
  const vka = JSON.parse(fs.readFileSync(path.join(ROOT, "zk/v2/vka.json"), "utf8")).words;

  const commitments = pool.batches.map((b) => BigInt(b.commitment));
  const labels      = pool.batches.map((b) => BigInt(b.packedLabels));
  const vkaDigest   = ethers.keccak256(ethers.concat(vka));
  const batchDigest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["uint256[]", "uint256[]"], [commitments, labels])
  );

  const bal = await provider.getBalance(deployer.address);
  const live = currentEra(addresses);

  console.log(`\n─── PHASE 1: DEPLOY (irreversible on-chain, invisible to the stack) ───\n`);
  console.log(`Deployer:        ${deployer.address}`);
  console.log(`Balance:         ${ethers.formatEther(bal)} ETH`);
  console.log(`Live era stays:  Era ${live?.era} @ ${live?.taskManager}`);
  console.log(`Pool:            ${pool.numBatches} batches of N=${pool.n}`);
  console.log(`vkaDigest:       ${vkaDigest}`);
  console.log(`batchDataDigest: ${batchDigest}\n`);

  if (bal < MIN_ETH) {
    console.error(`Refusing to run: balance below ${ethers.formatEther(MIN_ETH)} ETH.`);
    process.exit(1);
  }

  let totalGas = 0n;
  const track = async (label, txp) => {
    const tx = await txp;
    const r = await tx.wait();
    totalGas += r.gasUsed;
    console.log(`  ${label.padEnd(24)} ${r.gasUsed.toString().padStart(9)} gas  ${tx.hash}`);
    return r;
  };

  // 1. Verifier + VKA
  const verArt = artifact("VerifierV2Reusable.sol/Halo2VerifierReusable.json");
  const verifier = await new ethers.ContractFactory(verArt.abi, verArt.bytecode, deployer)
    .deploy(await getFeeOpts(provider, 3_000_000n));
  await verifier.waitForDeployment();
  const verifierAddr = await verifier.getAddress();
  console.log(`Halo2VerifierReusable:   ${verifierAddr}`);
  await track("registerVka", verifier.registerVka(vka, await getFeeOpts(provider, 1_000_000n)));

  // 2. TaskManagerV3
  const mgrArt = artifact("TaskManagerV3.sol/TaskManagerV3.json");
  const manager = await new ethers.ContractFactory(mgrArt.abi, mgrArt.bytecode, deployer)
    .deploy(addresses.POLToken, verifierAddr, vkaDigest, batchDigest, pool.numBatches,
            await getFeeOpts(provider, 4_000_000n));
  await manager.waitForDeployment();
  const managerAddr = await manager.getAddress();
  console.log(`TaskManagerV3:           ${managerAddr}\n`);

  // 3. Challenge pool, chunked
  console.log(`loadBatches (chunks of ${CHUNK}):`);
  for (let i = 0; i < commitments.length; i += CHUNK) {
    await track(`  [${i}..${Math.min(i + CHUNK, commitments.length) - 1}]`,
      manager.loadBatches(commitments.slice(i, i + CHUNK), labels.slice(i, i + CHUNK),
        await getFeeOpts(provider, 6_000_000n)));
  }

  // 4. Seal — ownerless from here
  console.log(`\nseal():`);
  const sealR = await track("seal", manager.seal(await getFeeOpts(provider, 3_000_000n)));

  // 5. POL approval for the operator's posting
  const erc20 = new ethers.Contract(addresses.POLToken,
    ["function approve(address,uint256) returns (bool)"], deployer);
  await track("approve POL",
    erc20.approve(managerAddr, ethers.MaxUint256, await getFeeOpts(provider, 100_000n)));

  // Post-deploy verification against the chain itself
  const onChain = new ethers.Contract(managerAddr, [
    "function isSealed() view returns (bool)",
    "function numBatches() view returns (uint256)",
    "function vkaDigest() view returns (bytes32)",
    "function batchDataDigest() view returns (bytes32)",
  ], provider);
  const checks = {
    sealed:      await onChain.isSealed(),
    numBatches:  Number(await onChain.numBatches()) === pool.numBatches,
    vkaDigest:   (await onChain.vkaDigest()) === vkaDigest,
    batchDigest: (await onChain.batchDataDigest()) === batchDigest,
  };
  console.log(`\nOn-chain verification:`);
  for (const [k, v] of Object.entries(checks)) console.log(`  ${k.padEnd(12)} ${v ? "OK" : "FAIL"}`);
  if (!Object.values(checks).every(Boolean)) {
    console.error(`\nDeploy verification FAILED — not staging. Contract is orphaned; nothing was changed.`);
    process.exit(1);
  }

  const staged = {
    taskManager: managerAddr,
    verifier: verifierAddr,
    vkaDigest,
    batchDataDigest: batchDigest,
    numBatches: pool.numBatches,
    n: pool.n,
    sealTx: sealR.hash,
    deployer: deployer.address,
    chainId: Number((await provider.getNetwork()).chainId),
    totalGas: totalGas.toString(),
    stagedAt: new Date().toISOString(),
    promotedFromEra: live?.era ?? null,
    smokeTested: false,
  };
  fs.writeFileSync(STAGING_PATH, JSON.stringify(staged, null, 2) + "\n");

  console.log(`\nTOTAL GAS: ${totalGas.toString()}`);
  console.log(`\nSTAGED -> ${path.relative(ROOT, STAGING_PATH)}`);
  console.log(`addresses.json UNCHANGED — Era ${live?.era} is still live.`);
  console.log(`BaseScan: https://sepolia.basescan.org/address/${managerAddr}`);
  console.log(`\nNext:  node scripts/smokeEra.js\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
