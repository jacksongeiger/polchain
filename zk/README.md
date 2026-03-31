# PoLChain ZK — Proof of Learning via Zero-Knowledge Inference

This folder contains a proof-of-concept showing how a miner can cryptographically prove they ran real model inference — without ever revealing their model weights.

---

## Files

### `model.py`
Trains a 2-layer PyTorch neural network (`16 → 8 → 1`) for binary sentiment classification and exports it to `model.onnx`.

**Input:** a 16-element float vector of text features (word counts, sentiment ratios, structural signals), all normalised to `[-1, 1]`.

**Output:** a raw logit. The score used on-chain is computed externally as `round(sigmoid(logit) * 100)`, giving an integer in `[0, 100]`.

The final Sigmoid is intentionally excluded from the ONNX export. EZKL builds lookup tables for every nonlinear operation in the circuit; keeping only ReLU (which has a small, bounded range) makes the circuit feasible to prove in seconds rather than minutes.

Weight regularisation (`weight_decay=0.05`) is applied during training to keep all weights below ~0.4 in absolute value. Large weights cause EZKL's fixed-point quantisation to overflow, so bounded weights are a hard requirement for ZK-provable models.

Run: `python3 model.py` → produces `model.onnx`

---

### `prove.py`
Uses [EZKL](https://github.com/zkonduit/ezkl) to generate a ZK proof that a specific input was run through `model.onnx` and produced a specific output.

**The key visibility configuration:**

```python
py_run_args.input_visibility  = "public"   # feature vector is visible
py_run_args.output_visibility = "public"   # inference score is visible
py_run_args.param_visibility  = "private"  # model weights are HIDDEN
```

This is the core of the Proof of Learning primitive: the feature vector and score appear in the proof as public inputs, but the circuit commits to the weights cryptographically without disclosing them. A verifier can confirm the score is correct without learning anything about the model.

**Pipeline (7 steps):**
1. Write `input.json` (the feature vector)
2. `gen_settings` — determine circuit parameters
3. `calibrate_settings` — find optimal fixed-point quantisation scale
4. `compile_circuit` — translate the ONNX graph into an arithmetic circuit
5. `get_srs` — fetch the KZG structured reference string (trusted setup, downloaded once)
6. `setup` — generate the proving key (`pk.key`) and verifying key (`vk.key`)
7. `gen_witness` + `prove` — execute the circuit and produce `proof.json`

A final `verify` call confirms the proof is valid using only `proof.json`, `settings.json`, and `vk.key` — no model file needed.

Run: `python3 prove.py` → produces `proof.json`

---

### `proof.json`
The output proof. Contains the KZG polynomial commitments and the public inputs/outputs (feature vector + logit). The model weights are bound into the circuit but never appear in this file.

---

## How This Connects to PoLChain

In the PoLChain protocol, miners call `submitWork(taskId, gradientHash, score)` on the `TaskManager` contract. The `score` is self-reported — currently there is no on-chain enforcement that the score reflects real computation.

ZK inference closes that gap:

| Step | What happens |
|---|---|
| Miner trains a model | Real gradient descent, proprietary weights |
| Miner runs `prove.py` on the evaluation input | Produces `proof.json` with the honest score |
| Miner submits `(taskId, keccak256(proof), score)` on-chain | Score is now ZK-backed |
| Anyone calls `verify` off-chain (or on-chain via EVM verifier) | Proof confirms the score without seeing the weights |

The `gradientHash` field in `submitWork` is designed to hold exactly this kind of commitment — the hash of the proof, the model checkpoint, or both.

### Why private weights matter

A miner's trained model represents real work: GPU compute, data curation, hyperparameter tuning. Publishing the weights would let competitors free-ride on that work. ZK inference lets the miner prove their result is honest while keeping the weights as a competitive asset — the same way a lock manufacturer can prove a key fits a lock without revealing the lock's internal mechanism.

### Current limitations of this PoC

- **Synthetic data.** The model is trained on procedurally generated features, not real SST-2 text. A production PoL system would need a shared feature extractor (e.g., a frozen BERT embedding layer) so that input vectors are reproducible from raw text.
- **No on-chain verifier.** EZKL can export a Solidity verifier contract via `create_evm_verifier`. Integrating that into `TaskManager` would allow `finalizeTask` to require a valid proof before paying out the reward.
- **Single inference.** The proof covers one forward pass. Proving that a model was *trained* (rather than just run) requires recursive proof systems (e.g., Nova) and is an open research problem.

---

## Setup

```bash
pip install torch onnx ezkl onnxruntime

# Train and export
python3 model.py

# Generate ZK proof
python3 prove.py
```

EZKL downloads the KZG SRS on first run (~a few MB). Subsequent runs reuse the cached file.
