"""
challenge_pool.py — generate the Era-2 challenge pool commitments.

FREEZE ORDER (no exceptions): the Era-2 circuit settings were calibrated on
adversarially-grown weights and frozen by the spike. This script runs ONLY
against that final frozen circuit: each batch's Poseidon commitment comes from
`ezkl.gen_witness` `processed_inputs.poseidon_hash` — the only reliable source
of EZKL's padding/chunking (there is no external spec). G3 proved the
commitment is a function of the batch alone, so witnesses suffice; no proving
needed. Any recalibration after this emits invalidates every commitment inside
an immutable contract — that is a forced new era, not a patch.

Pool: MNIST test indices [2000, 4000) — disjoint from the 2000-image set that
produces the displayed global-accuracy figure. 250 fixed batches of N=8.

Run (minutes):  .venv/bin/python zk/challenge_pool.py
Emits:          zk/challenge_commitments.json
"""

import json
import os
import sys
import time

ZK_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ZK_DIR)

import ezkl  # noqa: E402
import torch  # noqa: E402
from challenge_net import (  # noqa: E402
    export_challenge_onnx, load_challenge_pool, write_batch_input_json,
)

N          = 8
V2_DIR     = os.path.join(ZK_DIR, "v2")
OUT_PATH   = os.path.join(ZK_DIR, "challenge_commitments.json")
SETTINGS   = os.path.join(V2_DIR, "settings.json")
COMPILED   = os.path.join(V2_DIR, "network.compiled")
TMP_INPUT  = os.path.join(V2_DIR, "_pool_input.json")
TMP_WITNESS = os.path.join(V2_DIR, "_pool_witness.json")


def le_hex_to_be(hex_le: str) -> str:
    return "0x" + bytes.fromhex(hex_le)[::-1].hex()


def main():
    assert os.path.exists(SETTINGS) and os.path.exists(COMPILED), (
        "zk/v2/ frozen circuit missing — promote the spike artifacts first"
    )

    X_pool, y_pool = load_challenge_pool()
    num_batches = len(X_pool) // N
    print(f"Pool: {len(X_pool)} images → {num_batches} batches of {N}")

    batches = []
    t0 = time.time()
    for idx in range(num_batches):
        X = X_pool[idx * N:(idx + 1) * N]
        y = y_pool[idx * N:(idx + 1) * N].tolist()
        write_batch_input_json(X, TMP_INPUT)
        ezkl.gen_witness(data=TMP_INPUT, model=COMPILED, output=TMP_WITNESS)
        with open(TMP_WITNESS) as f:
            w = json.load(f)
        hashes = w["processed_inputs"]["poseidon_hash"]
        assert len(hashes) == 1, f"batch {idx}: expected 1 hash instance, got {len(hashes)}"
        packed = sum(l << (i * 4) for i, l in enumerate(y))
        batches.append({
            "idx": idx,
            "commitment": le_hex_to_be(hashes[0]),
            "labels": y,
            "packedLabels": str(packed),
        })
        if (idx + 1) % 25 == 0:
            rate = (idx + 1) / (time.time() - t0)
            print(f"  {idx + 1}/{num_batches}  ({rate:.1f} batches/s)")

    out = {
        "n": N,
        "numBatches": num_batches,
        "poolIndices": [2000, 4000],
        "settingsPath": "zk/v2/settings.json",
        "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "batches": batches,
    }
    with open(OUT_PATH, "w") as f:
        json.dump(out, f, indent=1)
    print(f"\n{num_batches} commitments → {OUT_PATH}")
    print("FROZEN: any circuit recalibration from here on is a forced new era.")

    # cleanup temps
    for p in (TMP_INPUT, TMP_WITNESS):
        if os.path.exists(p):
            os.remove(p)


if __name__ == "__main__":
    main()
