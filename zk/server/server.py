"""
server.py — Flask API for PoLChain MNIST proof-of-training.

Endpoints:
  GET  /health              — {"status": "ok"}
  POST /train               — fast training (no ZK), returns score + gradient_hash
  POST /prove               — full ZK proof pipeline, SSE stream
  POST /prove/async         — start proof in background, returns {job_id}
  GET  /prove/status/<id>   — poll job: {status, proof, score, gradient_hash}
  GET  /jobs                — all recent proof jobs (for UI status display)
  POST /simulate            — 4 miners concurrently, SSE stream
  GET  /accuracy            — returns contents of accuracy_log.json
  GET  /accuracy_by_class   — per-digit accuracy + miner digit assignments
  POST /predict             — {"pixels": [784 floats 0-1]} → digit + confidences

Run: python3 zk/server/server.py   (from ~/polchain)
     or: npm run prove-server
"""

import asyncio
import hashlib
import json
import os
import queue as _queue
import struct
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid

import ezkl
import numpy as np
import torch
import torch.nn as nn
from flask import Flask, Response, request, stream_with_context
from flask_cors import CORS

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
ZK_DIR        = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_PATH    = os.path.join(ZK_DIR, "model.onnx")
SETTINGS_PATH = os.path.join(ZK_DIR, "settings.json")
COMPILED_PATH = os.path.join(ZK_DIR, "network.compiled")
SRS_PATH      = os.path.join(ZK_DIR, "kzg.srs")
PK_PATH       = os.path.join(ZK_DIR, "pk.key")
VK_PATH       = os.path.join(ZK_DIR, "vk.key")
LOG_PATH      = os.path.join(ZK_DIR, "accuracy_log.json")
GLOBAL_MODEL  = os.path.join(ZK_DIR, "global_model.pth")

# Fixed evaluation input for ZK circuit: blank (all-zero) 28×28 canvas.
EVAL_INPUT = [0.0] * 784

# Per-miner augmentation strategies (keyed by shard_id = miner_id % 4)
AUGMENTATION_STRATEGIES = {
    0: {
        "name":        "rotation",
        "label":       "Random Rotation ±15°",
        "description": "Rotates each digit image by a random angle up to ±15° every epoch, "
                       "teaching the model rotation invariance.",
    },
    1: {
        "name":        "noise",
        "label":       "Gaussian Noise σ=0.1",
        "description": "Adds Gaussian noise (σ=0.1) to pixel values each epoch, "
                       "improving robustness to noisy or corrupted inputs.",
    },
    2: {
        "name":        "erasing",
        "label":       "Random Erasing 10–20%",
        "description": "Zeros out a random rectangular patch covering 10–20% of pixels each epoch, "
                       "training the model to handle occlusion.",
    },
    3: {
        "name":        "none",
        "label":       "Clean Training",
        "description": "No augmentation — pure gradient descent on the MNIST shard. "
                       "Provides a clean baseline for comparison.",
    },
}

# ---------------------------------------------------------------------------
# Import MNISTNet from model.py
# ---------------------------------------------------------------------------
sys.path.insert(0, ZK_DIR)
from model import MNISTNet, get_shards, train_shard   # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def gradient_quality_score(accuracy: float) -> int:
    """Convert accuracy (0.0–1.0) to 0-100 on-chain score."""
    return min(100, max(0, round(accuracy * 100)))


def compute_gradient_hash(task_id: int, miner_id: int, score: int) -> str:
    """Deterministic bytes32 commitment: sha256(task_id || miner_id || score)."""
    payload = struct.pack(">III", task_id, miner_id, score)
    return "0x" + hashlib.sha256(payload).hexdigest()


def _fetch_focus_digits(shard_id: int):
    """
    Call GET /accuracy_by_class (self) to get the digit assignments for this shard.
    Returns a list of digit ints, or None if the endpoint is unreachable.
    """
    try:
        with urllib.request.urlopen(
            "http://localhost:5001/accuracy_by_class", timeout=5
        ) as resp:
            data = json.loads(resp.read())
        if data.get("ok"):
            assignments = data.get("assignments", {})
            # JSON keys are strings; try both str and int key
            digits = assignments.get(str(shard_id)) or assignments.get(shard_id)
            if digits:
                print(f"[train] focus_digits for shard {shard_id}: {digits}", flush=True)
                return [int(d) for d in digits]
    except Exception as e:
        print(f"[train] /accuracy_by_class unreachable — no focus_digits: {e}", flush=True)
    return None


def run_training(task_id: int, miner_id: int, n_epochs: int = 3):
    """
    Train on miner's shard (miner_id → shard_id directly).
    Seed = task_id * 10 + miner_id for reproducibility.
    Returns: (accuracy, score, gradient_hash, strategy_dict)
    """
    shard_id = miner_id % 4
    seed     = task_id * 10 + miner_id
    strategy = AUGMENTATION_STRATEGIES[shard_id]
    print(f"[train] task_id={task_id}  miner_id={miner_id}  "
          f"shard={shard_id}  aug={strategy['name']}  seed={seed}", flush=True)

    initial_state = None
    if os.path.exists(GLOBAL_MODEL):
        initial_state = torch.load(GLOBAL_MODEL, map_location="cpu")
        print(f"[train] warm-starting from {GLOBAL_MODEL}", flush=True)

    focus_digits = _fetch_focus_digits(shard_id)

    _, accuracy = train_shard(shard_id, n_epochs=n_epochs, seed=seed,
                              initial_state=initial_state,
                              augmentation=strategy["name"],
                              focus_digits=focus_digits)
    score = gradient_quality_score(accuracy)
    gh    = compute_gradient_hash(task_id, miner_id, score)
    print(f"[train] miner_id={miner_id}  acc={accuracy:.3f}  score={score}", flush=True)
    return accuracy, score, gh, strategy


# ---------------------------------------------------------------------------
# ZK pipeline helpers
# ---------------------------------------------------------------------------
def artifacts_ready() -> bool:
    return all(os.path.exists(p) for p in [
        SETTINGS_PATH, COMPILED_PATH, SRS_PATH, PK_PATH, VK_PATH,
    ])


def run_one_time_setup(input_path: str):
    """gen_settings → calibrate → compile → srs → setup."""
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

_ezkl_lock = threading.Lock()

# ---------------------------------------------------------------------------
# Async proof job store
# ---------------------------------------------------------------------------
_jobs: dict = {}       # job_id -> job dict
_jobs_lock = threading.Lock()


def sse(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


# ── /health ─────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}


# ── /train — fast training, no ZK ───────────────────────────────────────────

@app.post("/train")
def train():
    body     = request.get_json(force=True, silent=True) or {}
    task_id  = body.get("task_id")
    miner_id = body.get("miner_id", 0)

    if not isinstance(task_id, int) or task_id < 1:
        return {"ok": False, "error": "task_id (positive int) required"}, 400
    if not isinstance(miner_id, int) or not 0 <= miner_id < 4:
        miner_id = 0

    try:
        accuracy, score, gh, strategy = run_training(task_id, miner_id, n_epochs=3)
        return {
            "ok":            True,
            "score":         score,
            "gradient_hash": gh,
            "accuracy":      round(accuracy, 4),
            "augmentation":  strategy,
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}, 500


# ── /accuracy — return accuracy log ─────────────────────────────────────────

@app.get("/accuracy")
def accuracy():
    if not os.path.exists(LOG_PATH):
        return {"ok": True, "log": []}
    try:
        with open(LOG_PATH) as f:
            log = json.load(f)
        return {"ok": True, "log": log}
    except Exception as e:
        return {"ok": False, "error": str(e)}, 500


# ── /accuracy_by_class — per-digit accuracy + miner digit assignments ────────

@app.get("/accuracy_by_class")
def accuracy_by_class():
    """
    Evaluate the global model on the test set, compute per-digit accuracy,
    then assign digits to miners by weakness:
      miner 0 → 3 weakest digits   (most room to improve)
      miner 1 → next 3
      miner 2 → next 2
      miner 3 → 2 strongest digits
    """
    try:
        net = MNISTNet()
        if os.path.exists(GLOBAL_MODEL):
            net.load_state_dict(torch.load(GLOBAL_MODEL, map_location="cpu"))
        net.eval()

        _, X_test, y_test = get_shards()

        with torch.no_grad():
            preds = net(X_test).argmax(1)

        per_class = {}
        for digit in range(10):
            mask = (y_test == digit)
            if mask.sum() > 0:
                acc = (preds[mask] == digit).float().mean().item()
            else:
                acc = 0.0
            per_class[digit] = round(acc, 4)

        # Sort digits weakest → strongest
        sorted_digits = sorted(range(10), key=lambda d: per_class[d])

        # Distribute to miners (shard 0 gets hardest digits to focus on)
        assignments = {
            0: sorted_digits[0:3],   # 3 weakest
            1: sorted_digits[3:6],   # next 3
            2: sorted_digits[6:8],   # next 2
            3: sorted_digits[8:10],  # 2 strongest
        }

        return {"ok": True, "per_class": per_class, "assignments": assignments}

    except Exception as e:
        return {"ok": False, "error": str(e)}, 500


# ── /predict — run digit inference ──────────────────────────────────────────

@app.post("/predict")
def predict():
    body   = request.get_json(force=True, silent=True) or {}
    pixels = body.get("pixels")

    if not isinstance(pixels, list) or len(pixels) != 784:
        return {"ok": False, "error": "pixels must be a list of 784 floats"}, 400

    try:
        # Load global model if available, else a fresh untrained net
        net = MNISTNet()
        if os.path.exists(GLOBAL_MODEL):
            net.load_state_dict(torch.load(GLOBAL_MODEL, map_location="cpu"))
        net.eval()

        x = torch.tensor([pixels], dtype=torch.float32)
        with torch.no_grad():
            logits = net(x)[0]                            # (10,)
            probs  = torch.softmax(logits, dim=0).tolist()
            digit  = int(logits.argmax().item())

        return {
            "ok":          True,
            "digit":       digit,
            "confidence":  round(probs[digit], 4),
            "confidences": [round(p, 4) for p in probs],
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}, 500


# ── /prove — full ZK proof, SSE stream ──────────────────────────────────────

@app.post("/prove")
def prove():
    body     = request.get_json(force=True, silent=True) or {}
    task_id  = body.get("task_id")
    miner_id = body.get("miner_id", 0)

    if not isinstance(task_id, int) or task_id < 1:
        return {"error": "task_id (positive integer) is required"}, 400
    if not isinstance(miner_id, int) or miner_id < 0:
        miner_id = 0

    print(f"[prove] task_id={task_id}  miner_id={miner_id}", flush=True)

    def generate():
        with tempfile.TemporaryDirectory() as tmp:
            input_path   = os.path.join(tmp, "input.json")
            witness_path = os.path.join(tmp, "witness.json")
            proof_path   = os.path.join(tmp, "proof.json")

            yield sse({"stage": "loading",
                       "message": f"Preparing shard {miner_id} for task {task_id}…"})

            with open(input_path, "w") as f:
                json.dump({"input_data": [EVAL_INPUT]}, f)

            yield sse({"stage": "training",
                       "message": f"Training on MNIST shard {miner_id} (3 epochs)…"})
            try:
                accuracy, score, gh, strategy = run_training(task_id, miner_id)
            except Exception as e:
                yield sse({"stage": "error", "message": f"Training failed: {e}"})
                return

            yield sse({
                "stage":         "training",
                "message":       f"Training complete — acc {accuracy:.1%}  score {score}/100",
                "score":         score,
                "gradient_hash": gh,
            })

            yield sse({"stage": "computing",
                       "message": f"Gradient quality score: {score}/100",
                       "score":   score, "gradient_hash": gh})

            if not artifacts_ready():
                yield sse({"stage": "proving",
                           "message": "First run — compiling ZK circuit (~60s)…"})
                try:
                    run_one_time_setup(input_path)
                except Exception as e:
                    yield sse({"stage": "error",
                               "message": f"Circuit setup failed: {e}"})
                    return
            else:
                yield sse({"stage": "proving", "message": "Generating witness…"})

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

            yield sse({"stage": "verifying", "message": "Verifying proof…"})
            try:
                ok = ezkl.verify(
                    proof_path=proof_path, settings_path=SETTINGS_PATH,
                    vk_path=VK_PATH, srs_path=SRS_PATH, reduced_srs=False,
                )
            except Exception as e:
                yield sse({"stage": "error",
                           "message": f"Verification failed: {e}"})
                return

            if not ok:
                yield sse({"stage": "error",
                           "message": "Proof verification returned false."})
                return

            with open(proof_path) as f:
                proof_json = json.load(f)

            proof_kb = os.path.getsize(proof_path) / 1024
            yield sse({
                "stage":         "done",
                "message":       f"Proof verified ✓  ({proof_kb:.1f} KB)",
                "score":         score,
                "gradient_hash": gh,
                "proof":         proof_json,
                "training":      {"accuracy": round(accuracy, 4), "epochs": 3},
            })

    return Response(
        stream_with_context(generate()),
        content_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── /prove/async — start proof in background, return job_id ─────────────────

@app.post("/prove/async")
def prove_async():
    body     = request.get_json(force=True, silent=True) or {}
    task_id  = body.get("task_id")
    miner_id = body.get("miner_id", 0)

    if not isinstance(task_id, int) or task_id < 1:
        return {"ok": False, "error": "task_id (positive integer) is required"}, 400
    if not isinstance(miner_id, int) or miner_id < 0:
        miner_id = 0

    job_id = str(uuid.uuid4())
    with _jobs_lock:
        _jobs[job_id] = {
            "job_id":       job_id,
            "task_id":      task_id,
            "miner_id":     miner_id,
            "status":       "pending",
            "created_at":   time.time(),
            "proof":        None,
            "score":        None,
            "gradient_hash": None,
            "error":        None,
        }

    print(f"[prove/async] job {job_id[:8]}  task_id={task_id}  miner_id={miner_id}", flush=True)

    def _worker():
        with tempfile.TemporaryDirectory() as tmp:
            inp = os.path.join(tmp, "input.json")
            wit = os.path.join(tmp, "witness.json")
            prf = os.path.join(tmp, "proof.json")
            try:
                with open(inp, "w") as f:
                    json.dump({"input_data": [EVAL_INPUT]}, f)

                accuracy, score, gh, _strategy = run_training(task_id, miner_id)

                with _ezkl_lock:
                    if not artifacts_ready():
                        print(f"[prove/async] job {job_id[:8]} — first run, compiling circuit…", flush=True)
                        run_one_time_setup(inp)

                    ezkl.gen_witness(
                        data=inp, model=COMPILED_PATH,
                        output=wit, vk_path=VK_PATH, srs_path=SRS_PATH,
                    )
                    ezkl.prove(
                        witness=wit, model=COMPILED_PATH,
                        pk_path=PK_PATH, proof_path=prf, srs_path=SRS_PATH,
                    )
                    ok = ezkl.verify(
                        proof_path=prf, settings_path=SETTINGS_PATH,
                        vk_path=VK_PATH, srs_path=SRS_PATH, reduced_srs=False,
                    )
                    if not ok:
                        raise RuntimeError("Proof verification returned false")

                    with open(prf) as f:
                        proof_json = json.load(f)

                with _jobs_lock:
                    _jobs[job_id].update({
                        "status":        "complete",
                        "proof":         proof_json,
                        "score":         score,
                        "gradient_hash": gh,
                    })
                print(f"[prove/async] job {job_id[:8]} complete  score={score}", flush=True)

            except Exception as exc:
                with _jobs_lock:
                    _jobs[job_id].update({"status": "failed", "error": str(exc)})
                print(f"[prove/async] job {job_id[:8]} FAILED: {exc}", flush=True)

    threading.Thread(target=_worker, daemon=True).start()
    return {"ok": True, "job_id": job_id}


# ── /prove/status/<job_id> — poll proof job status ───────────────────────────

@app.get("/prove/status/<job_id>")
def prove_status(job_id):
    with _jobs_lock:
        job = dict(_jobs.get(job_id, {}))
    if not job:
        return {"ok": False, "error": "job not found"}, 404

    result = {
        "ok":            True,
        "status":        job["status"],
        "score":         job.get("score"),
        "gradient_hash": job.get("gradient_hash"),
        "error":         job.get("error"),
    }
    if job["status"] == "complete":
        result["proof"] = job.get("proof")
    return result


# ── /jobs — all recent proof jobs (for UI miner status display) ──────────────

@app.get("/jobs")
def list_jobs():
    now = time.time()
    with _jobs_lock:
        snapshot = list(_jobs.values())
    jobs_out = [
        {
            "job_id":   j["job_id"],
            "task_id":  j["task_id"],
            "miner_id": j["miner_id"],
            "status":   j["status"],
            "elapsed":  round(now - j["created_at"]),
            "score":    j.get("score"),
        }
        for j in sorted(snapshot, key=lambda x: -x["created_at"])
    ]
    return {"ok": True, "jobs": jobs_out}


# ── /simulate — 4 miners concurrently, SSE stream ───────────────────────────

SIMULATION_MINERS = [
    (0, "Miner Alpha"),
    (1, "Miner Beta"),
    (2, "Miner Gamma"),
    (3, "Miner Delta"),
]


@app.post("/simulate")
def simulate():
    body    = request.get_json(force=True, silent=True) or {}
    task_id = body.get("task_id")
    if not isinstance(task_id, int) or task_id < 1:
        return {"error": "task_id (positive integer) is required"}, 400

    print(f"[simulate] task_id={task_id}  launching {len(SIMULATION_MINERS)} miners",
          flush=True)

    event_queue = _queue.Queue()

    def miner_worker(miner_id: int, miner_name: str):
        def put(stage: str, **kwargs):
            event_queue.put({
                "miner_id": miner_id, "miner_name": miner_name,
                "stage": stage, **kwargs,
            })

        try:
            put("loading", message=f"Preparing shard {miner_id} for task {task_id}…")
            put("training", message=f"Training on MNIST shard {miner_id} (3 epochs)…")

            accuracy, score, gh, strategy = run_training(task_id, miner_id)
            put("training",
                message=f"Training complete — acc {accuracy:.1%}  score {score}/100",
                score=score)

            put("proving", message="Waiting for ZK prover slot…")
            with _ezkl_lock:
                with tempfile.TemporaryDirectory() as tmp:
                    inp = os.path.join(tmp, "input.json")
                    wit = os.path.join(tmp, "witness.json")
                    prf = os.path.join(tmp, "proof.json")

                    with open(inp, "w") as f:
                        json.dump({"input_data": [EVAL_INPUT]}, f)

                    put("proving", message="Generating witness and proof (~10s)…")
                    if not artifacts_ready():
                        run_one_time_setup(inp)

                    ezkl.gen_witness(
                        data=inp, model=COMPILED_PATH,
                        output=wit, vk_path=VK_PATH, srs_path=SRS_PATH,
                    )
                    ezkl.prove(
                        witness=wit, model=COMPILED_PATH,
                        pk_path=PK_PATH, proof_path=prf, srs_path=SRS_PATH,
                    )

                    put("verifying", message="Verifying proof…")
                    ok = ezkl.verify(
                        proof_path=prf, settings_path=SETTINGS_PATH,
                        vk_path=VK_PATH, srs_path=SRS_PATH, reduced_srs=False,
                    )
                    if not ok:
                        raise RuntimeError("Proof verification returned false")

                    proof_kb = os.path.getsize(prf) / 1024

            put("done",
                message=f"Proof verified ✓  ({proof_kb:.1f} KB)",
                score=score, gradient_hash=gh)

        except Exception as exc:
            put("error", message=str(exc))
        finally:
            event_queue.put(None)

    for mid, mname in SIMULATION_MINERS:
        threading.Thread(target=miner_worker, args=(mid, mname), daemon=True).start()

    def generate():
        done_count = 0
        while done_count < len(SIMULATION_MINERS):
            try:
                item = event_queue.get(timeout=600)
            except _queue.Empty:
                break
            if item is None:
                done_count += 1
                continue
            yield sse(item)
        yield sse({"stage": "simulation_done", "message": "All miners completed"})

    return Response(
        stream_with_context(generate()),
        content_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


if __name__ == "__main__":
    print("PoLChain prove-server  →  http://localhost:5001")
    print(f"ZK artifacts dir: {ZK_DIR}")
    print(f"Endpoints: /health  /train  /prove  /prove/async  /prove/status/<id>  /jobs  /simulate  /accuracy  /accuracy_by_class  /predict")
    app.run(host="0.0.0.0", port=5001, debug=False, threaded=True)
