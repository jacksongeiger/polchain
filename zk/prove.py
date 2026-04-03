"""
prove.py — ZK proof of MNIST digit inference using EZKL.

Visibility model:
  input_visibility  = "public"   ← pixel values revealed on-chain
  output_visibility = "public"   ← digit logits revealed on-chain
  param_visibility  = "private"  ← model weights never revealed

The proof lets a miner say:
  "I ran a model that produced digit logits on this 28×28 image,
   and I can prove it cryptographically without showing the weights."

Run: python3 prove.py   (from zk/ directory)
"""

import asyncio
import json
import os
import math
import ezkl

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
MODEL_PATH    = "model.onnx"
INPUT_PATH    = "input.json"
SETTINGS_PATH = "settings.json"
COMPILED_PATH = "network.compiled"
SRS_PATH      = "kzg.srs"
PK_PATH       = "pk.key"
VK_PATH       = "vk.key"
WITNESS_PATH  = "witness.json"
PROOF_PATH    = "proof.json"

# ---------------------------------------------------------------------------
# Sample input — a blank (all-zero) 28×28 canvas, flattened to 784 floats.
# Zero pixels are a safe ONNX / EZKL export anchor: they produce small
# intermediate values, which keeps the KZG circuit compact.
# ---------------------------------------------------------------------------
SAMPLE_INPUT = [0.0] * 784


def write_input():
    data = {"input_data": [SAMPLE_INPUT]}
    with open(INPUT_PATH, "w") as f:
        json.dump(data, f)


def run_inference_check():
    """Quick forward pass via ONNX Runtime to confirm output shape."""
    try:
        import onnxruntime as ort
        import numpy as np
    except ImportError:
        print("  (onnxruntime not installed — skipping plain inference check)")
        return None

    x = np.array([SAMPLE_INPUT], dtype=np.float32)
    sess = ort.InferenceSession(MODEL_PATH)
    logits = sess.run(None, {"input": x})[0][0]   # shape: (10,)

    probs  = [math.exp(l) for l in logits]
    total  = sum(probs)
    probs  = [p / total for p in probs]
    digit  = int(max(range(10), key=lambda i: logits[i]))
    conf   = probs[digit]

    print(f"  Logits           : {[round(l, 3) for l in logits]}")
    print(f"  Predicted digit  : {digit}  (confidence {conf:.1%})")
    return digit, conf


async def main():
    assert os.path.exists(MODEL_PATH), \
        f"{MODEL_PATH} not found — run `python3 model.py` first"

    print("=== PoLChain ZK Proof of MNIST Inference ===\n")

    print("[ 0/7 ] Running plain inference to confirm output shape...")
    run_inference_check()
    print()

    print("[ 1/7 ] Writing input.json...")
    write_input()

    print("[ 2/7 ] Generating circuit settings...")
    py_run_args = ezkl.PyRunArgs()
    py_run_args.input_visibility  = "public"
    py_run_args.output_visibility = "public"
    py_run_args.param_visibility  = "private"
    py_run_args.decomp_legs       = 3

    ezkl.gen_settings(
        model=MODEL_PATH,
        output=SETTINGS_PATH,
        py_run_args=py_run_args,
    )

    print("[ 3/7 ] Calibrating settings (~30s)...")
    ezkl.calibrate_settings(
        data=INPUT_PATH,
        model=MODEL_PATH,
        settings=SETTINGS_PATH,
        target="resources",
        lookup_safety_margin=1,
        scale_rebase_multiplier=[10],
    )

    print("[ 4/7 ] Compiling arithmetic circuit...")
    ezkl.compile_circuit(
        model=MODEL_PATH,
        compiled_circuit=COMPILED_PATH,
        settings_path=SETTINGS_PATH,
    )

    print("[ 5/7 ] Fetching SRS (~MB on first run)...")
    await ezkl.get_srs(settings_path=SETTINGS_PATH, srs_path=SRS_PATH)

    print("[ 6/7 ] Generating proving key and verifying key...")
    ezkl.setup(
        model=COMPILED_PATH,
        vk_path=VK_PATH,
        pk_path=PK_PATH,
        srs_path=SRS_PATH,
        disable_selector_compression=False,
    )

    print("[ 7/7 ] Generating witness...")
    ezkl.gen_witness(
        data=INPUT_PATH,
        model=COMPILED_PATH,
        output=WITNESS_PATH,
        vk_path=VK_PATH,
        srs_path=SRS_PATH,
    )

    print("\n[ PROVING ] Generating ZK proof...")
    ezkl.prove(
        witness=WITNESS_PATH,
        model=COMPILED_PATH,
        pk_path=PK_PATH,
        proof_path=PROOF_PATH,
        srs_path=SRS_PATH,
    )

    print("[ VERIFYING ] Verifying proof...")
    ok = ezkl.verify(
        proof_path=PROOF_PATH,
        settings_path=SETTINGS_PATH,
        vk_path=VK_PATH,
        srs_path=SRS_PATH,
        reduced_srs=False,
    )

    proof_kb = os.path.getsize(PROOF_PATH) / 1024
    print("\n=== Result ===")
    print(f"  Proof valid  : {ok}")
    print(f"  Proof file   : {PROOF_PATH}  ({proof_kb:.1f} KB)")
    print()
    print("The proof cryptographically guarantees that this digit prediction")
    print("came from a correctly-structured forward pass without revealing weights.")


if __name__ == "__main__":
    asyncio.run(main())
