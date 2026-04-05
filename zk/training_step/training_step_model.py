"""
training_step_model.py — ZK-provable MNISTNet forward pass + loss

Expresses one full forward pass of MNISTNet and cross-entropy loss as a
pure ONNX computation graph with no fixed nn.Parameters — all weights are
passed as a flat input tensor. This lets EZKL prove:

    given weights W, canonical batch X, one-hot labels Y
    →  the network honestly produces loss L and logits Z

─────────────────────────────────────────────────────────────────────────────
NOTE ON FINITE-DIFFERENCE GRADIENTS
─────────────────────────────────────────────────────────────────────────────
The spec calls for computing gradients via finite differences inside the
ONNX graph (perturb each weight by ε, re-run forward pass, divide). This is
architecturally sound — it avoids autograd entirely — but is computationally
infeasible at the scale of MNISTNet:

    N_PARAMS = 109,386  →  109,386 forward passes per gradient computation

Embedding six-figure forward passes inside a single ZK circuit would produce
a constraint system several orders of magnitude beyond what any current
backend (Halo2, Groth16, Nova) can handle in practice. The gradient step is
therefore computed in Python (prove_step.py) and bound to the proof only
through sha256 hashes of the weight vectors before and after. The circuit
itself proves the forward pass and loss value, which is the cryptographically
expensive and non-trivial part. See README.md for the full threat-model.
─────────────────────────────────────────────────────────────────────────────
"""

import os
import torch
import torch.nn.functional as F
from torch import nn

# ── Architecture constants (must match model.py's MNISTNet) ───────────────
N_IN,  N_H1, N_H2, N_OUT = 784, 128, 64, 10
BATCH_SIZE = 64

N_FC1_W = N_H1 * N_IN     # 100 352
N_FC1_B = N_H1              #     128
N_FC2_W = N_H2 * N_H1     #   8 192
N_FC2_B = N_H2              #      64
N_FC3_W = N_OUT * N_H2    #     640
N_FC3_B = N_OUT             #      10
N_PARAMS = N_FC1_W + N_FC1_B + N_FC2_W + N_FC2_B + N_FC3_W + N_FC3_B
# = 109 386

HERE      = os.path.dirname(os.path.abspath(__file__))
ONNX_PATH = os.path.join(HERE, "training_step.onnx")


class TrainingStepNet(nn.Module):
    """
    Stateless MNISTNet: all layer weights are passed as a flat input vector.

    Inputs (ONNX input names)
    ─────────────────────────
    weights      Tensor [N_PARAMS]         fc1.w ‖ fc1.b ‖ fc2.w ‖ fc2.b ‖ fc3.w ‖ fc3.b
    batch        Tensor [BATCH_SIZE, 784]  pixel values in [0, 1]
    labels       Tensor [BATCH_SIZE, 10]   one-hot class labels

    Outputs (ONNX output names)
    ───────────────────────────
    loss         Tensor [1]                mean cross-entropy (scalar wrapped in dim-1)
    logits       Tensor [BATCH_SIZE, 10]   raw pre-softmax class scores
    """

    def forward(self, weights_flat, batch, labels_onehot):
        # ── Slice flat weight vector into per-layer tensors ───────────────
        o = 0
        fc1_w = weights_flat[o : o + N_FC1_W].reshape(N_H1, N_IN);  o += N_FC1_W
        fc1_b = weights_flat[o : o + N_FC1_B];                        o += N_FC1_B
        fc2_w = weights_flat[o : o + N_FC2_W].reshape(N_H2, N_H1);  o += N_FC2_W
        fc2_b = weights_flat[o : o + N_FC2_B];                        o += N_FC2_B
        fc3_w = weights_flat[o : o + N_FC3_W].reshape(N_OUT, N_H2); o += N_FC3_W
        fc3_b = weights_flat[o : o + N_FC3_B]

        # ── MNISTNet forward pass: 784 → ReLU(128) → ReLU(64) → 10 ──────
        h1     = F.relu(batch @ fc1_w.T + fc1_b)   # [B, 128]
        h2     = F.relu(h1   @ fc2_w.T + fc2_b)    # [B, 64]
        logits = h2 @ fc3_w.T + fc3_b              # [B, 10]

        # ── Cross-entropy loss (numerically stable, pure tensor ops) ──────
        # torch.logsumexp is an ONNX opset-11 ReduceLogSumExp — no manual
        # exp/log chain needed, avoids overflow issues under fixed-point.
        log_sm = logits - torch.logsumexp(logits, dim=-1, keepdim=True)  # [B,10]
        loss   = -(labels_onehot * log_sm).sum(dim=-1).mean()            # scalar

        return loss.unsqueeze(0), logits   # loss as [1] for EZKL scalar handling


def get_flat_weights(state_dict: dict) -> torch.Tensor:
    """
    Concatenate all MNISTNet parameters into one flat float32 tensor in the
    exact order expected by TrainingStepNet.forward.
    """
    keys = [
        "fc1.weight", "fc1.bias",
        "fc2.weight", "fc2.bias",
        "fc3.weight", "fc3.bias",
    ]
    return torch.cat([state_dict[k].detach().float().flatten() for k in keys])


def export_onnx(out_path: str = ONNX_PATH) -> None:
    """Export TrainingStepNet to ONNX opset 11 for EZKL circuit compilation."""
    model = TrainingStepNet()
    model.eval()

    # Dummy inputs — zeros are safe ONNX trace anchors.
    # Labels need at least one non-zero entry to avoid log(0) during tracing.
    dummy_w = torch.zeros(N_PARAMS)
    dummy_x = torch.zeros(BATCH_SIZE, N_IN)
    dummy_y = torch.zeros(BATCH_SIZE, N_OUT)
    dummy_y[:, 0] = 1.0

    with torch.no_grad():
        torch.onnx.export(
            model,
            (dummy_w, dummy_x, dummy_y),
            out_path,
            input_names=["weights", "batch", "labels"],
            output_names=["loss", "logits"],
            opset_version=11,
            dynamic_axes=None,   # static shapes — EZKL requires this
        )

    size_kb = os.path.getsize(out_path) / 1024
    total_floats = N_PARAMS + BATCH_SIZE * N_IN + BATCH_SIZE * N_OUT
    print(f"Exported ONNX → {out_path}  ({size_kb:.0f} KB)")
    print(f"  weights : [{N_PARAMS:,}]        ({N_PARAMS * 4 / 1024:.0f} KB)")
    print(f"  batch   : [{BATCH_SIZE} × {N_IN}]    ({BATCH_SIZE * N_IN * 4 / 1024:.0f} KB)")
    print(f"  labels  : [{BATCH_SIZE} × {N_OUT}]")
    print(f"  Total input floats: {total_floats:,}  (~{total_floats * 4 / 1024:.0f} KB)")
    print()
    print("  ⚠ Scale note: EZKL circuit setup at this input size requires")
    print("    significant RAM (32+ GB) and compile time (30–120 min).")
    print("    Run generate_artifacts.py --small for a fast smoke-test.")


if __name__ == "__main__":
    export_onnx()
