# PoLChain — Proof of Learning Protocol

A blockchain where blocks are mined by **training a neural network**. Miners train shards of an MNIST classifier and submit a ZK proof of a forward pass over an unpredictable challenge batch; **the contract computes the score from the proof** and the highest proven score per block wins POL tokens. The global model improves block by block via federated averaging. Deployed on **Base Sepolia** (chainId 84532).

## The thesis (Era 2)

**Scores are computed by the contract from proofs — not claimed.** Everything else (an ownerless contract, permissionless mining from any wallet, on-chain attack receipts, measured research) is evidence for that one claim. Every gap that can't be closed is disclosed in the product itself.

## Eras

PoLChain runs in **eras** — contract generations. Each era's chain is sealed and archived; a new era mines on a fresh contract.

- **Era 1** (sealed archive, 595 winning blocks): the prototype. Miners *reported* their scores and the contract believed them — the ZK proof attested a forward pass but never bound the claimed score, and proofs were replayable. Honest about its hole.
- **Era 2** (proven + rewarded by improvement): `TaskManagerV3` removes the score parameter. A proven submission carries a Halo2 proof of a batched forward pass over a per-task challenge batch drawn from a committed pool; the contract checks instance layout, challenge binding, and a proof nullifier, verifies on-chain, then computes the score itself via signed-field argmax over the proof's public logits. The block reward is **not winner-take-all** — it is split among proven submissions in proportion to each one's *marginal improvement* over a poster-established base score (`reward_i = pool × max(0, score_i − base) / Σ`), so a near-copy of the already-good global model earns ~0. Ownerless after `seal()`: anyone may post tasks, submit work, and finalize.

## Architecture

```
frontend (Vite + React, :5173)        CHAIN · MINE · MODEL · SCIENCE
   │  three-tier address fallback: live API → localStorage → build-time bundle
   ├── admin server (Express, :3001) — process mgmt, SSE logs, eras registry,
   │     /api/experiments, /api/visitor-shard, serves server/addresses.json
   ├── prove server (Flask + EZKL/Halo2 + PyTorch, :5001)
   │     legacy: /train /predict /accuracy (Era-1 archive)
   │     Era 2: /v2/prove (named), /v2/prove-visitor (tf.js weights), /v2/info
   └── Base Sepolia contracts
         POLToken                 ERC-20, 1M fixed supply
         Halo2VerifierReusable    EZKL reusable verifier + registered VKA (11KB)
         TaskManagerV3            ownerless; proven scores + marginal-improvement reward
```

- **Per-miner wallets** — Alpha/Beta/Gamma/Delta derive from `MINER_MNEMONIC` and submit from their own funded wallets; every submission is attributable on BaseScan. One miner per block proves (rotation); the rest submit real local scores as second-class CLAIMED entries that can never outrank a proof.
- **Browser mining** — the Mine view trains a 2,000-sample private shard in-tab (TensorFlow.js), sends weights to the prover (guests outrank the bot queue), and signs its own `submitWithProof`. A visitor competes against the named miners under identical rules.
- **Challenge pool** — 250 fixed batches of 8 held-out MNIST images (test indices 2000-4000, disjoint from the displayed-accuracy set), committed at deploy via Poseidon digests the contract pins per task.
- Contract addresses + eras registry live in `server/addresses.json`; the frontend bundles a snapshot at build time so the UI never blocks on the network.

## Setup

```bash
npm install
cd frontend && npm install && cd ..
/opt/homebrew/bin/python3.12 -m venv .venv
.venv/bin/pip install -r zk/requirements.txt
cp .env.example .env   # PRIVATE_KEY, BASE_SEPOLIA_RPC_URL, BASESCAN_API_KEY
```

## Run

```bash
npm run frontend       # UI on :5173 (works read-only with no servers)
npm run server         # admin server on :3001
npm run prove-server   # ZK/inference server on :5001 (needs .venv)
npm run mining         # full loop: task poster + auto-miner + admin server
```

Contracts: `npm run compile`, `npm test` (the Era-2 suite verifies real spike proofs through the real verifier in hardhat).

## Era-2 cutover runbook

Era 2 is **built and tested but not yet deployed** — the cutover is an irreversible production action. To go live:

```bash
# 0. prerequisites (already done if zk/v2/ and zk/challenge_commitments.json exist)
caffeinate -i .venv/bin/python zk/spike/run_spike.py     # feasibility gates → zk/spike/spike_results.json
caffeinate -i .venv/bin/python zk/challenge_pool.py      # 250 commitments → zk/challenge_commitments.json

# 1. fund the four miner wallets (idempotent)
node scripts/fundMiners.js

# 2. compile + test the Era-2 contract
npm run compile && npx hardhat test  # 59 tests: V1, V2, V3 (real proofs through the real verifier)

# 3. THE CUTOVER — deploys Halo2VerifierReusable + TaskManagerV3, registers the
#    VKA, loads all 250 challenge batches in chunks, seals (ownerless), seals
#    Era 1 in addresses.json and appends Era 2. Irreversible.
node scripts/startNewEra.js

# 4. start mining the new era
npm run mining         # + npm run prove-server in another shell
```

After cutover the UI flips automatically: the era badge reads `ERA 2 · LIVE`, the Chain confession switches to the proven-scores framing, and the Mine view unlocks (it gates on `isSealed()` until then).

### Demo-day notes (verified 2026-07)

- **Base score must land before the block finalizes.** `miningLoop.js` proves the current global model and calls `establishBase` right after `postTask`; marginal rewards are measured against it. The base proof (~60s) shares the serial prover queue, and visitors jump ahead of it — so on a *shortened* demo block, confirm `BaseEstablished` is on-chain (the Mine rail shows `BASE MODEL <score>`) before miners/visitors submit. If the base never lands, `baseScore` is 0 and every score counts as full improvement (graceful, but the "improvement over base" story won't read). Keep the demo block ≥ 4 min, or pre-establish the base.
- **Use a dedicated RPC for recording.** The default multi-RPC fallback includes `base-sepolia-rpc.publicnode.com`, which intermittently returns HTTP 403 (rate-limit) — harmless (the FallbackProvider falls through to `sepolia.base.org`) but it prints console noise. Set `VITE_BASE_SEPOLIA_RPC` to your own Alchemy/Infura URL for a clean console on camera.
- **First live block is the true integration test.** The off-chain wiring (`miningLoop` establishBase → `/v2/prove-base` → on-chain `establishBase`; `autoMiner` V3 submit) is statically reviewed and the contract read/write layer is ABI-verified against the compiled contract, but it has only run against local hardhat, never a live V3. Watch the first block end-to-end before recording.
- **Frontend is version-aware.** Chain/Mine probe the active contract (`isSealed()` ⇒ V3) and read with the right ABI, so they work both before the cutover (Era-1 V1 archive) and after (Era-2 V3). Verified in-browser against the live V1 contract with no regressions.

## Research (Science view)

```bash
.venv/bin/python zk/experiments/run.py --suite cotrain     # private-data co-training
.venv/bin/python zk/experiments/run.py --suite crossover   # proof cost vs model size
```

- **Co-training**: miner P sees only digits 0-4, Q only 5-9; neither clears 52% alone, the federated merge reads all ten digits at **88%** — the data-access thesis, measured.
- **Crossover**: full prove pipeline across a 5-MLP size ladder; the verification tax as a measured curve, not an estimate.

## Key decisions

- **Hardhat 2 (CJS), not Hardhat 3** — toolbox compatibility. `solc runs: 1` (size over gas) so the verifier clears EIP-170.
- **N=8 challenge batch** (spike-chosen): N=16's proving key projected past 12 GB on 16 GB RAM. Proven scores are therefore multiples of 12.5 — sharp against a liar, blunt at distinguishing 95.8 vs 96.1 (Wilson intervals shown).
- **Reusable verifier + VKA**: the monolithic EZKL verifier is 31.6 KB (over EIP-170); `Halo2VerifierReusable` is 11.1 KB and takes the 10.8 KB verifying-key artifact as calldata, pinned by digest in `TaskManagerV3`.
- **Frozen circuit, per-proof weight injection**: settings/SRS/pk are calibrated once (on adversarially-grown weights so they survive an era of drift) and frozen; each proof recompiles only the witness from the miner's actual trained weights (~0.1s) and proves with the shared key (~60s).
- **Python 3.12 venv** for the ZK stack — torch/ezkl wheels lag newer Pythons; a Homebrew upgrade once wiped the system install (hence pinned `zk/requirements.txt`).
- **Known residuals** (disclosed, not hidden): the 250-batch pool is precomputable offline (public-benchmark trust model — enlarging the pool raises the attack cost linearly); a task poster can grind batch selection; proof attests inference quality, not training effort. See the gauntlet residuals panel.
- Runtime artifacts (`zk/global_model.pth`, `zk/accuracy_log.json`, `server/miner-stats.json`, `zk/v2/`, `zk/spike/artifacts/`) are untracked — they churn or are large.
