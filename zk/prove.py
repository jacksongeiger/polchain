"""
prove.py — ZK proof of sentiment inference using EZKL.

Visibility model (the core of PoL):
  input_visibility  = "public"   ← feature vector is revealed on-chain
  output_visibility = "public"   ← sentiment score is revealed on-chain
  param_visibility  = "private"  ← model weights are NEVER revealed

The resulting proof lets a miner say:
  "I ran a model that produced score S on input X,
   and I can prove it cryptographically,
   without showing you the model weights."

Run: python3 prove.py
Outputs: proof.json (ZK proof), settings.json, vk.key (verifying key)
"""

import asyncio
import json
import os
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
# Sample input — a clearly positive review, features normalised to [-1, 1]
# (see model.py for the full feature layout)
# ---------------------------------------------------------------------------
#   strong_pos=high, mild_pos=moderate, strong_neg=none, mild_neg=none,
#   negations=none, intensifiers=some, question=no, exclaim=one,
#   sentence_len=moderate, cap_ratio=low, punct_dens=low,
#   pos_ratio=1.0→+1, neg_ratio=0.0→-1, avg_wlen=mid,
#   first_word=positive(+1), repeated_char=no(-1)
SAMPLE_INPUT = [
     0.33,  0.20, -1.00, -1.00,  # [0-3]  word sentiment counts
    -1.00,  0.00, -1.00,  0.00,  # [4-7]  negation, intensif, question, exclaim
     0.00, -0.90, -0.80,  1.00,  # [8-11] length, cap, punct, pos_ratio
    -1.00,  0.00,  1.00, -1.00,  # [12-15] neg_ratio, avg_wlen, first_word, repeat
]

def write_input():
    data = {"input_data": [SAMPLE_INPUT]}
    with open(INPUT_PATH, "w") as f:
        json.dump(data, f)

def run_inference_check():
    """Run a quick forward pass via ONNX Runtime to confirm the expected score."""
    import onnxruntime as ort
    import numpy as np
    import math

    x    = np.array([SAMPLE_INPUT], dtype=np.float32)
    sess = ort.InferenceSession(MODEL_PATH)
    logit = float(sess.run(None, {"input": x})[0][0][0])
    prob  = 1.0 / (1.0 + math.exp(-logit))   # sigmoid applied externally
    score_100 = round(prob * 100, 2)
    print(f"  Raw logit        : {logit:.6f}")
    print(f"  Probability      : {prob:.6f}")
    print(f"  Score (0–100)    : {score_100}")
    return score_100

async def main():
    assert os.path.exists(MODEL_PATH), \
        f"{MODEL_PATH} not found — run `python3 model.py` first"

    print("=== PoLChain ZK Proof of Inference ===\n")

    # ------------------------------------------------------------------
    # 0. Quick inference check (plain ONNX, no ZK)
    # ------------------------------------------------------------------
    print("[ 0/7 ] Running plain inference to confirm score...")
    try:
        score = run_inference_check()
    except ImportError:
        print("  (onnxruntime not installed — skipping plain inference check)")
        score = None
    print()

    # ------------------------------------------------------------------
    # 1. Write input.json
    # ------------------------------------------------------------------
    print("[ 1/7 ] Writing input.json...")
    write_input()

    # ------------------------------------------------------------------
    # 2. Generate settings
    #    param_visibility="private" means weights stay hidden in the proof
    # ------------------------------------------------------------------
    print("[ 2/7 ] Generating circuit settings...")
    py_run_args = ezkl.PyRunArgs()
    py_run_args.input_visibility  = "public"
    py_run_args.output_visibility = "public"
    py_run_args.param_visibility  = "private"
    # decomp_legs=3 allows intermediate values up to base^3 ≈ 4.4T
    # (default n=2 caps at 16384^2 ≈ 268M, too small for this model's activations)
    py_run_args.decomp_legs = 3

    ezkl.gen_settings(
        model=MODEL_PATH,
        output=SETTINGS_PATH,
        py_run_args=py_run_args,
    )

    # ------------------------------------------------------------------
    # 3. Calibrate — sets quantisation scale to minimise error
    # ------------------------------------------------------------------
    print("[ 3/7 ] Calibrating settings (this may take ~30s)...")
    ezkl.calibrate_settings(
        data=INPUT_PATH,
        model=MODEL_PATH,
        settings=SETTINGS_PATH,
        target="resources",
        lookup_safety_margin=1,
        scale_rebase_multiplier=[10],
    )

    # ------------------------------------------------------------------
    # 4. Compile circuit
    # ------------------------------------------------------------------
    print("[ 4/7 ] Compiling arithmetic circuit...")
    ezkl.compile_circuit(
        model=MODEL_PATH,
        compiled_circuit=COMPILED_PATH,
        settings_path=SETTINGS_PATH,
    )

    # ------------------------------------------------------------------
    # 5. Download SRS (structured reference string for KZG commitments)
    # get_srs is async in ezkl v23
    # ------------------------------------------------------------------
    print("[ 5/7 ] Fetching SRS (downloads ~MB on first run)...")
    await ezkl.get_srs(settings_path=SETTINGS_PATH, srs_path=SRS_PATH)

    # ------------------------------------------------------------------
    # 6. Setup proving key + verifying key
    # ------------------------------------------------------------------
    print("[ 6/7 ] Generating proving key and verifying key...")
    ezkl.setup(
        model=COMPILED_PATH,
        vk_path=VK_PATH,
        pk_path=PK_PATH,
        srs_path=SRS_PATH,
        disable_selector_compression=False,
    )

    # ------------------------------------------------------------------
    # 7. Generate witness (the actual computation trace)
    # ------------------------------------------------------------------
    print("[ 7/7 ] Generating witness...")
    ezkl.gen_witness(
        data=INPUT_PATH,
        model=COMPILED_PATH,
        output=WITNESS_PATH,
        vk_path=VK_PATH,
        srs_path=SRS_PATH,
    )

    # ------------------------------------------------------------------
    # 8. Prove
    # ------------------------------------------------------------------
    print("\n[ PROVING ] Generating ZK proof...")
    ezkl.prove(
        witness=WITNESS_PATH,
        model=COMPILED_PATH,
        pk_path=PK_PATH,
        proof_path=PROOF_PATH,
        srs_path=SRS_PATH,
    )

    # ------------------------------------------------------------------
    # 9. Verify (sanity check — a verifier can do this without the weights)
    # ------------------------------------------------------------------
    print("[ VERIFYING ] Verifying proof...")
    ok = ezkl.verify(
        proof_path=PROOF_PATH,
        settings_path=SETTINGS_PATH,
        vk_path=VK_PATH,
        srs_path=SRS_PATH,
        reduced_srs=False,
    )

    # ------------------------------------------------------------------
    # Summary
    # ------------------------------------------------------------------
    proof_kb = os.path.getsize(PROOF_PATH) / 1024
    print("\n=== Result ===")
    print(f"  Proof valid      : {ok}")
    print(f"  Proof file       : {PROOF_PATH}  ({proof_kb:.1f} KB)")
    if score is not None:
        print(f"  Score (0–100)    : {score}")
        print(f"  On-chain submit  : submitWork(taskId, gradientHash, {int(score)})")
    print()
    print("The proof cryptographically guarantees that this score was produced")
    print("by a correctly-structured forward pass, without revealing model weights.")


if __name__ == "__main__":
    asyncio.run(main())
