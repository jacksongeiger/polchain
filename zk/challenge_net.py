"""
challenge_net.py — fixed-shape batched MNIST circuit for Era 2 proven scores.

Era 1's circuit proved a single digit inference with the score self-reported
beside it. Era 2's circuit is a fixed-shape batch forward pass over the
per-task challenge batch:

    input  x       : [N, 784]   visibility "hashed"  → Poseidon digest(s) become
                                 public instances the contract pins per batch
    output logits  : [N, 10]    visibility "public"  → the contract computes the
                                 score from these via signed-field argmax
    params         : private    → weights are witness values; the proving key
                                 depends only on circuit structure, so one
                                 frozen pk serves every model of this shape

No argmax and no labels live in-circuit — counting correct predictions is
auditable Solidity, not a novel EZKL surface.

The challenge pool is MNIST test indices [2000, 4000) — disjoint from the
first 2000 test images that produce the displayed global-accuracy figure.
"""

import json
import os
import sys

import torch
import onnx

ZK_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ZK_DIR)

from model import MNISTNet, _load_flat_mnist  # noqa: E402

CHALLENGE_POOL_START = 2000
CHALLENGE_POOL_END   = 4000


def load_challenge_pool():
    """Return (X_pool [2000,784], y_pool [2000]) — held-out challenge images."""
    _, _, X_test, y_test = _load_flat_mnist()
    return (X_test[CHALLENGE_POOL_START:CHALLENGE_POOL_END],
            y_test[CHALLENGE_POOL_START:CHALLENGE_POOL_END])


def get_challenge_batch(batch_idx: int, n: int):
    """Fixed batch `batch_idx` of size `n` from the pool. Returns (X [n,784], y [n])."""
    X_pool, y_pool = load_challenge_pool()
    num_batches = len(X_pool) // n
    if not 0 <= batch_idx < num_batches:
        raise ValueError(f"batch_idx {batch_idx} out of range (0..{num_batches - 1})")
    s = batch_idx * n
    return X_pool[s:s + n], y_pool[s:s + n]


def export_challenge_onnx(state_dict, n: int, path: str):
    """Export MNISTNet with the given weights as a fixed [n,784]→[n,10] ONNX graph."""
    model = MNISTNet()
    model.load_state_dict(state_dict)
    model.eval()
    dummy = torch.zeros(n, 784)
    # dynamo=False forces the legacy TorchScript exporter: native opset 11,
    # the graph shape EZKL's parser was validated against in Era 1.
    torch.onnx.export(
        model, dummy, path,
        input_names=["input"], output_names=["output"],
        opset_version=11, do_constant_folding=True, dynamo=False,
    )
    onnx.checker.check_model(onnx.load(path))
    return path


def write_batch_input_json(X: torch.Tensor, path: str):
    """EZKL input file for one challenge batch: a single flattened [n*784] tensor."""
    with open(path, "w") as f:
        json.dump({"input_data": [X.flatten().tolist()]}, f)
    return path
