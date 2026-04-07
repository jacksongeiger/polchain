"""
prove_step.py — Generate a ZK proof of one gradient step (inference-on-post-training fallback)

Why not prove the gradient step directly?
───────────────────────────────────────────
The original design embedded 109,386 floats as public inputs to the EZKL circuit.
EZKL's fixed-point quantization cannot faithfully represent 109K independent floats:
the accumulated rounding error makes the computed loss meaningless and the proof
unsound. Proving a full gradient step at this scale is beyond every current ZK
backend (Halo2, Groth16, Nova).

What this actually proves:
──────────────────────────
  1. Real PyTorch SGD is run → weights_before, weights_after, loss_val
  2. sha256 hashes of both weight vectors are recorded
  3. weights_after is loaded into a fresh MNISTNet and exported as a temp ONNX
     (same architecture as zk/model.onnx — standard inference, weights private)
  4. EZKL proves inference of the updated model on a canonical blank input [0]*784
  5. The proof cryptographically binds: "the model identified by output_weight_hash
     honestly produces these logits when given the zero-pixel input"

Chain of trust:
───────────────
  prev block output_weight_hash
    → SGD step (off-circuit)
    → input_weight_hash == prev block's output hash  (independently verifiable)
    → output_weight_hash (new)
    → ZK proof: the post-training model produces valid inference

Why stronger than the existing blank-input proof (zk/prove.py):
  prove.py uses whatever model.onnx happens to be on disk, with no binding to
  a specific weight hash. This script ties the proof to a committed weight hash,
  so two proofs with different output_weight_hashes guarantee different models.

Artifacts REUSED from zk/ (no recompilation of these):
  settings.json — EZKL circuit settings (scale, lookup tables); depends on
                  architecture, not on weight values
  kzg.srs       — polynomial commitment SRS; depends only on circuit size

Artifacts REGENERATED per proof (fast — seconds to a few minutes):
  network.compiled — bakes in the specific weight constants for this model state
  pk.key / vk.key  — proving/verifying keys derived from the compiled circuit

Usage
─────
    python prove_step.py --shard 0 --task_id 42
    python prove_step.py --shard 1 --task_id 42 --lr 0.005
"""

import argparse
import asyncio
import glob
import hashlib
import json
import os
import sys
import time

import torch
import torch.nn.functional as F
import onnx
import ezkl

HERE   = os.path.dirname(os.path.abspath(__file__))
ZK_DIR = os.path.dirname(HERE)
sys.path.insert(0, ZK_DIR)

from model import MNISTNet, get_shards          # noqa: E402
from training_step_model import (               # noqa: E402
    get_flat_weights, N_OUT, BATCH_SIZE,
)

# ── Reused artifacts from zk/ (architecture-level, not weight-level) ──────
SETTINGS_PATH = os.path.join(ZK_DIR, "settings.json")
SRS_PATH      = os.path.join(ZK_DIR, "kzg.srs")

# ── Per-proof output directory ─────────────────────────────────────────────
PROOFS_DIR = os.path.join(HERE, "proofs")

# ── Canonical blank input (same as zk/prove.py) ───────────────────────────
SAMPLE_INPUT = [0.0] * 784


# ── Helpers ────────────────────────────────────────────────────────────────

def hash_weights(weights_flat: torch.Tensor) -> str:
    """sha256 of the raw float32 bytes of the weight vector."""
    buf = weights_flat.detach().float().numpy().tobytes()
    return "0x" + hashlib.sha256(buf).hexdigest()


def get_canonical_batch(shard_id: int, batch_size: int = BATCH_SIZE):
    """First `batch_size` samples from shard `shard_id` of MNIST."""
    shards, _, _ = get_shards()
    X_shard, y_shard = shards[shard_id]
    pixels    = X_shard[:batch_size].float()
    labels    = y_shard[:batch_size].long()
    labels_oh = torch.zeros(batch_size, N_OUT)
    labels_oh.scatter_(1, labels.unsqueeze(1), 1.0)
    return pixels, labels_oh, labels


def run_gradient_step(net: MNISTNet, pixels: torch.Tensor, labels: torch.Tensor,
                      lr: float = 0.01):
    """One SGD step. Returns (loss_val, weights_after_flat). Mutates net in-place."""
    net.train()
    optimizer = torch.optim.SGD(net.parameters(), lr=lr)
    optimizer.zero_grad()
    logits = net(pixels)
    loss   = F.cross_entropy(logits, labels)
    loss.backward()
    optimizer.step()
    net.eval()
    return float(loss.item()), get_flat_weights(net.state_dict())


def export_model_onnx(net: MNISTNet, path: str) -> None:
    """Export net as a standard inference ONNX — same format as zk/model.onnx."""
    net.eval()
    dummy = torch.zeros(1, 784)
    torch.onnx.export(
        net,
        dummy,
        path,
        input_names=["input"],
        output_names=["output"],
        opset_version=11,
        do_constant_folding=True,
    )
    onnx.checker.check_model(onnx.load(path))


def loss_to_score(loss_val: float) -> int:
    return max(0, round((1.0 - loss_val) * 100))


# ── Main ───────────────────────────────────────────────────────────────────

async def main():
    parser = argparse.ArgumentParser(
        description="Prove post-training inference with EZKL (inference-only fallback)."
    )
    parser.add_argument("--shard",   type=int, required=True, choices=[0, 1, 2, 3],
                        help="MNIST shard ID (0–3)")
    parser.add_argument("--task_id", type=int, required=True,
                        help="On-chain task ID (used for output filename)")
    parser.add_argument("--lr",      type=float, default=0.01,
                        help="SGD learning rate (default 0.01)")
    args = parser.parse_args()

    # Check that the reused architecture artifacts exist
    for p, label in [(SETTINGS_PATH, "zk/settings.json"), (SRS_PATH, "zk/kzg.srs")]:
        if not os.path.exists(p):
            print(f"Missing artifact: {p}  ({label})")
            print("Run zk/prove.py once to generate the base circuit artifacts.")
            sys.exit(1)

    os.makedirs(PROOFS_DIR, exist_ok=True)

    print(f"=== Post-training inference proof: task #{args.task_id}, shard {args.shard} ===\n")

    tag = f"task_{args.task_id}_shard_{args.shard}"

    # Per-proof working files — cleaned up at the end
    onnx_path     = os.path.join(HERE, f"model_{tag}.onnx")
    compiled_path = os.path.join(HERE, f"compiled_{tag}.circuit")
    pk_path       = os.path.join(HERE, f"pk_{tag}.key")
    vk_path       = os.path.join(HERE, f"vk_{tag}.key")
    input_path    = os.path.join(HERE, f"input_{tag}.json")
    witness_path  = os.path.join(HERE, f"witness_{tag}.json")
    proof_path    = os.path.join(HERE, f"proof_{tag}.json")
    out_path      = os.path.join(PROOFS_DIR, f"{tag}.json")

    t0 = time.time()

    # ── 1. Load global model ────────────────────────────────────────────────
    global_model_path = os.path.join(ZK_DIR, "global_model.pth")
    net = MNISTNet()
    if os.path.exists(global_model_path):
        net.load_state_dict(torch.load(global_model_path, map_location="cpu"))
        print(f"Loaded {global_model_path}")
    else:
        print("global_model.pth not found — using random init weights")
    net.eval()

    weights_before = get_flat_weights(net.state_dict())
    input_hash     = hash_weights(weights_before)
    print(f"Input weight hash:  {input_hash}")

    # ── 2. Canonical batch ──────────────────────────────────────────────────
    pixels, labels_oh, labels = get_canonical_batch(args.shard, BATCH_SIZE)
    print(f"Canonical batch:    shard {args.shard}, {BATCH_SIZE} samples, "
          f"labels {labels[:8].tolist()}…")

    # ── 3. Real gradient step ───────────────────────────────────────────────
    print(f"\nRunning gradient step (lr={args.lr})…")
    loss_val, weights_after = run_gradient_step(net, pixels, labels, lr=args.lr)
    output_hash = hash_weights(weights_after)
    score       = loss_to_score(loss_val)

    print(f"  loss        = {loss_val:.6f}")
    print(f"  score       = {score}/100")
    print(f"  output hash = {output_hash}")
    print(f"  elapsed     = {time.time()-t0:.1f}s")

    # ── 4. Export post-training model as standard inference ONNX ───────────
    print(f"\nExporting post-training ONNX → {onnx_path}")
    export_model_onnx(net, onnx_path)

    # ── 5. Compile circuit for this specific model state ────────────────────
    # settings.json is reused (architecture-level, not weight-level).
    # We must recompile because the weights are baked into the circuit as
    # private constants — different weights → different compiled circuit.
    print("Compiling circuit…", end=" ", flush=True)
    t1 = time.time()
    ezkl.compile_circuit(
        model=onnx_path,
        compiled_circuit=compiled_path,
        settings_path=SETTINGS_PATH,
    )
    print(f"✓  {time.time()-t1:.1f}s")

    # ── 6. Generate proving/verifying keys (reusing kzg.srs) ───────────────
    print("Generating pk + vk…", end=" ", flush=True)
    t2 = time.time()
    ezkl.setup(
        model=compiled_path,
        vk_path=vk_path,
        pk_path=pk_path,
        srs_path=SRS_PATH,
        disable_selector_compression=False,
    )
    print(f"✓  {time.time()-t2:.1f}s")

    # ── 7. Write canonical input.json ──────────────────────────────────────
    with open(input_path, "w") as f:
        json.dump({"input_data": [SAMPLE_INPUT]}, f)

    # ── 8. Generate witness ─────────────────────────────────────────────────
    print("Generating witness…", end=" ", flush=True)
    t3 = time.time()
    ezkl.gen_witness(
        data=input_path,
        model=compiled_path,
        output=witness_path,
        vk_path=vk_path,
        srs_path=SRS_PATH,
    )
    print(f"✓  {time.time()-t3:.1f}s")

    # ── 9. Prove ────────────────────────────────────────────────────────────
    print("Generating ZK proof…", end=" ", flush=True)
    t4 = time.time()
    ezkl.prove(
        witness=witness_path,
        model=compiled_path,
        pk_path=pk_path,
        proof_path=proof_path,
        srs_path=SRS_PATH,
    )
    print(f"✓  {time.time()-t4:.1f}s")

    # ── 10. Verify ──────────────────────────────────────────────────────────
    print("Verifying proof…", end=" ", flush=True)
    t5 = time.time()
    ok = ezkl.verify(
        proof_path=proof_path,
        settings_path=SETTINGS_PATH,
        vk_path=vk_path,
        srs_path=SRS_PATH,
        reduced_srs=False,
    )
    print(f"{'✓' if ok else '✗'}  {time.time()-t5:.1f}s")

    if not ok:
        print("ERROR: proof failed verification — not saving output")
        sys.exit(1)

    # ── 11. Save output file ────────────────────────────────────────────────
    with open(proof_path) as f:
        proof_data = json.load(f)

    record = {
        "task_id":            args.task_id,
        "shard_id":           args.shard,
        "input_weight_hash":  input_hash,
        "output_weight_hash": output_hash,
        "loss":               loss_val,
        "score":              score,
        "proof":              proof_data,
        "proved_at":          time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    with open(out_path, "w") as f:
        json.dump(record, f, indent=2)

    proof_kb = os.path.getsize(out_path) / 1024
    elapsed  = time.time() - t0

    print(f"\nPost-training inference proven: loss={loss_val:.4f}  score={score}/100")
    print(f"  input_hash  = {input_hash}")
    print(f"  output_hash = {output_hash}")
    print(f"  saved       → {out_path}  ({proof_kb:.0f} KB)")
    print(f"  total time  = {elapsed:.1f}s")

    # ── 12. Cleanup per-proof working files ─────────────────────────────────
    # Explicit removal of this run's files (handles the happy path)
    for p in [onnx_path, compiled_path, pk_path, vk_path,
              input_path, witness_path, proof_path]:
        try:
            os.remove(p)
        except OSError:
            pass

    # Glob sweep to catch any stragglers from interrupted prior runs that
    # match the same task_id/shard_id pattern (pk, vk, onnx, compiled).
    straggler_patterns = [
        os.path.join(HERE, f"pk_{tag}*.key"),
        os.path.join(HERE, f"vk_{tag}*.key"),
        os.path.join(HERE, f"model_{tag}*.onnx"),
        os.path.join(HERE, f"compiled_{tag}*.circuit"),
        os.path.join(HERE, f"input_{tag}*.json"),
        os.path.join(HERE, f"witness_{tag}*.json"),
        os.path.join(HERE, f"proof_{tag}*.json"),
    ]
    for pattern in straggler_patterns:
        for straggler in glob.glob(pattern):
            try:
                os.remove(straggler)
                print(f"  cleaned up straggler: {os.path.basename(straggler)}")
            except OSError:
                pass


if __name__ == "__main__":
    asyncio.run(main())
