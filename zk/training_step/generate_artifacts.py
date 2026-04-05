"""
generate_artifacts.py — Compile the training-step EZKL circuit

Runs the full EZKL setup pipeline for training_step.onnx and writes all
proving/verifying artifacts to zk/training_step/:

    settings.json   network.compiled   kzg.srs   pk.key   vk.key

EZKL visibility model (matches the on-chain trust assumptions):
    input_visibility  = "public"   weights, batch, labels visible to verifier
    output_visibility = "public"   loss and logits visible to verifier
    param_visibility  = "private"  (no fixed ONNX params in this model)

Usage
─────
    # Full scale (109K weight inputs + 50K batch pixels) — needs 32+ GB RAM
    python generate_artifacts.py

    # Smoke-test with a 4-sample batch (seconds not hours)
    python generate_artifacts.py --small

    # Use a specific MNIST shard for the calibration input
    python generate_artifacts.py --shard 2
"""

import argparse
import asyncio
import json
import os
import sys
import time

import torch
import ezkl

HERE   = os.path.dirname(os.path.abspath(__file__))
ZK_DIR = os.path.dirname(HERE)
sys.path.insert(0, ZK_DIR)

from model import MNISTNet, get_shards, DATA_DIR           # noqa: E402
from training_step_model import (                           # noqa: E402
    TrainingStepNet, get_flat_weights, export_onnx,
    N_PARAMS, N_IN, N_OUT, BATCH_SIZE, ONNX_PATH,
)

# ── Artifact paths ─────────────────────────────────────────────────────────
SETTINGS_PATH  = os.path.join(HERE, "settings.json")
COMPILED_PATH  = os.path.join(HERE, "network.compiled")
SRS_PATH       = os.path.join(HERE, "kzg.srs")
PK_PATH        = os.path.join(HERE, "pk.key")
VK_PATH        = os.path.join(HERE, "vk.key")
INPUT_PATH     = os.path.join(HERE, "input.json")

# ── Small-mode constants ────────────────────────────────────────────────────
SMALL_BATCH   = 4
SMALL_ONNX    = os.path.join(HERE, "training_step_small.onnx")


# ── Helpers ────────────────────────────────────────────────────────────────

def get_canonical_batch(shard_id: int, batch_size: int = BATCH_SIZE):
    """
    Return the first `batch_size` samples from shard `shard_id` of MNIST.

    Shard layout (matches model.py's get_shards):
        shard 0 → X_train[0      : 10 000]
        shard 1 → X_train[10 000 : 20 000]
        shard 2 → X_train[20 000 : 30 000]
        shard 3 → X_train[30 000 : 40 000]

    Returns
    ───────
    pixels      Tensor [batch_size, 784]   float32, values in [0, 1]
    labels_oh   Tensor [batch_size, 10]    one-hot float32
    labels      Tensor [batch_size]        integer class indices
    """
    shards, _, _ = get_shards()
    X_shard, y_shard = shards[shard_id]
    pixels   = X_shard[:batch_size].float()           # already normalised
    labels   = y_shard[:batch_size].long()
    labels_oh = torch.zeros(batch_size, N_OUT)
    labels_oh.scatter_(1, labels.unsqueeze(1), 1.0)
    return pixels, labels_oh, labels


def write_input_json(weights_flat, batch, labels_oh, path=INPUT_PATH):
    """
    Write EZKL-format input.json.

    EZKL flattens multi-dimensional inputs to 1-D lists, one list per
    model input in declaration order.
    """
    data = {
        "input_data": [
            weights_flat.tolist(),
            batch.flatten().tolist(),
            labels_oh.flatten().tolist(),
        ]
    }
    with open(path, "w") as f:
        json.dump(data, f)
    kb = os.path.getsize(path) / 1024
    print(f"  Wrote {path}  ({kb:.0f} KB)")


class Timer:
    """Simple step-timer with pass/fail reporting."""
    def __call__(self, label: str, fn, *args, **kwargs):
        print(f"  {label}…", end=" ", flush=True)
        t0  = time.time()
        res = fn(*args, **kwargs)
        ok  = "✓" if res else "✗ (returned falsy)"
        print(f"{ok}  {time.time()-t0:.1f}s")
        return res


# ── Small-mode ONNX export ─────────────────────────────────────────────────

def export_small_onnx():
    """
    Export a TrainingStepNet variant with SMALL_BATCH=4 for fast pipeline
    smoke-tests.  The regular ONNX uses static shapes so batch size is
    baked in; we need a separate export for the smaller batch.
    """
    import training_step_model as tsm
    import torch
    import torch.nn.functional as F

    class SmallNet(tsm.TrainingStepNet):
        pass  # same logic, different dummy shapes

    model = SmallNet()
    model.eval()

    dw = torch.zeros(N_PARAMS)
    dx = torch.zeros(SMALL_BATCH, N_IN)
    dy = torch.zeros(SMALL_BATCH, N_OUT);  dy[:, 0] = 1.0

    with torch.no_grad():
        torch.onnx.export(
            model,
            (dw, dx, dy),
            SMALL_ONNX,
            input_names=["weights", "batch", "labels"],
            output_names=["loss", "logits"],
            opset_version=11,
            dynamic_axes=None,
        )
    kb = os.path.getsize(SMALL_ONNX) / 1024
    print(f"  Exported small ONNX → {SMALL_ONNX}  ({kb:.0f} KB)")
    return SMALL_ONNX


# ── Main pipeline ──────────────────────────────────────────────────────────

async def main():
    parser = argparse.ArgumentParser(description="Generate EZKL artifacts for the training-step circuit.")
    parser.add_argument("--small", action="store_true",
                        help=f"Use {SMALL_BATCH}-sample batch for fast smoke-test")
    parser.add_argument("--shard", type=int, default=0, choices=[0, 1, 2, 3],
                        help="MNIST shard ID for the calibration input (default: 0)")
    args = parser.parse_args()

    batch_size  = SMALL_BATCH if args.small else BATCH_SIZE
    onnx_path   = SMALL_ONNX  if args.small else ONNX_PATH

    print("=== PoLChain — Training-Step EZKL Artifact Generator ===\n")

    if args.small:
        print(f"⚠  --small mode: {SMALL_BATCH}-sample batch, fast smoke-test only\n")
    else:
        total_in = N_PARAMS + batch_size * N_IN + batch_size * N_OUT
        print(f"⚠  Full-scale circuit: {total_in:,} input floats (~{total_in*4//1024} KB)")
        print("   Expect 30–120 min for setup and 32+ GB RAM.")
        print("   Use --small for a quick smoke-test.\n")

    step = Timer()

    # ── 1. Export ONNX ─────────────────────────────────────────────────────
    print("── 1. Export ONNX ──────────────────────────────────────────────")
    if args.small:
        onnx_path = export_small_onnx()
    else:
        export_onnx(onnx_path)

    # ── 2. Load or initialise model weights ────────────────────────────────
    print("\n── 2. Load weights ─────────────────────────────────────────────")
    global_model_path = os.path.join(ZK_DIR, "global_model.pth")
    net = MNISTNet()
    if os.path.exists(global_model_path):
        net.load_state_dict(torch.load(global_model_path, map_location="cpu"))
        print(f"  Loaded  {global_model_path}")
    else:
        print(f"  global_model.pth not found — using random init weights")
    net.eval()
    weights_flat = get_flat_weights(net.state_dict())
    print(f"  Weight vector: {weights_flat.shape[0]:,} floats")

    # ── 3. Load canonical batch ─────────────────────────────────────────────
    print(f"\n── 3. Canonical batch (shard {args.shard}, {batch_size} samples) ──────────")
    pixels, labels_oh, labels = get_canonical_batch(args.shard, batch_size)
    print(f"  Labels: {labels.tolist()}")

    # ── 4. Write input.json ─────────────────────────────────────────────────
    print("\n── 4. Write input.json ─────────────────────────────────────────")
    write_input_json(weights_flat, pixels, labels_oh)

    # ── 5. EZKL pipeline ────────────────────────────────────────────────────
    print("\n── 5. EZKL pipeline ────────────────────────────────────────────")

    run_args                   = ezkl.PyRunArgs()
    run_args.input_visibility  = "public"
    run_args.output_visibility = "public"
    run_args.param_visibility  = "private"
    run_args.decomp_legs       = 3

    step("gen_settings",
         ezkl.gen_settings,
         model=onnx_path,
         output=SETTINGS_PATH,
         py_run_args=run_args)

    step("calibrate_settings",
         ezkl.calibrate_settings,
         data=INPUT_PATH,
         model=onnx_path,
         settings=SETTINGS_PATH,
         target="accuracy",
         lookup_safety_margin=1,
         scale_rebase_multiplier=[10])

    step("compile_circuit",
         ezkl.compile_circuit,
         model=onnx_path,
         compiled_circuit=COMPILED_PATH,
         settings_path=SETTINGS_PATH)

    print("  get_srs…", end=" ", flush=True)
    t0 = time.time()
    await ezkl.get_srs(settings_path=SETTINGS_PATH, srs_path=SRS_PATH)
    print(f"✓  {time.time()-t0:.1f}s")

    step("setup (pk + vk)",
         ezkl.setup,
         model=COMPILED_PATH,
         vk_path=VK_PATH,
         pk_path=PK_PATH,
         srs_path=SRS_PATH,
         disable_selector_compression=False)

    print("\n✓  All artifacts written to zk/training_step/")
    print("   settings.json  network.compiled  kzg.srs  pk.key  vk.key")
    print("\nNext step: python prove_step.py --shard 0 --task_id <N>")


if __name__ == "__main__":
    asyncio.run(main())
