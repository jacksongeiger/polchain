# Changelog

## 2026-06-11 — Era 2 (branch `era-2`): "Proven, Permissionless, Measured"

A ground-up upgrade closing Era 1's central hole — self-reported scores — and turning the closures into the product. **Built and tested; the on-chain cutover (`scripts/startNewEra.js`) is the one remaining manual step.**

- **feat(contract):** `TaskManagerV2.sol` — `submitWithProof` has no score parameter; the contract verifies a Halo2 proof of a batched forward pass and computes the score itself (signed-field argmax over public logits). Ownerless after `seal()`; permissionless post/submit/finalize; proof nullifier + challenge binding + instance-length guard; capped claimed path that never outranks a proof. 17 hardhat tests pass, including every gauntlet forgery run against the **real** EZKL verifier with **real** spike proofs (on-chain verify: 1.85M gas).
- **feat(zk):** Feasibility spike (gates G1-G5) chose N=8 (logrows 18, pk 4.2 GB, prove ~62s); proved one frozen proving key serves distinct trained models; calibrated on adversarially-grown weights so settings survive era-scale drift. Reusable verifier (11.1 KB) + VKA clears EIP-170 where the monolithic verifier (31.6 KB) didn't. `zk/challenge_pool.py` generated 250 batch commitments matching the spike's proven instances exactly.
- **feat(zk):** `zk/server/era2.py` — per-proof weight injection (Era 1 proved a static circuit regardless of training); visitor endpoint accepts tf.js weights; priority queue puts guests ahead of named miners. Smoke-tested: visitor weights → proof in 61.6s, predicted score 100.
- **feat(mining):** Per-miner wallets (`MINER_MNEMONIC`, derived + funded via `scripts/fundMiners.js`) — every submission attributable on BaseScan; live EIP-1559 fees replace the pinned gasPrice; shared-wallet nonce juggling deleted. autoMiner rewritten for prove rotation + honest CLAIMED fallback (no simulated scores anywhere).
- **feat(frontend):** Flat nav CHAIN · MINE · MODEL · SCIENCE + era badge. New Mine view (5-stage browser-miner pipeline, loss-canonical ending) and Science view (crossover + co-training cards). Era ribbon renders the Era-1 confession; Model lineage disclosure. Deleted Dashboard/Leaderboard/TaskHistory/Miners/SubmitGradient and the mode-toggle machinery (the UI toggle that silently redeployed contracts).
- **feat(research):** Co-training proves the data-access thesis — P (digits 0-4) and Q (digits 5-9) each cap at ~50% solo; parallel FedAvg reaches 88% reading all ten digits, no data shared. Crossover measures proof cost across a model-size ladder.
- **infra:** `addresses.json` schema 2 with eras registry; `scripts/startNewEra.js` replaces the destructive redeploy; `scripts/lib/{wallets,gauntlet}.js`.

## 2026-06-11

- **fix(env):** Restored the ZK prove server — Homebrew's Python upgrade had wiped the system site-packages holding ezkl/torch, leaving the Model view, live inference, and accuracy history dead. Deps now pinned in `zk/requirements.txt`, installed into `.venv` (Python 3.12); `npm run prove-server`, the admin server, and `miningLoop.js` all spawn the venv interpreter with a system-python fallback.
- **refine(ui):** Committed the April working-tree changes — Chain view miner identity softened ("Miner Alpha" naming, calmer palette); Model view gained `useChartZoom` (wheel-zoom + drag-pan accuracy chart, inline + fullscreen, reset control).
- **fix(ui):** Duplicate React keys in the Model "Recent blocks" table (task_id restarts after model resets) — key now includes row index; eliminated ~6,300 repeated console errors.
- **chore:** Untracked runtime artifacts (`zk/global_model.pth`, `zk/accuracy_log.json`, `server/miner-stats.json`) that were gitignored in April but never removed from the index; ignored `.venv`, `graphify-out/`, `zk/__pycache__/`.
- Added README.md and this changelog.
- Verified end-to-end in browser: Chain view (595 blocks, live mining card), Model view (96.3% accuracy chart with zoom, live inference predicted a drawn "1" at 98.1%), production build clean.

## 2026-04-01 → 2026-04-09 (commits db51cd3 … 3288c8c)

- PoLChain v1: basic/advanced mode, ZK attack simulator, proof inspector, federated learning views; crypto-native dashboard revamp + targeted reverts; single-source contract addressing with three-tier fallback; multi-RPC FallbackProvider.

## 2026-03 → 2026-04 (earlier)

- MNIST federated learning, FedAvg quality gating + adaptive digit routing, ZK verifier via EZKL Halo2, auto-finalization, miner simulator, always-on mining loop, Admin panel.
