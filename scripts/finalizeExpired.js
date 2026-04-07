require("dotenv").config();
const { ethers } = require("ethers");
const { pathToFileURL } = require("url");
const path = require("path");

const { getActiveTaskManagerAddress } = require("./lib/addresses");

async function main() {
  const contractsUrl = pathToFileURL(path.resolve(__dirname, "../frontend/src/contracts.js")).href;
  const { TASK_MANAGER_ABI } = await import(contractsUrl);

  const provider        = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
  const wallet          = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const taskManagerAddr = getActiveTaskManagerAddress();
  const manager         = new ethers.Contract(taskManagerAddr, TASK_MANAGER_ABI, wallet);

  const total = Number(await manager.totalTasks());
  const now   = Math.floor(Date.now() / 1000);

  if (total === 0) {
    console.log("No tasks found.");
    return;
  }

  console.log(`Checking ${total} task(s)…\n`);

  let finalized = 0;

  for (let id = 1; id <= total; id++) {
    let task;
    try {
      task = await manager.getTask(id);
    } catch (e) {
      console.log(`Task #${id}: failed to fetch — ${e.message}`);
      continue;
    }

    const deadline  = Number(task.deadline);
    const deadlineStr = new Date(deadline * 1000).toLocaleString();

    if (task.finalized) {
      console.log(`Task #${id}: already finalized (winner: ${task.winner})`);
      continue;
    }

    if (now < deadline) {
      const secsLeft = deadline - now;
      const hLeft    = Math.floor(secsLeft / 3600);
      const mLeft    = Math.floor((secsLeft % 3600) / 60);
      console.log(`Task #${id}: active — deadline in ${hLeft}h ${mLeft}m (${deadlineStr})`);
      continue;
    }

    console.log(`Task #${id}: deadline passed, finalizing…`);
    try {
      const tx      = await manager.finalizeTask(id);
      const receipt = await tx.wait();

      // Parse TaskFinalized event from the receipt
      let winner = null;
      let reward = null;
      for (const log of receipt.logs) {
        try {
          const parsed = manager.interface.parseLog(log);
          if (parsed.name === "TaskFinalized") {
            winner = parsed.args.winner;
            reward = parsed.args.reward;
          }
        } catch {}
      }

      if (winner && winner !== ethers.ZeroAddress) {
        // Find the winning submission to get the score
        let winnerScore = "?";
        try {
          const subs = await manager.getAllSubmissions(id);
          const winnerSub = subs
            .filter((s) => s.miner.toLowerCase() === winner.toLowerCase())
            .sort((a, b) => Number(b.score) - Number(a.score))[0];
          if (winnerSub) winnerScore = winnerSub.score.toString();
        } catch {}

        console.log(
          `Task #${id}: finalized. ` +
          `Winner: ${winner}  ` +
          `Score: ${winnerScore}  ` +
          `Reward: ${ethers.formatEther(reward)} POL`
        );
      } else {
        console.log(`Task #${id}: finalized with no submissions — reward refunded to owner.`);
      }

      finalized++;
    } catch (e) {
      console.log(`Task #${id}: finalize failed — ${e.reason || e.message}`);
    }
  }

  console.log(`\nDone. Finalized ${finalized} task(s).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
