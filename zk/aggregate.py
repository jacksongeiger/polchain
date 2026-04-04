"""
aggregate.py — Incremental FedAvg model aggregation for PoLChain.

Called by miningLoop.js after each block is finalized:
    python3 zk/aggregate.py --task_id 5 --winner_score 87

Trains only the ONE shard corresponding to the winning miner
(shard_id = task_id % 4), then applies FedAvg between the existing
global model and that new shard. This is incremental: each block
improves the model by one shard rather than retraining all 4 from scratch.
"""

import argparse
import json
import os
import sys
import torch

# Allow importing model.py from this directory
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from model import MNISTNet, get_shards, train_shard, N_SHARDS   # noqa: E402

ZK_DIR     = os.path.dirname(os.path.abspath(__file__))
LOG_PATH   = os.path.join(ZK_DIR, "accuracy_log.json")
MODEL_PATH = os.path.join(ZK_DIR, "global_model.pth")


def fedavg(models):
    """Equally weighted average of all model parameters."""
    n = len(models)
    avg_state = {}
    for key in models[0].state_dict():
        avg_state[key] = sum(m.state_dict()[key].float() for m in models) / n
    return avg_state


def weighted_fedavg(global_model, shard_model, alpha: float):
    """Weighted merge: alpha * global + (1-alpha) * shard."""
    avg_state = {}
    gs = global_model.state_dict()
    ss = shard_model.state_dict()
    for key in gs:
        avg_state[key] = alpha * gs[key].float() + (1.0 - alpha) * ss[key].float()
    return avg_state


def main():
    print(f"[aggregate] sys.argv={sys.argv}", flush=True)

    parser = argparse.ArgumentParser()
    parser.add_argument("--task_id",      type=int, required=True)
    parser.add_argument("--winner_score", type=int, default=0)
    args = parser.parse_args()

    print(f"[aggregate] parsed: task_id={args.task_id}  winner_score={args.winner_score}",
          flush=True)

    # Which shard does this block's winner own?
    shard_id = args.task_id % N_SHARDS
    print(f"[aggregate] Winning shard: {shard_id}  (task_id {args.task_id} % {N_SHARDS})",
          flush=True)

    _, X_test, y_test = get_shards()

    # Load existing global model to warm-start shard training and for FedAvg
    global_state = None
    if os.path.exists(MODEL_PATH):
        try:
            global_state = torch.load(MODEL_PATH, weights_only=True)
            print(f"[aggregate] Loaded existing global model from {MODEL_PATH}", flush=True)
        except Exception as e:
            print(f"[aggregate] Warning: could not load {MODEL_PATH}: {e} — starting fresh",
                  flush=True)
    else:
        print("[aggregate] No existing model found — starting from random weights", flush=True)

    # Train only the winning shard (warm-started from current global model)
    seed = args.task_id * 10 + shard_id
    print(f"[aggregate] Training shard {shard_id} (seed={seed}, 1 epoch)…", flush=True)
    new_shard, shard_acc = train_shard(shard_id, n_epochs=1, seed=seed,
                                       initial_state=global_state)
    print(f"[aggregate] Shard {shard_id} accuracy: {shard_acc:.3f}", flush=True)

    # FedAvg: merge existing global model with the new shard.
    # If shard improves on the global, do equal 50/50 merge.
    # If shard is weaker, do 80/20 favoring the existing global to prevent degradation.
    if global_state is not None:
        prior = MNISTNet()
        prior.load_state_dict(global_state)

        # Evaluate current global accuracy before merging
        prior.eval()
        with torch.no_grad():
            global_acc = (prior(X_test).argmax(1) == y_test).float().mean().item()
        print(f"[aggregate] Current global accuracy: {global_acc:.4f}", flush=True)

        if shard_acc > global_acc:
            avg_state = fedavg([prior, new_shard])
            print(
                f"[aggregate] FedAvg 50/50 — shard ({shard_acc:.4f}) > global ({global_acc:.4f})",
                flush=True,
            )
        else:
            avg_state = weighted_fedavg(prior, new_shard, alpha=0.8)
            print(
                f"[aggregate] FedAvg 80/20 — shard ({shard_acc:.4f}) ≤ global ({global_acc:.4f}), preserving global",
                flush=True,
            )
    else:
        # First block ever — new shard becomes the global model directly
        avg_state = new_shard.state_dict()
        print("[aggregate] First block — new shard becomes global model", flush=True)

    # Evaluate the updated global model
    global_model = MNISTNet()
    global_model.load_state_dict(avg_state)
    global_model.eval()

    with torch.no_grad():
        logits   = global_model(X_test)
        accuracy = (logits.argmax(1) == y_test).float().mean().item()
        score    = round(accuracy * 100)

    print(f"[aggregate] Global model accuracy: {accuracy:.4f}  score={score}/100", flush=True)

    torch.save(avg_state, MODEL_PATH)
    print(f"[aggregate] Saved global model → {MODEL_PATH}", flush=True)

    # Append to accuracy log
    log = []
    if os.path.exists(LOG_PATH):
        try:
            with open(LOG_PATH) as f:
                log = json.load(f)
        except Exception:
            log = []

    log.append({
        "task_id":      args.task_id,
        "shard_id":     shard_id,
        "accuracy":     round(accuracy, 4),
        "score":        score,
        "winner_score": args.winner_score,
    })

    with open(LOG_PATH, "w") as f:
        json.dump(log, f, indent=2)

    print(f"[aggregate] Updated {LOG_PATH}  ({len(log)} entries)", flush=True)


if __name__ == "__main__":
    main()
