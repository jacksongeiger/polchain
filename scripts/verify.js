/**
 * Verifies all three deployed PoLChain contracts on Basescan.
 * Run: npm run verify
 * Requires BASESCAN_API_KEY in .env
 */
const { execSync } = require("child_process");

const POL_TOKEN    = "0x777a6ff0544B6F8c50c48a5033AF9273F501A35A";
const TASK_MANAGER = "0x10251cE2E438D84CFbe6c591661cF291e5986dA8";
const VERIFIER     = "0xe4faC049f0eaa891096F853431DA9C1fF38CCEBf";

function run(label, cmd) {
  console.log(`\n── ${label} ──`);
  console.log(`$ ${cmd}`);
  try {
    const out = execSync(cmd, { stdio: "pipe" }).toString().trim();
    console.log(out);
    console.log(`✓ ${label} verified`);
  } catch (err) {
    const msg = (err.stdout || err.stderr || err.message).toString().trim();
    // Basescan returns "Already Verified" as a non-zero exit in some toolbox versions
    if (msg.includes("Already Verified") || msg.includes("already verified")) {
      console.log(`ℹ  ${label}: already verified`);
    } else {
      console.error(`✗ ${label} failed:\n${msg}`);
      process.exitCode = 1;
    }
  }
}

// POLToken — no constructor args
run(
  "POLToken",
  `npx hardhat verify --network baseSepolia ${POL_TOKEN}`
);

// TaskManager — constructor arg: POLToken address
run(
  "TaskManager",
  `npx hardhat verify --network baseSepolia ${TASK_MANAGER} "${POL_TOKEN}"`
);

// Halo2Verifier — no constructor args; specify contract name to disambiguate
run(
  "Verifier (Halo2Verifier)",
  `npx hardhat verify --network baseSepolia --contract contracts/Halo2Verifier.sol:Halo2Verifier ${VERIFIER}`
);
