"""
era2.py — Era-2 prove pipeline: per-proof weight injection against the frozen
challenge circuit.

Era 1's silent flaw lived here: the server proved the static network.compiled
regardless of what was trained. Era 2 compiles EVERY proof from the submitted
model's actual weights against the FROZEN settings (zk/v2/settings.json,
calibrated adversarially by the spike) and proves with the single frozen pk —
G2 of the spike demonstrated that three distinct trained models verify against
one pk, because weights are witness values and the pk binds only structure.

Pipeline per job (~60-70s, serial under the proving lock):
    state_dict → ONNX export ([N,784] frozen graph)
    → ezkl.compile_circuit(frozen settings)        (~0.1s)
    → ezkl.gen_witness(task's challenge batch)     (~1.5s)
    → ezkl.prove(frozen pk)                        (~60s)
    → {proof hex, instances (big-endian), predicted on-chain score}

Queue: visitors outrank named miners — the protocol's own bots wait for
guests. Self-hosting is supported: everything here is reproducible from
zk/v2/ artifacts + ezkl.

Endpoints (registered on the main Flask app):
    POST /v2/prove          {task_id, batch_idx, miner_id}      named miner: train + prove
    POST /v2/prove-visitor  {task_id, batch_idx, weights{...}}  visitor: tf.js weights, no training
    GET  /v2/job/<id>       job status/result
    GET  /v2/queue          live queue for the Mine view
    GET  /v2/info           circuit constants + vka for clients/self-hosters
"""

import hashlib
import json
import os
import shutil
import sys
import threading
import time
import uuid
from collections import deque

import numpy as np
import torch
from flask import Blueprint, jsonify, request

ZK_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ZK_DIR)

import ezkl  # noqa: E402
from challenge_net import (  # noqa: E402
    export_challenge_onnx, get_challenge_batch, write_batch_input_json,
)
from model import MNISTNet  # noqa: E402

N           = 8
V2_DIR      = os.path.join(ZK_DIR, "v2")
SETTINGS    = os.path.join(V2_DIR, "settings.json")
PK_PATH     = os.path.join(V2_DIR, "pk.key")
VK_PATH     = os.path.join(V2_DIR, "vk.key")
SRS_PATH    = os.path.join(V2_DIR, "kzg.srs")
VKA_PATH    = os.path.join(V2_DIR, "vka.json")
JOBS_DIR    = os.path.join(V2_DIR, "jobs")
POOL_PATH   = os.path.join(ZK_DIR, "challenge_commitments.json")

FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617

era2_bp = Blueprint("era2", __name__)

_queue_lock    = threading.Lock()
_visitor_queue = deque()
_named_queue   = deque()
_jobs          = {}
_worker_started = False


def v2_ready() -> bool:
    return all(os.path.exists(p) for p in (SETTINGS, PK_PATH, VK_PATH, SRS_PATH, VKA_PATH))


def le_hex_to_be(hex_le: str) -> str:
    return "0x" + bytes.fromhex(hex_le)[::-1].hex()


def felt_to_signed(be_hex: str) -> int:
    v = int(be_hex, 16)
    return v if v <= FIELD_PRIME // 2 else v - FIELD_PRIME


def predicted_onchain_score(instances_be, labels) -> int:
    """Mirror of TaskManagerV2._scoreFromInstances — what the contract WILL compute."""
    correct = 0
    for img in range(N):
        logits = [felt_to_signed(instances_be[1 + img * 10 + d]) for d in range(10)]
        if int(np.argmax(logits)) == labels[img]:
            correct += 1
    return (correct * 100) // N


def tfjs_to_state_dict(weights: dict):
    """
    Convert tf.js dense-layer arrays into a MNISTNet state_dict.
    tf.layers.dense kernels are [in, out]; torch Linear weights are [out, in].
    """
    def t(name, arr, transpose):
        a = torch.tensor(np.array(arr, dtype=np.float32))
        return a.T.contiguous() if transpose else a

    return {
        "fc1.weight": t("fc1", weights["fc1_w"], True),
        "fc1.bias":   t("fc1b", weights["fc1_b"], False),
        "fc2.weight": t("fc2", weights["fc2_w"], True),
        "fc2.bias":   t("fc2b", weights["fc2_b"], False),
        "fc3.weight": t("fc3", weights["fc3_w"], True),
        "fc3.bias":   t("fc3b", weights["fc3_b"], False),
    }


def _labels_for_batch(batch_idx: int):
    _, y = get_challenge_batch(batch_idx, N)
    return y.tolist()


# Mirrors server.py's per-miner training recipe (shard, seed, augmentation,
# warm start, focus digits) but returns the trained STATE — Era 2 proves the
# weights that were actually trained, so the pipeline needs them.
_AUGS = ["rotation", "noise", "erasing", "none"]
GLOBAL_MODEL = os.path.join(ZK_DIR, "global_model.pth")


def _fetch_focus_digits(shard_id: int):
    try:
        import urllib.request
        with urllib.request.urlopen("http://localhost:5001/accuracy_by_class",
                                    timeout=5) as resp:
            data = json.loads(resp.read())
        if data.get("ok"):
            digits = (data.get("assignments") or {}).get(str(shard_id))
            return [int(d) for d in digits] if digits else None
    except Exception:
        return None


def _train_named(task_id: int, miner_id: int):
    from model import train_shard
    shard_id = miner_id % 4
    initial = torch.load(GLOBAL_MODEL, map_location="cpu") \
        if os.path.exists(GLOBAL_MODEL) else None
    model, accuracy = train_shard(
        shard_id, n_epochs=3, seed=task_id * 10 + miner_id,
        initial_state=initial, augmentation=_AUGS[shard_id],
        focus_digits=_fetch_focus_digits(shard_id),
    )
    return model.state_dict(), accuracy, _AUGS[shard_id]


def _run_proof_job(job):
    """The per-proof pipeline. Runs on the worker thread, one job at a time."""
    jid  = job["id"]
    jdir = os.path.join(JOBS_DIR, jid)
    os.makedirs(jdir, exist_ok=True)
    P = lambda f: os.path.join(jdir, f)
    timings = {}

    try:
        # 0. obtain weights — named miners train, visitors bring their own
        if job["kind"] == "named":
            t0 = time.time()
            job["status"] = "training"
            state, accuracy, augmentation = _train_named(job["task_id"], job["miner_id"])
            timings["train_s"] = round(time.time() - t0, 1)
            job["local_score"] = min(100, max(0, round(accuracy * 100)))
            job["augmentation"] = augmentation
        else:
            state = tfjs_to_state_dict(job.pop("weights"))
            net = MNISTNet(); net.load_state_dict(state); net.eval()
            job["local_score"] = None  # visitor measured locally in-browser

        job["status"] = "proving"

        # 1. export this model's ONNX — the model commitment is its real hash
        t0 = time.time()
        export_challenge_onnx(state, N, P("model.onnx"))
        with open(P("model.onnx"), "rb") as f:
            job["gradient_hash"] = "0x" + hashlib.sha256(f.read()).hexdigest()

        # 2. compile against FROZEN settings (weights enter the witness here)
        ezkl.compile_circuit(model=P("model.onnx"),
                             compiled_circuit=P("network.compiled"),
                             settings_path=SETTINGS)
        timings["compile_s"] = round(time.time() - t0, 1)

        # 3. witness on THIS task's challenge batch
        t0 = time.time()
        X, _ = get_challenge_batch(job["batch_idx"], N)
        write_batch_input_json(X, P("input.json"))
        ezkl.gen_witness(data=P("input.json"), model=P("network.compiled"),
                         output=P("witness.json"))
        timings["witness_s"] = round(time.time() - t0, 1)

        # 4. prove with the FROZEN pk
        t0 = time.time()
        ezkl.prove(witness=P("witness.json"), model=P("network.compiled"),
                   pk_path=PK_PATH, proof_path=P("proof.json"), srs_path=SRS_PATH)
        timings["prove_s"] = round(time.time() - t0, 1)

        with open(P("proof.json")) as f:
            proof = json.load(f)
        instances_be = [le_hex_to_be(h) for h in proof["instances"][0]]
        assert len(instances_be) == 1 + N * 10, f"unexpected instance count {len(instances_be)}"

        labels = _labels_for_batch(job["batch_idx"])
        job["result"] = {
            "proof": proof["hex_proof"] if proof["hex_proof"].startswith("0x")
                     else "0x" + proof["hex_proof"],
            "instances": instances_be,
            "predicted_score": predicted_onchain_score(instances_be, labels),
            "gradient_hash": job["gradient_hash"],
            "timings": timings,
        }
        job["status"] = "complete"
        print(f"[era2] job {jid[:8]} complete — predicted on-chain score "
              f"{job['result']['predicted_score']} (local {job.get('local_score')}) "
              f"{timings}", flush=True)
    except Exception as e:
        job["status"] = "failed"
        job["error"]  = str(e)
        print(f"[era2] job {jid[:8]} FAILED: {e}", flush=True)
    finally:
        job["finished_at"] = time.time()
        shutil.rmtree(jdir, ignore_errors=True)


def _worker():
    while True:
        job = None
        with _queue_lock:
            if _visitor_queue:
                job = _visitor_queue.popleft()
            elif _named_queue:
                job = _named_queue.popleft()
        if job is None:
            time.sleep(0.5)
            continue
        _run_proof_job(job)


def _ensure_worker():
    global _worker_started
    if not _worker_started:
        threading.Thread(target=_worker, daemon=True).start()
        _worker_started = True


def _enqueue(kind, payload):
    _ensure_worker()
    job = {
        "id": str(uuid.uuid4()),
        "kind": kind,
        "status": "queued",
        "queued_at": time.time(),
        **payload,
    }
    with _queue_lock:
        _jobs[job["id"]] = job
        (_visitor_queue if kind == "visitor" else _named_queue).append(job)
    return job


def _queue_snapshot():
    with _queue_lock:
        active = [j for j in _jobs.values() if j["status"] in ("training", "proving")]
        return {
            "active": [{"id": j["id"], "kind": j["kind"], "status": j["status"],
                        "miner_id": j.get("miner_id")} for j in active],
            "visitor_waiting": len(_visitor_queue),
            "named_waiting": len(_named_queue),
        }


# ── endpoints ───────────────────────────────────────────────────────────────

@era2_bp.get("/v2/info")
def v2_info():
    if not v2_ready():
        return jsonify({"ok": False, "error": "zk/v2 artifacts missing"}), 503
    with open(VKA_PATH) as f:
        vka = json.load(f)["words"]
    with open(SETTINGS) as f:
        settings = json.load(f)
    pool_meta = {}
    if os.path.exists(POOL_PATH):
        with open(POOL_PATH) as f:
            pool = json.load(f)
        pool_meta = {"numBatches": pool["numBatches"], "poolIndices": pool["poolIndices"]}
    return jsonify({
        "ok": True, "n": N, "expected_instances": 1 + N * 10,
        "vka": vka,
        "scales": settings["run_args"].get("input_scale"),
        "logrows": settings["run_args"]["logrows"],
        **pool_meta,
        "self_hosting": "reproduce with ezkl + zk/v2 artifacts; see zk/challenge_pool.py",
    })


@era2_bp.post("/v2/prove")
def v2_prove():
    if not v2_ready():
        return jsonify({"ok": False, "error": "zk/v2 artifacts missing"}), 503
    body = request.get_json(force=True)
    try:
        task_id   = int(body["task_id"])
        batch_idx = int(body["batch_idx"])
        miner_id  = int(body["miner_id"])
    except (KeyError, ValueError, TypeError):
        return jsonify({"ok": False, "error": "need task_id, batch_idx, miner_id"}), 400
    job = _enqueue("named", {"task_id": task_id, "batch_idx": batch_idx,
                             "miner_id": miner_id})
    return jsonify({"ok": True, "job_id": job["id"], "queue": _queue_snapshot()})


@era2_bp.post("/v2/prove-visitor")
def v2_prove_visitor():
    if not v2_ready():
        return jsonify({"ok": False, "error": "zk/v2 artifacts missing"}), 503
    body = request.get_json(force=True)
    weights = body.get("weights") or {}
    required = {"fc1_w", "fc1_b", "fc2_w", "fc2_b", "fc3_w", "fc3_b"}
    if not required.issubset(weights):
        return jsonify({"ok": False, "error": f"weights must include {sorted(required)}"}), 400
    try:
        task_id   = int(body["task_id"])
        batch_idx = int(body["batch_idx"])
        # shape sanity before accepting the job
        sd = tfjs_to_state_dict(weights)
        net = MNISTNet(); net.load_state_dict(sd)
    except Exception as e:
        return jsonify({"ok": False, "error": f"bad weights: {e}"}), 400
    job = _enqueue("visitor", {"task_id": task_id, "batch_idx": batch_idx,
                               "weights": weights})
    return jsonify({"ok": True, "job_id": job["id"], "queue": _queue_snapshot()})


@era2_bp.get("/v2/job/<job_id>")
def v2_job(job_id):
    job = _jobs.get(job_id)
    if not job:
        return jsonify({"ok": False, "error": "unknown job"}), 404
    out = {k: v for k, v in job.items() if k not in ("weights",)}
    return jsonify({"ok": True, **out})


@era2_bp.get("/v2/queue")
def v2_queue():
    return jsonify({"ok": True, **_queue_snapshot()})
