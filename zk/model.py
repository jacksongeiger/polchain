"""
model.py — 2-layer sentiment classification network for PoLChain ZK proving.

Input:  16-element float vector of text features (all values in [-1, 1])
Output: single raw logit — apply sigmoid externally to get probability

The ONNX export intentionally omits the final Sigmoid so that EZKL only
needs lookup tables for ReLU (whose range is small). The score used on-chain
is computed as: score_0_100 = round(sigmoid(logit) * 100).

Feature layout (16 dims, all normalised to [-1, 1]):
  [0]  strong positive word density   (great, excellent, love, amazing, best)
  [1]  mild positive word density      (good, nice, fine, decent, okay)
  [2]  strong negative word density    (terrible, awful, horrible, hate, worst)
  [3]  mild negative word density      (bad, poor, mediocre, boring, dull)
  [4]  negation density                (not, never, no)
  [5]  intensifier density             (very, extremely, really, so)
  [6]  question mark flag              (0 or 1, rescaled to [-1, 1])
  [7]  exclamation density             (clipped, rescaled)
  [8]  sentence length (log-norm)
  [9]  capital letter ratio
  [10] punctuation density
  [11] positive sentiment ratio        (pos_words / total_sentiment_words)
  [12] negative sentiment ratio
  [13] avg word length (normalised)
  [14] first-word sentiment            (+1 positive / -1 negative / 0 neutral)
  [15] repeated-char flag              (e.g. "greaaat" → 1, else -1)
"""

import torch
import torch.nn as nn
import numpy as np
import onnx

torch.manual_seed(42)
np.random.seed(42)

# ---------------------------------------------------------------------------
# Architecture
# EZKL note: no Sigmoid in ONNX — raw logit output keeps the lookup table
# small. Hidden size 8 keeps weight magnitudes low and the circuit fast.
# ---------------------------------------------------------------------------

class SentimentNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.fc1 = nn.Linear(16, 8)
        self.relu = nn.ReLU()
        self.fc2 = nn.Linear(8, 1)
        # Sigmoid applied externally; omitted here to keep EZKL circuit lean

    def forward(self, x):
        x = self.relu(self.fc1(x))
        return self.fc2(x)  # raw logit

# ---------------------------------------------------------------------------
# Synthetic dataset — features normalised to [-1, 1]
# ---------------------------------------------------------------------------

def make_sample(label: int) -> np.ndarray:
    """Generate a [-1, 1]-normalised 16-dim feature vector."""
    def norm(v, lo, hi):
        """Linearly rescale v from [lo, hi] → [-1, 1]."""
        return np.clip(2.0 * (v - lo) / (hi - lo) - 1.0, -1.0, 1.0)

    if label == 1:  # positive
        sp = np.random.poisson(2.0); mp = np.random.poisson(1.5)
        sn = np.random.poisson(0.1); mn = np.random.poisson(0.2)
    else:           # negative
        sp = np.random.poisson(0.1); mp = np.random.poisson(0.3)
        sn = np.random.poisson(2.0); mn = np.random.poisson(1.5)

    neg    = np.random.poisson(0.3)
    intens = np.random.poisson(0.5)
    q      = float(np.random.rand() < 0.1)
    excl   = float(np.clip(np.random.poisson(0.4), 0, 4))
    wlen   = np.log(float(np.random.randint(5, 40)) + 1.0)
    cap    = np.clip(np.random.beta(1, 10), 0, 1)
    punct  = np.clip(np.random.beta(1, 8),  0, 1)
    total  = sp + mp + sn + mn + 1e-6
    pr     = (sp + mp) / total
    nr     = (sn + mn) / total
    awl    = np.clip(np.random.normal(0.5, 0.1), 0, 1)
    fw     = (1.0 if label == 1 and np.random.rand() < 0.6 else
             -1.0 if label == 0 and np.random.rand() < 0.6 else 0.0)
    rep    = 1.0 if np.random.rand() < 0.05 else -1.0

    return np.array([
        norm(sp,   0, 6),   # [0]
        norm(mp,   0, 5),   # [1]
        norm(sn,   0, 6),   # [2]
        norm(mn,   0, 5),   # [3]
        norm(neg,  0, 3),   # [4]
        norm(intens, 0, 4), # [5]
        2.0 * q - 1.0,      # [6]
        norm(excl, 0, 4),   # [7]
        norm(wlen, 0, 4),   # [8]
        2.0 * float(cap)   - 1.0,  # [9]
        2.0 * float(punct) - 1.0,  # [10]
        2.0 * float(pr)    - 1.0,  # [11]
        2.0 * float(nr)    - 1.0,  # [12]
        2.0 * float(awl)   - 1.0,  # [13]
        fw,                         # [14]
        rep,                        # [15]
    ], dtype=np.float32)

def make_dataset(n=2000):
    labels = np.random.randint(0, 2, n)
    X = np.stack([make_sample(l) for l in labels])
    return torch.tensor(X), torch.tensor(labels, dtype=torch.float32)

# ---------------------------------------------------------------------------
# Training
# BCEWithLogitsLoss handles sigmoid internally, so the model outputs logits.
# weight_decay keeps weight magnitudes small — critical for EZKL quantization.
# ---------------------------------------------------------------------------

def train():
    model = SentimentNet()
    X, y = make_dataset(2000)

    optimizer = torch.optim.Adam(model.parameters(), lr=3e-3, weight_decay=0.05)
    loss_fn   = nn.BCEWithLogitsLoss()

    print("Training SentimentNet on synthetic SST-2 proxy data...")
    for epoch in range(1, 31):
        model.train()
        optimizer.zero_grad()
        logits = model(X).squeeze()
        loss   = loss_fn(logits, y)
        loss.backward()
        optimizer.step()

        if epoch % 10 == 0:
            acc = ((logits > 0).float() == y).float().mean().item()
            print(f"  epoch {epoch:2d}  loss={loss.item():.4f}  acc={acc:.3f}")

    model.eval()
    with torch.no_grad():
        logits = model(X).squeeze()
        acc    = ((logits > 0).float() == y).float().mean().item()
        wmax   = max(p.abs().max().item() for p in model.parameters())
    print(f"Final train accuracy : {acc:.3f}")
    print(f"Max absolute weight  : {wmax:.4f}  (lower = ZK-friendlier)")
    return model

# ---------------------------------------------------------------------------
# ONNX export
# ---------------------------------------------------------------------------

def export_onnx(model, path="model.onnx"):
    model.eval()
    dummy = torch.zeros(1, 16)   # zeros are a safe export anchor
    torch.onnx.export(
        model,
        dummy,
        path,
        input_names=["input"],
        output_names=["output"],
        opset_version=11,
        do_constant_folding=True,
    )
    onnx.checker.check_model(onnx.load(path))
    print(f"Model exported and validated → {path}")


if __name__ == "__main__":
    model = train()
    export_onnx(model)
