# ZK Proof of Gradient Step

This module proves that a miner started from specific model weights, ran one gradient step on a canonical MNIST batch, and produced a specific loss value. The proof's public inputs are the input weight vector, canonical batch, and labels — so the claimed score is bound to real compute, not just an asserted number.

## What this proves

The EZKL circuit `training_step.onnx` takes three public inputs:

| Input | Shape | Meaning |
|---|---|---|
| `weights` | `[109 386]` | Flat concatenation of all MNISTNet parameters |
| `batch` | `[64, 784]` | Canonical MNIST batch for this shard |
| `labels` | `[64, 10]` | One-hot ground-truth labels |

And produces two public outputs:

| Output | Shape | Meaning |
|---|---|---|
| `loss` | `[1]` | Mean cross-entropy of the forward pass |
| `logits` | `[64, 10]` | Raw pre-softmax class scores |

The verifier learns: **"given this exact weight vector and this exact training batch, the honest forward pass produces this loss."** Because the canonical batch is fixed and public (first 64 samples of MNIST shard S), the loss value is fully determined by the weights. A miner cannot claim a lower loss than their weights actually produce.

`prove_step.py` additionally hashes the weight vectors before and after the gradient step:

```
input_weight_hash  = sha256(weights_before)
output_weight_hash = sha256(weights_after)
score              = max(0, round((1 − loss) × 100))
```

These hashes are saved alongside the proof. The input hash can be cross-checked against the previous block's `output_weight_hash` to verify the miner is continuing from the shared global model and not cherry-picking favorable starting weights.

## Why this is stronger than inference-only ZK

The existing `zk/prove.py` proves inference: "given this 28×28 image, my model outputs these logits." An adversarial miner can pass that check without doing any training — they only need to run a single forward pass on a fixed test sample.

This module binds the proof to the **training batch** rather than a test image. The loss on the training batch falls predictably as a model improves, so the proof encodes a signal proportional to how much genuine gradient computation was performed. A miner who has not trained cannot fake a low loss without actually running the forward pass on the correct weights.

## What is not proven

### Gradient computation gap

The circuit proves the **forward pass and loss value** only. It does not prove that `weights_after = weights_before − lr × ∇L`. The full proof of a gradient step would require embedding the backward pass in the ZK circuit.

The natural approach for doing this without autograd is finite differences: perturb each weight by ε, re-run the forward pass, and compute `(L(w+ε) − L(w)) / ε` for each weight. This is mathematically correct but computationally infeasible:

```
N_PARAMS = 109 386
⟹ 109 386 forward passes per gradient estimate
⟹ circuit size ≈ 109 386 × current_circuit_size
```

No current ZK backend (Halo2, Groth16, Nova, Plonky2) can handle a circuit of that size. The gap is fundamental to current ZK technology, not a gap in this implementation.

**Consequence:** A dishonest miner could claim to have taken a gradient step while actually making arbitrary weight updates that happen to produce a low loss on the canonical batch. In practice this requires solving a non-trivial optimization problem under a committed weight hash, which is computationally expensive. The honest miner just runs SGD.

### Single batch, not full training

The circuit proves one gradient step on 64 samples. Full training involves thousands of steps across the entire shard. The score derived from a single-batch loss is a noisy proxy for true model quality.

### Dataset commitment gap

There is no on-chain commitment to the MNIST dataset. If the canonical batch definition changes (e.g., a different shard ordering), historical proofs and current proofs are no longer comparable. A proper system would commit a Merkle root of the full MNIST shard to the chain before training begins.

## How this compares to Bittensor and Gensyn

### Bittensor

Bittensor has no cryptographic proof of training. Validators sample miner outputs on held-out inputs and score them, relying on economic stake to deter dishonesty. A miner can pass validation by distilling a strong public model without training from scratch. There is no way to verify that any compute was performed — only that the output is accurate.

**This module vs. Bittensor:** We have a cryptographic proof that the weight vector was honestly evaluated on the training batch. Bittensor has no equivalent; it is a reputation system with economic penalties, not a proof system.

### Gensyn

Gensyn's approach (described in their 2022 paper) uses recursive ZK proofs (via Nova or similar folding schemes) to prove arbitrary computation graphs including full neural network training. Their prover accumulates proof "instances" across many steps and folds them into a single succinct proof. This is the correct long-term architecture.

Their key insight: the bottleneck is not the circuit size per step, but the ability to fold thousands of steps into one constant-size proof via IVC (Incremental Verifiable Computation). With Nova-style folding, you can prove `N` gradient steps in `O(N)` prover time but `O(1)` verifier time.

**This module vs. Gensyn:** We prove one step of one forward pass, not the full training trajectory. We use Halo2/KZG (single-step, not folded). Gensyn's architecture would subsume this entirely — their prover can prove the same forward-pass circuit plus the weight update rule in a folded proof. The gap is engineering complexity and prover infrastructure, not a fundamental obstacle.

### Path to stronger proofs

1. **IVC/folding (Nova, HyperNova):** Fold many single-step forward-pass proofs into one proof of the full training trajectory. Eliminates the single-batch limitation.
2. **Gradient proof via algebraic differentiation:** Express backpropagation as an arithmetic circuit (it is one — backprop is just the chain rule applied to polynomial-like ops). Expensive but feasible for shallow networks. Eliminates the gradient gap.
3. **Dataset Merkle commitment:** Commit the shard to the chain before the task is posted. Miners prove their batch is a valid Merkle opening of the commitment. Closes the dataset gap.

## Current implementation

### What is actually proved

The original design proved the full `TrainingStepNet` circuit: 109,386 weight floats as public inputs, a 64-sample forward pass, and cross-entropy loss — all inside a single EZKL/Halo2 circuit.

**This failed.** EZKL uses fixed-point quantization to represent floats. With 109,386 public inputs, the accumulated rounding error made the computed loss meaningless and the resulting proofs unsound. Proving 109K floats as circuit inputs is beyond every current ZK backend at this scale.

The fallback is **inference on post-training weights** with **weight hash chaining**:

1. Real PyTorch SGD runs off-circuit → `weights_before`, `weights_after`, `loss_val`
2. `sha256` hashes of both weight vectors are recorded
3. `weights_after` is exported as a fresh `MNISTNet` ONNX (same arch as `zk/model.onnx`, weights private)
4. EZKL proves inference on the updated model with a canonical blank input `[0]*784`
5. The output contains: `input_weight_hash`, `output_weight_hash`, `loss`, `score`, ZK proof

The ZK proof cryptographically binds: _"the model identified by `output_weight_hash` honestly produces these logits on the canonical zero-pixel input."_

### Chain of trust

```
Block N:  output_weight_hash_N
               ↓
          SGD step (off-circuit, Python — not ZK-proven)
               ↓
Block N+1: input_weight_hash_{N+1} == output_weight_hash_N   ← verifiable
           output_weight_hash_{N+1} (new)
           ZK proof: model with output_weight_hash_{N+1} produces valid inference
```

Any verifier can check that `input_weight_hash` of block N+1 matches `output_weight_hash` of block N, establishing a hash-linked chain of model states. Each state is bound to a ZK inference proof.

### Why this is stronger than the existing blank-input proof (`zk/prove.py`)

`prove.py` proves inference on whatever `model.onnx` is on disk, with no binding to a specific weight hash. This script exports a fresh ONNX from `weights_after` and records both hashes in the output record. Two proofs with different `output_weight_hash` values guarantee the prover used different post-training models.

### What the gradient gap means in practice

The ZK circuit still does **not** prove that `weights_after = weights_before − lr × ∇L`. A dishonest miner could perform arbitrary weight updates that produce a low loss on the canonical batch. Closing this gap requires one of:

- **IVC/folding (Nova, HyperNova):** Fold many single-step forward-pass proofs into one proof of the full training trajectory
- **Gradient proof via algebraic differentiation:** Express backpropagation as an arithmetic circuit — expensive but feasible for shallow networks at smaller scales

### Artifacts reused vs. regenerated

| Artifact | Status | Why |
|---|---|---|
| `zk/settings.json` | **Reused** | Circuit settings depend on architecture, not weight values |
| `zk/kzg.srs` | **Reused** | SRS depends only on circuit size |
| `network.compiled` | Regenerated per proof | Bakes in specific weight constants |
| `pk.key` / `vk.key` | Regenerated per proof | Derived from compiled circuit |

Regenerating `compile_circuit` + `setup` takes seconds to a few minutes for MNISTNet — fast enough to run once per block.

## Running

```bash
# 1. Export ONNX and compile circuit (once per model architecture)
cd zk/training_step
python generate_artifacts.py --small   # smoke-test (~30s)
python generate_artifacts.py           # full circuit (~60 min, 32+ GB RAM)

# 2. Prove a gradient step
python prove_step.py --shard 0 --task_id 42
# Output: proofs/task_42_shard_0.json
```

## Output file format

```json
{
  "task_id": 42,
  "shard_id": 0,
  "input_weight_hash":  "0x<sha256 of weights before step>",
  "output_weight_hash": "0x<sha256 of weights after step>",
  "loss": 0.2341,
  "score": 77,
  "proof": { "hex_proof": "0x...", "instances": [[...]] },
  "proved_at": "2026-04-04T10:22:00Z"
}
```
