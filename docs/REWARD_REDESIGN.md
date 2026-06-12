# Era 2 — Reward Redesign: "Proof of Improvement"

## Context

After the Era-2 build, a critic panel + design discussion exposed a real incentive
hole in the winner-take-all design: because the global model is **public** and miners
warm-start from it, a lazy miner can submit a near-copy of the already-good global
model, score ~96% on the challenge, and **win the block reward for ~zero
contribution** — free-riding on everyone else's training. Winner-take-all also
concentrates rewards in one miner per block, which is hostile to FedAvg (you want
diverse gradients, not one dominant contributor — a concern already flagged in the
project's own paper notes).

**The fix we agreed on:** stop rewarding *absolute score*, start rewarding *marginal
improvement* — pay each miner in proportion to how much they improved the shared model
over its current state, measured on data they couldn't game. A non-improving copy earns
~zero. This also makes the system finally match its purpose: reward *making the model
better*, not *having a good model*.

**Decisions locked (this session):**
- Reward attribution lives **on-chain** (proportional to proven marginal improvement) — the payout stays trustless. The rigorous leave-one-out/Shapley analysis is shown in Science as *evidence*, not used for payout.
- Add a **distance bound** (submission must be a local refinement of the shared base), on top of marginal reward.
- **NOT** doing commit-reveal (rejected — keeps the single-tx flow).
- **NOT** touching the honesty/naming reframe yet ("Proof of Learning" → "Proof of Improvement" deferred to a later pass).
- **NOT** attempting the ZK-training-step ("real proof of learning") — documented as future work.

Era 2 is **not yet deployed** (cutover deferred), so all contract + circuit changes fold
in **before first deploy with no migration** — this is free to do now and expensive later.

## ⚠️ GATE RESULT (implemented 2026-06-12): param-commitment CUT, distance bound CUT

The plan below proposed making the circuit commit to its parameters
(`param_visibility="hashed"`) as a "cheap one more hash." **We built it and re-ran
the freeze pipeline — it is NOT cheap.** Hashing the model's 109k parameters in-circuit
(vs. the 6k input pixels) is ~17× more Poseidon work and pushed the proof from
**logrows 18 → 23** — a tens-of-GB proving key, infeasible on 16 GB RAM. The distance
bound needs even more in-circuit work, so it is also infeasible at this scale.

**What we shipped instead:** the existing logrows-18 param-private circuit is unchanged.
`TaskManagerV3` implements the marginal-improvement reward with the **base score
established by the task poster from a real on-chain-verified proof** on the block's
challenge. What stays trustless: the base score is a genuine proven score, every miner's
score, the split math, and the payout — all on-chain. The one disclosed assumption: the
poster's base proof uses the current global model (it commits the model's off-chain hash
in `modelHash` for audit). This is consistent with the operator already running the task
cadence; a fully-trustless base awaits a cheaper param-commitment scheme (future work).

Copycat-by-model dedup (which also needed the param-commitment) is dropped — but it's
moot: the proof nullifier still stops exact-proof replay, challenge-binding stops cross-
task replay, and under marginal reward a copy of the base model earns ~0 anyway.

The rest of this doc is the original plan; §"Design" is superseded by the above for the
param-commitment and distance-bound pieces. The reward mechanism shipped as designed.

---

## The honest cost correction (original reasoning — the gate confirmed the first half, refuted "cheap")

Weights are `param_visibility="private"` — they exist only as witness values, never
on-chain and never in the public instances. Consequences:

1. The contract **cannot** measure weight-distance directly (no weights to compare).
2. The contract **cannot** trust a "base score" — nothing ties any proof to a specific model.

Root fix for both: **make the circuit publicly commit to its parameters** via
`param_visibility="hashed"` — a Poseidon hash of the weights becomes a public instance,
exactly like the input-hash we already expose. Cheap (~one more hash). It unlocks:
- **Trustless base score**: the contract accepts a base reference proof iff its
  param-commitment == the task's committed `modelHash`.
- **Copycat-by-model dedup**: two submissions with the same param-commitment are the
  same model → reject the duplicate (complements the existing proof-bytes nullifier).

The **distance bound** needs *more*: the circuit must take the base weights as a witness,
verify `hash(base) == committed base`, compute `‖W − W_base‖² < ε`, and expose the result.
Bigger circuit change → split into its own phase, gated on the logrows budget.

## Design

### Circuit v2 (`zk/challenge_net.py`, re-freeze via spike)

- `param_visibility: "hashed"` → adds a public param-commitment instance.
- New instance layout: `[0]=input/challenge hash, [1]=param hash, [2..N*10+1]=logits`.
  `EXPECTED_INSTANCES = 2 + N*10` (was `1 + N*10`).
- **Distance phase (gated):** circuit also takes `W_base` (witness) + its public
  commitment, asserts the commitment matches, and exposes `dist_ok` (a public bool for
  `‖W−W_base‖² < ε`). Adds an instance.
- Re-run `zk/spike/run_spike.py` (gates G1/G4 especially) to confirm the added hash(es)
  don't push logrows past 18 / the verifier past EIP-170. **If distance blows the budget,
  ship param-hash-only and defer distance** (marginal reward already covers free-riding).
- Re-run `zk/challenge_pool.py` → new commitments (new circuit = new settings). Pre-deploy,
  this is ~6 min of compute, not a migration.
- New `zk/v2/` artifacts + new VKA.

### Contract v3 (`contracts/TaskManagerV3.sol`, or revise V2 in place)

Replace winner-take-all with proportional-by-marginal-improvement:

```
postTask(desc, threshold, reward, deadline, modelHash)   // modelHash = base param-commitment
establishBase(taskId, proof, instances, vka)             // anyone; sets baseScore iff
                                                         //   instances[paramHashIdx] == modelHash
submitWithProof(taskId, gradientHash, proof, instances, vka)
   1. instance-length / challenge-binding / proof-nullifier  (as today)
   2. param-commitment != base's  AND not already seen this task   (model dedup)
   3. [distance phase] require dist_ok == true
   4. score = argmax-count from logits   (as today)
   5. require score >= threshold; store {miner, score, paramHash, ...}
finalizeTask(taskId)                                     // permissionless
   marginal_i   = max(0, score_i - baseScore)
   total        = Σ marginal_i
   if total == 0: refund poster (nobody beat the base)
   else: pay each miner  reward * marginal_i / total     (push, CEI, small N)
```

- `baseScore` must be set before finalize; if unset, treat as 0 (every score is an
  improvement over a null base — degrades gracefully but the operator always posts the
  base proof, so this is the fallback only).
- Reward loop bounded by `MAX_PROVEN` (64) — gas fine.
- Tests (`test/TaskManagerV3.test.js`): base-score-from-committed-model, marginal split
  math, free-rider (near-base) earns ~0, two improvers split proportionally, nobody-beats-base
  refunds, copycat-model rejected, + all existing gauntlet cases ported.

### Off-chain flow

- `scripts/miningLoop.js`: after `postTask`, submit the **base reference proof** (current
  global model on the challenge) via the prover → `establishBase`. `modelHash` becomes the
  EZKL **param-commitment** (not the sha256 of the .pth file) so it matches the proof.
- `zk/server/era2.py`: expose the param-commitment from the witness; add a base-proof mode.
- `scripts/autoMiner.js`: unchanged in spirit (rotation prover + claimed fallback), but
  submissions now compete on marginal improvement, not absolute score.

### Frontend

- Chain / Mine: show each submission's **marginal improvement** and its **reward share**
  (e.g. "Δ +0.0 → 0 POL", "Δ +12 → 60 POL"), not a single WINNER badge. The "no single
  winner" model is the visible change.
- Mine settle screen: "you earned X POL for improving the model by Δ" instead of win/lose.
  (Loss-canonical framing softens — now everyone who improves earns something.)

### Science (off-chain rigor, evidence not payout)

- New experiment `zk/experiments/contribution.py` → `contribution.json`: leave-one-out
  and Shapley credit assignment over the N=4-5 miners on a **large** eval set (the
  fine-grained "correct" attribution), contrasted with the coarse on-chain proportional
  split. Card shows: "on-chain pays by 8-image marginal score (trustless, coarse); here's
  the rigorous large-eval attribution for comparison."
- Optional companion: `precompute.py` quantifying that marginal-reward defangs the
  static-precompute free-ride economically (a precomputed static model earns once, then ~0).

## Build phases

1. **Circuit v2 + re-freeze (gated).** `param_visibility="hashed"`; re-run spike G1/G4;
   re-run challenge_pool; new `zk/v2/` + VKA + fixtures. Gate: logrows ≤ 18, verifier < EIP-170.
2. **Distance bound (gated, optional).** Add base-weight witness + `dist_ok` to the circuit;
   re-run spike. If it blows the budget → defer, ship phase 1 + marginal reward only.
3. **Contract v3.** Proportional reward + `establishBase` + model dedup (+ distance check if
   phase 2 shipped). Full test suite incl. ported gauntlet.
4. **Off-chain flow.** miningLoop base-proof + param-commitment modelHash; prover param-hash
   exposure; autoMiner unchanged.
5. **Frontend.** Marginal-improvement + reward-share display; settle screen.
6. **Science.** contribution.py (leave-one-out/Shapley) + card; optional precompute.py.

Phases 1→3→4 are the critical path; 2/5/6 parallelize. All land **before** the Era-2 cutover.

## Risks

- **R1 — circuit budget:** param-hash + distance may push logrows past 18 → bigger proofs /
  verifier over EIP-170. *Mitigation:* phase 1 (param-hash) is one hash, low risk; phase 2
  (distance) is the risk — gated on a spike re-run, deferrable without losing the core win.
- **R2 — coarse reward:** at N=8, scores are multiples of 12.5%, so genuine sub-12.5%
  improvements register as marginal 0 and earn nothing. *Mitigation:* honest in UI; the
  large-eval contribution analysis in Science is the fine-grained companion; accept coarse
  for trustless on-chain payout.
- **R3 — redundancy-blind:** two miners making the same improvement both get paid (on-chain
  can't dedup *value*, only *model identity*). *Mitigation:* documented; Shapley in Science
  shows the redundancy-aware version. Not fixed on-chain by choice (trustlessness > fairness
  of split).
- **R4 — baseScore griefing:** if `establishBase` could be set by a low-scoring model, marginal
  inflates. *Mitigation:* param-commitment check ties baseScore to the exact committed model;
  can't be faked.

## Explicitly deferred (not in this plan)

- Honesty/naming reframe ("Proof of Learning" → "Proof of Improvement") — later pass.
- Commit-reveal (overfit-to-known-batch hardening) — rejected for now.
- ZK-training-step ("real proof of learning") — future research.
- Era-2 on-chain cutover — still the gated manual deploy, now downstream of this redesign.
