"""
model.py — MNISTNet digit classifier for PoLChain ZK proving.

Architecture: 784 → ReLU(128) → ReLU(64) → 10  (raw logits, softmax external)
Dataset:      Real MNIST, 4 shards × 10k samples + 2k global test set.
Score:        round(test_accuracy × 100)   →  0–100 integer on-chain.

Run standalone to train shard 0 and export model.onnx:
    python3 zk/model.py
"""

import os
import torch
import torch.nn as nn
import numpy as np
import onnx
import torchvision.transforms.functional as TF
from torchvision import datasets, transforms

torch.manual_seed(42)
np.random.seed(42)

DATA_DIR   = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
N_SHARDS   = 4
SHARD_SIZE = 10_000
TEST_SIZE  = 2_000


# ---------------------------------------------------------------------------
# Architecture
# ---------------------------------------------------------------------------

class MNISTNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.fc1   = nn.Linear(784, 128)
        self.relu1 = nn.ReLU()
        self.fc2   = nn.Linear(128, 64)
        self.relu2 = nn.ReLU()
        self.fc3   = nn.Linear(64, 10)

    def forward(self, x):
        x = self.relu1(self.fc1(x))
        x = self.relu2(self.fc2(x))
        return self.fc3(x)   # raw logits — softmax applied externally


# ---------------------------------------------------------------------------
# Data helpers
# ---------------------------------------------------------------------------

def _load_flat_mnist():
    """Download MNIST (once) and return flat float tensors."""
    tfm = transforms.ToTensor()
    train_ds = datasets.MNIST(DATA_DIR, train=True,  download=True, transform=tfm)
    test_ds  = datasets.MNIST(DATA_DIR, train=False, download=True, transform=tfm)

    def flat(ds):
        X = ds.data.float() / 255.0
        return X.view(-1, 784), ds.targets

    return *flat(train_ds), *flat(test_ds)


def get_shards():
    """
    Returns:
        shards  — list of 4 × (X_shard [10000,784], y_shard [10000])
        X_test  — [2000, 784] global test set
        y_test  — [2000] global test labels
    """
    X_train, y_train, X_test, y_test = _load_flat_mnist()

    shards = []
    for i in range(N_SHARDS):
        start = i * SHARD_SIZE
        shards.append((X_train[start : start + SHARD_SIZE],
                       y_train[start : start + SHARD_SIZE]))

    return shards, X_test[:TEST_SIZE], y_test[:TEST_SIZE]


# ---------------------------------------------------------------------------
# Augmentation
# ---------------------------------------------------------------------------

def _augment(X: torch.Tensor, augmentation, rng_seed: int) -> torch.Tensor:
    """Apply data augmentation to flat [N, 784] tensor. Returns augmented copy."""
    if not augmentation or augmentation == "none":
        return X

    g = torch.Generator()
    g.manual_seed(rng_seed)

    if augmentation == "noise":
        return (X + torch.randn(X.shape, generator=g) * 0.1).clamp(0.0, 1.0)

    imgs = X.view(-1, 1, 28, 28)

    if augmentation == "rotation":
        angle = (torch.rand(1, generator=g).item() * 2 - 1) * 15   # ±15°
        imgs  = TF.rotate(imgs, angle)

    elif augmentation == "erasing":
        frac = 0.10 + torch.rand(1, generator=g).item() * 0.10     # 10–20% area
        side = max(1, int(round((frac * 784) ** 0.5)))              # ~9–13 px
        r0   = torch.randint(0, max(1, 28 - side), (1,), generator=g).item()
        c0   = torch.randint(0, max(1, 28 - side), (1,), generator=g).item()
        imgs = imgs.clone()
        imgs[:, :, r0:r0 + side, c0:c0 + side] = 0.0

    return imgs.view(-1, 784)


# ---------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------

def train_shard(shard_id: int, n_epochs: int = 3, seed: int = 42, initial_state=None,
                augmentation=None, focus_digits=None):
    """
    Train a MNISTNet on one shard, evaluate on the global test set.

    Args:
        initial_state — optional state_dict to warm-start from (e.g. previous global model)
        augmentation  — one of "rotation", "noise", "erasing", "none"/None
        focus_digits  — optional list of digit labels to oversample 3× via WeightedRandomSampler

    Returns:
        model     — trained MNISTNet (eval mode)
        accuracy  — float, accuracy on global test set (0.0–1.0)
    """
    torch.manual_seed(seed)
    shards, X_test, y_test = get_shards()
    X_shard, y_shard = shards[shard_id % N_SHARDS]

    model = MNISTNet()
    if initial_state is not None:
        model.load_state_dict(initial_state)
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
    loss_fn   = nn.CrossEntropyLoss()

    # Build a WeightedRandomSampler that oversamples focus_digits 3× relative to others.
    # Weights are based on original labels, sampler indices apply to the augmented tensor.
    sampler = None
    if focus_digits:
        fd_tensor = torch.tensor(list(focus_digits), dtype=torch.long)
        weights   = torch.where(
            torch.isin(y_shard, fd_tensor),
            torch.full((len(y_shard),), 3.0),
            torch.ones(len(y_shard)),
        )
        sampler = torch.utils.data.WeightedRandomSampler(
            weights, num_samples=len(y_shard), replacement=True
        )
        print(f"  focus_digits={focus_digits} → 3× oversampling via WeightedRandomSampler")

    aug_label = augmentation or "none"
    print(f"Training shard {shard_id} ({len(X_shard)} samples, {n_epochs} epochs, aug={aug_label})…")
    for epoch in range(1, n_epochs + 1):
        X_aug = _augment(X_shard, augmentation, rng_seed=seed * 1000 + epoch)
        model.train()

        if sampler is not None:
            aug_ds = torch.utils.data.TensorDataset(X_aug, y_shard)
            loader = torch.utils.data.DataLoader(aug_ds, batch_size=256, sampler=sampler)
            batch_losses = []
            for X_b, y_b in loader:
                optimizer.zero_grad()
                loss = loss_fn(model(X_b), y_b)
                loss.backward()
                optimizer.step()
                batch_losses.append(loss.item())
            loss_val = sum(batch_losses) / len(batch_losses)
        else:
            optimizer.zero_grad()
            loss = loss_fn(model(X_aug), y_shard)
            loss.backward()
            optimizer.step()
            loss_val = loss.item()

        model.eval()
        with torch.no_grad():
            acc = (model(X_test).argmax(1) == y_test).float().mean().item()
        print(f"  epoch {epoch}  loss={loss_val:.4f}  test_acc={acc:.3f}")

    model.eval()
    with torch.no_grad():
        accuracy = (model(X_test).argmax(1) == y_test).float().mean().item()

    print(f"Shard {shard_id} final test accuracy: {accuracy:.3f}  "
          f"score: {round(accuracy * 100)}/100")
    return model, accuracy


# ---------------------------------------------------------------------------
# ONNX export
# ---------------------------------------------------------------------------

def export_onnx(model, path="model.onnx"):
    model.eval()
    dummy = torch.zeros(1, 784)
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
    model, accuracy = train_shard(shard_id=0)
    onnx_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "model.onnx")
    export_onnx(model, onnx_path)
    print(f"\nFinal accuracy: {accuracy:.3f}   Score: {round(accuracy * 100)}/100")
