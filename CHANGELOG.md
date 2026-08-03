# Changelog

## 2026-08-03 — ERA 2 IS LIVE + two bugs the smoke test caught

Cutover executed via the staged flow. `TaskManagerV3` at `0x471e2744d1fb0245219B6ebe6Ee316C78b782992`, verifier at `0x5489dEB4f128E719495931D2d6d6009e4477ab07`. Era 1 sealed as a 601-block archive. Deploy cost **13,150,811 gas** — within 0.4% of the hardhat rehearsal's 13,104,128.

The smoke test failed twice before passing, on two bugs that no unit test, ABI check, or hardhat run could have found. Both were live-network-only.

- **fix(mining): `postTask` was out of gas on every block.** `miningLoop` capped all txs at a flat `GAS_LIMIT = 300_000n`, calibrated against Era 1's V1. V3's `postTask` costs **337,248** — it burned the full limit and reverted with `status: 0`, so no Era-2 block could ever be posted. Replaced the flat ceiling with a live `estimateGas` + 50% headroom (`gasFor()`), because `finalizeTask` has the same exposure and its cost *scales with the number of proven miners* — no fixed number is correct for it.
- **fix(mining): `establishBase` could never succeed.** The prove server is fully blocked for the duration of a proof (CPU-bound EZKL native code holding the GIL). Measured: idle polls return in 0.01s, a poll issued mid-proof takes **27s**. The job-status poll used `AbortSignal.timeout(5_000)`, so the base proof aborted on every block — `baseScore` stayed 0 and the entire marginal-improvement premise silently evaporated while the UI still looked healthy. Raised to 90s (~3x the measured 31s prove) across all four prove-server call sites in `miningLoop` and `autoMiner`.
- **fix(smoke):** `smokeEra.js` used `manager.on()`; public Base Sepolia RPCs expire filters aggressively, flooding `eth_getFilterChanges → "filter not found"` and missing events entirely — a healthy block reads as a failure. Replaced with `queryFilter` polling over explicit block ranges (no server-side state).
- **verified live:** Block #2 ran the full sequence — `TaskPosted` (batch 178) → `BaseEstablished` (base 100) → `ProvenWorkSubmitted` (Miner Gamma) → `TaskFinalized`. 4 submissions, 1 proven, 3 claimed. Frontend renders `ERA 2 · LIVE` with zero console errors.

### ⚠️ Known: 68.8% of blocks cannot pay a reward

Measured by running the current global model (96.25%) over all 250 committed batches via the prover's own data path:

| base score | batches | share |
| --- | --- | --- |
| 100 (8/8) | 172 | **68.8%** |
| 88 (7/8) | 67 | 26.8% |
| 75 (6/8) | 10 | 4.0% |
| 62 (5/8) | 1 | 0.4% |

When `base == 100` no miner can post a positive marginal, so `finalizeTask` refunds the poster and emits `winners=0, rewardPaid=0`. The Chain view renders these as **"No winner"** and holds `BLOCKS MINED` at 0. This is the contract behaving exactly as designed — it is a *consequence of N=8 quantisation* (scores are multiples of 12.5) meeting a near-saturated MNIST model, not a defect. It is a demo-content problem, not a correctness one. See the next entry for options.

## 2026-08-02 — Staged era cutover + pre-cutover verification

The Era-2 cutover was a single irreversible script. It is now three steps, split along the line where risk actually changes: **the on-chain half is irreversible but invisible, the `addresses.json` half is visible but undoable.** Nothing in the stack resolves a contract except through `addresses.json`, so a deployed-but-unpromoted era sits unreferenced while Era 1 keeps mining.

- **feat(ops):** `scripts/deployEra.js` — deploys + seals on-chain, reads the contract back to verify `isSealed`/`numBatches`/both digests, then writes `server/staging-era.json`. Never touches `addresses.json`. Refuses on a pending stage (`--force` to replace) or a deployer under 0.05 ETH.
- **feat(ops):** `scripts/smokeEra.js` — spawns the **real** `miningLoop` + `autoMiner` against the staged address and asserts `TaskPosted → BaseEstablished → ProvenWorkSubmitted → TaskFinalized`. Pre-checks that the prove server's VKA digest matches the staged contract, so a prover/contract mismatch fails in seconds. Flags a zero `baseScore` explicitly (pays out fine, but the improvement story won't read on camera). Passing sets `smokeTested`.
- **feat(ops):** `scripts/promoteEra.js` — refuses without a smoke test (`--skip-smoke` overrides, loudly), re-verifies on-chain, backs `addresses.json` up to `server/addresses-backups/`, then calls the existing `startEra()`. `--rollback` restores the latest backup.
- **feat(lib):** `POLCHAIN_TASKMANAGER` / `POLCHAIN_VERIFIER` overrides in `scripts/lib/addresses.js` — how the smoke test redirects the whole stack (both mining scripts and the admin server already resolve through `getActiveTaskManagerAddress()`) with no forked logic. Warns once per process; unset behaviour is byte-identical.
- **verify:** cutover rehearsed on local hardhat with the real 250-batch pool — verifier 11,136 bytes (under EIP-170), `loadBatches` ×5, `seal()` accepted the pool against `batchDataDigest`, post-seal `loadBatches`/`seal` both revert. **13,104,128 gas** total.
- **verify:** a live `/v2/prove-base` proof (81 instances, 6,144 bytes) pushed through a deployed `Halo2VerifierReusable` via the identical raw-call path `_verifyOnChain` uses → `true`, **1,498,488 gas**; `BadInstanceLength` + `ChallengeMismatch` pass, `instances[0]` matches the pool commitment, off-chain signed-field argmax score **100** = the prover's own prediction. Prove server VKA digests to `0xe94433ab…`, exactly what the cutover pins.
- **measured:** prove time is **32.8s** (compile 0.1 / witness 0.9 / prove 31.2), not the ~60s the spike projected — roughly double the slack inside a 240s block.
- **guard rails tested:** pending stage, missing smoke test, dead address, real-but-wrong contract (Era-1 V1), rollback with no backups — all refuse, and `addresses.json` is never written in any of them.
- `scripts/startNewEra.js` left intact as the original one-shot path. 59 contract tests still pass.

## 2026-07-23 — Era 2: Proof of Improvement + production hardening

- **feat(contract):** `TaskManagerV3` — reward is split by *marginal improvement* over a poster-established base score, not winner-take-all, killing the free-rider hole (a near-copy of the public global model earns ~0). Poster-only `establishBase`, per-miner marginal split with dust refund, proof nullifier + challenge binding retained. The intended fully-trustless param-commitment was **cut after a gate**: hashing 109k params in-circuit blew the proof from logrows 18 → 23 (tens-of-GB key, infeasible on 16 GB) — documented in `docs/REWARD_REDESIGN.md`.
- **feat(frontend):** Mine + Chain converted to the V3 ABI. Mine shows the base score, a per-miner Δ (improvement) column, and a settle screen reworked from win/lose to "+N improvement → X POL" (exact reward read from `RewardPaid`). Chain is **version-aware** — probes `isSealed()` to pick the V1 (archive) or V3 (live) ABI, so it survives the cutover; V3 block headline is the top improver, not a single winner.
- **test/verify:** 59 contract tests pass (V1/V2/V3, real proofs through the real EZKL verifier, marginal-split math, gas). Frontend `TASK_MANAGER_ABI_V3` verified to match the compiled contract exactly — all 43 fragments (selectors) **and** the read-function return-tuple shapes. Cutover digests (batchData, VKA) + instance shapes verified against the contract's `seal()`/verify checks. Browser-verified against the live Era-1 contract: Chain/Mine/Science render, Mine gates correctly, zero functional console errors. Off-chain base-proof wiring added (`/v2/prove-base`, `miningLoop.establishBase`); `startNewEra.js` now deploys V3. README runbook updated with demo-day operational notes.
- **framing:** "Proof of Learning" naming kept intact by request (honesty reframe deferred).

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
