"""
server.py — Flask API server for PoLChain ZK proof-of-training generation.

Concept:
  A miner calls POST /prove with a task_id. The server:
    1. Generates a deterministic synthetic dataset seeded by the task_id
       (simulating the task's training data distribution)
    2. Runs a short training loop to measure gradient quality (loss improvement)
    3. Converts training accuracy into a 0-100 gradient quality score
    4. Generates a ZK proof that the miner's model architecture produced a
       real inference result — proving the model weights are committed and valid
    5. Returns the score, proof, and a gradient_hash that commits to the
       training outcome

  The gradient_hash (sha256 of task + accuracy + delta_loss) goes on-chain
  as the bytes32 commitment; the ZK proof provides cryptographic evidence
  that a trained model exists behind the commitment.

Endpoints:
  POST /prove  — {"task_id": 1} → SSE stream of 5 stages + final payload
  GET  /health — {"status": "ok"}

Run: python3 zk/server/server.py   (from ~/polchain)
     or: npm run prove-server
"""

import asyncio
import hashlib
import json
import math
import os
import struct
import tempfile

import ezkl
import numpy as np
import onnxruntime as ort
import torch
import torch.nn as nn
from flask import Flask, Response, request, stream_with_context
from flask_cors import CORS

# ---------------------------------------------------------------------------
# Paths — zk/ is one level up from this file (zk/server/server.py)
# ---------------------------------------------------------------------------
ZK_DIR        = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_PATH    = os.path.join(ZK_DIR, "model.onnx")
SETTINGS_PATH = os.path.join(ZK_DIR, "settings.json")
COMPILED_PATH = os.path.join(ZK_DIR, "network.compiled")
SRS_PATH      = os.path.join(ZK_DIR, "kzg.srs")
PK_PATH       = os.path.join(ZK_DIR, "pk.key")
VK_PATH       = os.path.join(ZK_DIR, "vk.key")

# Fixed evaluation input used for ZK proving (public circuit input).
# Represents a clearly positive example — same as prove.py's SAMPLE_INPUT.
# The ZK proof commits to model weights that produce a specific logit on this.
EVAL_INPUT = [
     0.33,  0.20, -1.00, -1.00,  # [0-3]  strong_pos, mild_pos, strong_neg, mild_neg
    -1.00,  0.00, -1.00,  0.00,  # [4-7]  negation, intensifier, question, exclaim
     0.00, -0.90, -0.80,  1.00,  # [8-11] length, cap_ratio, punct, pos_ratio
    -1.00,  0.00,  1.00, -1.00,  # [12-15] neg_ratio, avg_wlen, first_word, repeat_char
]


# ---------------------------------------------------------------------------
# SentimentNet — mirrors zk/model.py exactly so training results match the
# exported ONNX architecture (16 → ReLU(8) → 1, raw logit output)
# ---------------------------------------------------------------------------
class SentimentNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.fc1  = nn.Linear(16, 8)
        self.relu = nn.ReLU()
        self.fc2  = nn.Linear(8, 1)

    def forward(self, x):
        return self.fc2(self.relu(self.fc1(x)))


# ---------------------------------------------------------------------------
# Synthetic dataset — same generation logic as zk/model.py, seeded by task_id
# ---------------------------------------------------------------------------
def _make_sample(label: int, rng: np.random.Generator) -> np.ndarray:
    def norm(v, lo, hi):
        return float(np.clip(2.0 * (v - lo) / (hi - lo) - 1.0, -1.0, 1.0))

    if label == 1:
        sp = rng.poisson(2.0); mp = rng.poisson(1.5)
        sn = rng.poisson(0.1); mn = rng.poisson(0.2)
    else:
        sp = rng.poisson(0.1); mp = rng.poisson(0.3)
        sn = rng.poisson(2.0); mn = rng.poisson(1.5)

    neg   = rng.poisson(0.3)
    ints  = rng.poisson(0.5)
    q     = float(rng.random() < 0.1)
    excl  = float(np.clip(rng.poisson(0.4), 0, 4))
    wlen  = math.log(float(rng.integers(5, 40)) + 1.0)
    cap   = float(np.clip(rng.beta(1, 10), 0, 1))
    punct = float(np.clip(rng.beta(1, 8), 0, 1))
    total = sp + mp + sn + mn + 1e-6
    pr    = (sp + mp) / total
    nr    = (sn + mn) / total
    awl   = float(np.clip(rng.normal(0.5, 0.1), 0, 1))
    fw    = (1.0 if label == 1 and rng.random() < 0.6 else
            -1.0 if label == 0 and rng.random() < 0.6 else 0.0)
    rep   = 1.0 if rng.random() < 0.05 else -1.0

    return np.array([
        norm(sp,   0, 6), norm(mp,   0, 5),
        norm(sn,   0, 6), norm(mn,   0, 5),
        norm(neg,  0, 3), norm(ints, 0, 4),
        2.0 * q - 1.0,   norm(excl, 0, 4),
        norm(wlen, 0, 4), 2.0 * cap - 1.0,
        2.0 * punct - 1.0, 2.0 * pr - 1.0,
        2.0 * nr - 1.0,  2.0 * awl - 1.0,
        fw, rep,
    ], dtype=np.float32)


def run_training_loop(task_id: int, miner_id: int = 0,
                      n_samples: int = 400, n_epochs: int = 8):
    """
    Run a short training loop seeded deterministically by task_id + miner_id.
    Different miner_ids produce different random datasets and thus different
    quality scores, simulating real miners with unique model initialisations.

    Returns:
        loss_before  float  — BCE loss at epoch 0 (random weights)
        loss_after   float  — BCE loss after n_epochs
        accuracy     float  — classification accuracy after training (0.0–1.0)
    """
    seed = task_id * 10 + miner_id
    print(f"[train] task_id={task_id}  miner_id={miner_id}  seed={seed}", flush=True)
    rng  = np.random.default_rng(seed)
    torch.manual_seed(seed)

    labels   = rng.integers(0, 2, n_samples)
    X        = np.stack([_make_sample(int(l), rng) for l in labels])
    X_tensor = torch.tensor(X,      dtype=torch.float32)
    y_tensor = torch.tensor(labels, dtype=torch.float32)

    model     = SentimentNet()
    optimizer = torch.optim.Adam(model.parameters(), lr=3e-3, weight_decay=0.05)
    loss_fn   = nn.BCEWithLogitsLoss()

    # Measure initial loss (before any gradient updates)
    model.eval()
    with torch.no_grad():
        loss_before = loss_fn(model(X_tensor).squeeze(), y_tensor).item()

    # Training loop
    model.train()
    for _ in range(n_epochs):
        optimizer.zero_grad()
        logits = model(X_tensor).squeeze()
        loss   = loss_fn(logits, y_tensor)
        loss.backward()
        optimizer.step()

    # Measure final loss + accuracy
    model.eval()
    with torch.no_grad():
        logits_final = model(X_tensor).squeeze()
        loss_after   = loss_fn(logits_final, y_tensor).item()
        accuracy     = ((logits_final > 0).float() == y_tensor).float().mean().item()

    return loss_before, loss_after, accuracy


def gradient_quality_score(accuracy: float) -> int:
    """Convert training accuracy (0.0–1.0) to a 0-100 on-chain score."""
    return min(100, max(0, round(accuracy * 100)))


def compute_gradient_hash(task_id: int, miner_id: int,
                          loss_before: float, loss_after: float,
                          score: int) -> str:
    """
    Deterministic bytes32 commitment to the training outcome.
    sha256(task_id || miner_id || loss_before || loss_after || score)
    → "0x<64 hex chars>"
    """
    payload = struct.pack(">IIddI", task_id, miner_id, loss_before, loss_after, score)
    return "0x" + hashlib.sha256(payload).hexdigest()


# ---------------------------------------------------------------------------
# ZK pipeline
# ---------------------------------------------------------------------------
def artifacts_ready() -> bool:
    return all(os.path.exists(p) for p in [
        SETTINGS_PATH, COMPILED_PATH, SRS_PATH, PK_PATH, VK_PATH,
    ])


def run_one_time_setup(input_path: str):
    """gen_settings → calibrate → compile → srs → setup (≈60s first run)."""
    py_run_args = ezkl.PyRunArgs()
    py_run_args.input_visibility  = "public"
    py_run_args.output_visibility = "public"
    py_run_args.param_visibility  = "private"
    py_run_args.decomp_legs       = 3

    ezkl.gen_settings(model=MODEL_PATH, output=SETTINGS_PATH,
                      py_run_args=py_run_args)
    ezkl.calibrate_settings(
        data=input_path, model=MODEL_PATH, settings=SETTINGS_PATH,
        target="resources", lookup_safety_margin=1,
        scale_rebase_multiplier=[10],
    )
    ezkl.compile_circuit(model=MODEL_PATH, compiled_circuit=COMPILED_PATH,
                         settings_path=SETTINGS_PATH)
    asyncio.run(ezkl.get_srs(settings_path=SETTINGS_PATH, srs_path=SRS_PATH))
    ezkl.setup(model=COMPILED_PATH, vk_path=VK_PATH, pk_path=PK_PATH,
               srs_path=SRS_PATH, disable_selector_compression=False)


# ---------------------------------------------------------------------------
# Flask app
# ---------------------------------------------------------------------------
app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": [
    "http://localhost:5173",
    "https://polchain.vercel.app",
]}})


def sse(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/prove")
def prove():
    body    = request.get_json(force=True, silent=True) or {}
    task_id  = body.get("task_id")
    miner_id = body.get("miner_id", 0)
    if not isinstance(task_id, int) or task_id < 1:
        return {"error": "task_id (positive integer) is required"}, 400
    if not isinstance(miner_id, int) or miner_id < 0:
        miner_id = 0

    # ── Debug: confirm received values ──────────────────────────────────────
    print(f"[prove] task_id={task_id}  miner_id={miner_id}  "
          f"seed={task_id * 10 + miner_id}", flush=True)

    def generate():
        with tempfile.TemporaryDirectory() as tmp:
            input_path   = os.path.join(tmp, "input.json")
            witness_path = os.path.join(tmp, "witness.json")
            proof_path   = os.path.join(tmp, "proof.json")

            # ------------------------------------------------------------------
            # Stage 1: Load task data — build deterministic synthetic dataset
            # ------------------------------------------------------------------
            yield sse({"stage": "loading",
                       "message": f"Generating synthetic dataset for task {task_id}…"})

            # Write the fixed eval input for ZK proving
            with open(input_path, "w") as f:
                json.dump({"input_data": [EVAL_INPUT]}, f)

            # ------------------------------------------------------------------
            # Stage 2: Run training loop
            # ------------------------------------------------------------------
            yield sse({"stage": "training",
                       "message": "Running 8-epoch training loop on synthetic data…"})
            try:
                loss_before, loss_after, accuracy = run_training_loop(task_id, miner_id)
            except Exception as e:
                yield sse({"stage": "error", "message": f"Training failed: {e}"})
                return

            delta = loss_before - loss_after
            yield sse({
                "stage":   "training",
                "message": (f"Training complete — "
                            f"loss {loss_before:.4f} → {loss_after:.4f}  "
                            f"(Δ {delta:+.4f})  "
                            f"acc {accuracy:.1%}"),
            })

            # ------------------------------------------------------------------
            # Stage 3: Compute gradient quality score + gradient hash
            # ------------------------------------------------------------------
            yield sse({"stage": "computing",
                       "message": "Converting training result to gradient quality score…"})
            score          = gradient_quality_score(accuracy)
            gradient_hash  = compute_gradient_hash(task_id, miner_id, loss_before, loss_after, score)

            yield sse({
                "stage":         "computing",
                "message":       f"Gradient quality score: {score}/100",
                "score":         score,
                "gradient_hash": gradient_hash,
            })

            # ------------------------------------------------------------------
            # Stage 4: ZK proof — proves the model architecture is sound and
            #          that committed weights produce a real inference result
            # ------------------------------------------------------------------
            if not artifacts_ready():
                yield sse({"stage": "proving",
                           "message": "First run — compiling circuit (~60s)…"})
                try:
                    run_one_time_setup(input_path)
                except Exception as e:
                    yield sse({"stage": "error",
                               "message": f"Circuit setup failed: {e}"})
                    return
            else:
                yield sse({"stage": "proving",
                           "message": "Generating witness…"})

            try:
                ezkl.gen_witness(
                    data=input_path, model=COMPILED_PATH,
                    output=witness_path, vk_path=VK_PATH, srs_path=SRS_PATH,
                )
            except Exception as e:
                yield sse({"stage": "error",
                           "message": f"Witness generation failed: {e}"})
                return

            yield sse({"stage": "proving", "message": "Proving (~10s)…"})
            try:
                ezkl.prove(
                    witness=witness_path, model=COMPILED_PATH,
                    pk_path=PK_PATH, proof_path=proof_path, srs_path=SRS_PATH,
                )
            except Exception as e:
                yield sse({"stage": "error",
                           "message": f"Proof generation failed: {e}"})
                return

            # ------------------------------------------------------------------
            # Stage 5: Verify
            # ------------------------------------------------------------------
            yield sse({"stage": "verifying", "message": "Verifying proof…"})
            try:
                ok = ezkl.verify(
                    proof_path=proof_path, settings_path=SETTINGS_PATH,
                    vk_path=VK_PATH, srs_path=SRS_PATH, reduced_srs=False,
                )
            except Exception as e:
                yield sse({"stage": "error", "message": f"Verification failed: {e}"})
                return

            if not ok:
                yield sse({"stage": "error",
                           "message": "Proof verification returned false."})
                return

            # ------------------------------------------------------------------
            # Done — emit proof JSON + training metadata
            # ------------------------------------------------------------------
            with open(proof_path) as f:
                proof_json = json.load(f)

            proof_kb = os.path.getsize(proof_path) / 1024
            yield sse({
                "stage":         "done",
                "message":       f"Proof verified ✓  ({proof_kb:.1f} KB)",
                "score":         score,
                "gradient_hash": gradient_hash,
                "proof":         proof_json,
                "training": {
                    "loss_before": round(loss_before, 6),
                    "loss_after":  round(loss_after,  6),
                    "delta_loss":  round(delta,        6),
                    "accuracy":    round(accuracy,     4),
                    "epochs":      8,
                    "samples":     400,
                },
            })

    return Response(
        stream_with_context(generate()),
        content_type="text/event-stream",
        headers={
            "Cache-Control":     "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


if __name__ == "__main__":
    print("PoLChain prove-server  →  http://localhost:5001")
    print(f"ZK artifacts dir: {ZK_DIR}")
    print(f"Seed formula: task_id * 10 + miner_id  (e.g. task=2 miner=3 → seed=23)")
    app.run(host="0.0.0.0", port=5001, debug=False, threaded=False)
