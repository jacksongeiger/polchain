"""
run.py — Era-2 research experiment runner.

    .venv/bin/python zk/experiments/run.py --suite cotrain
    .venv/bin/python zk/experiments/run.py --suite crossover

Artifacts are append-only JSON in zk/experiments/<suite>.json with enough
method detail that a skeptic can rerun them. Charts render in the Science
view; each suite proves exactly one sentence:

  cotrain   — "Federated aggregation trains a model that no participant could
               train alone, without any participant revealing its data."
  crossover — "Proof cost scales as a measurable curve; here is where the
               verification tax sits today on consumer hardware."
"""

import argparse
import json
import os
import sys
import time

import numpy as np
import torch
import torch.nn as nn

EXP_DIR = os.path.dirname(os.path.abspath(__file__))
ZK_DIR  = os.path.dirname(EXP_DIR)
sys.path.insert(0, ZK_DIR)

from model import MNISTNet, _load_flat_mnist  # noqa: E402

ENV = {
    "machine": "Apple Silicon, 16GB RAM, 8 cores",
    "torch": torch.__version__,
    "python": sys.version.split()[0],
}


def save(name, payload):
    path = os.path.join(EXP_DIR, f"{name}.json")
    payload["generated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    payload["env"] = ENV
    with open(path, "w") as f:
        json.dump(payload, f, indent=1)
    print(f"[exp] wrote {path}")


# ---------------------------------------------------------------------------
# cotrain — private-data co-training with disjoint digit classes
# ---------------------------------------------------------------------------

def _filter_digits(X, y, digits):
    mask = torch.isin(y, torch.tensor(digits))
    return X[mask], y[mask]


def _train_epochs(model, X, y, epochs, lr=1e-3, seed=0):
    torch.manual_seed(seed)
    opt = torch.optim.Adam(model.parameters(), lr=lr)
    loss_fn = nn.CrossEntropyLoss()
    ds = torch.utils.data.TensorDataset(X, y)
    loader = torch.utils.data.DataLoader(ds, batch_size=256, shuffle=True,
                                         generator=torch.Generator().manual_seed(seed))
    model.train()
    for _ in range(epochs):
        for xb, yb in loader:
            opt.zero_grad()
            loss_fn(model(xb), yb).backward()
            opt.step()
    model.eval()
    return model


def _accuracy(model, X, y):
    with torch.no_grad():
        return (model(X).argmax(1) == y).float().mean().item()


def _per_class_accuracy(model, X, y):
    out = {}
    with torch.no_grad():
        pred = model(X).argmax(1)
    for d in range(10):
        mask = y == d
        out[str(d)] = float((pred[mask] == d).float().mean().item()) if mask.any() else None
    return out


def _avg_state(a, b, wa=0.5):
    return {k: wa * a[k].float() + (1 - wa) * b[k].float() for k in a}


def run_cotrain(seeds=(0, 1, 2), rounds=25):
    """
    Miner P sees ONLY digits 0-4; miner Q sees ONLY digits 5-9. Solo models
    collapse on unseen classes (~50% ceiling). Real FedAvg — both parties
    train one local epoch from the SHARED global state each round, then their
    updates are averaged — produces a model that reads all ten digits. Neither
    dataset ever leaves its silo; only weight updates move.

    Parallel (not alternating) averaging is what avoids catastrophic
    forgetting: alternating single-epoch updates seesaw toward whichever half
    was seen last; averaging two simultaneous half-updates keeps both.
    """
    X_train, y_train, X_test, y_test = _load_flat_mnist()
    X_test, y_test = X_test[:2000], y_test[:2000]
    XP, yP = _filter_digits(X_train[:20000], y_train[:20000], [0, 1, 2, 3, 4])
    XQ, yQ = _filter_digits(X_train[:20000], y_train[:20000], [5, 6, 7, 8, 9])
    print(f"[cotrain] P: {len(XP)} samples (digits 0-4)  Q: {len(XQ)} samples (digits 5-9)")

    results = []
    for seed in seeds:
        print(f"[cotrain] seed {seed}")
        # solo controls — generous training, still half-blind
        p_solo = _train_epochs(MNISTNet(), XP, yP, epochs=5, seed=seed)
        q_solo = _train_epochs(MNISTNet(), XQ, yQ, epochs=5, seed=seed + 100)
        p_solo_acc = _accuracy(p_solo, X_test, y_test)
        q_solo_acc = _accuracy(q_solo, X_test, y_test)

        # federated: parallel FedAvg. Each round both parties start from the
        # shared global, train one local epoch on their private half, and the
        # two resulting weight sets are averaged into the new global.
        torch.manual_seed(seed)
        fed = MNISTNet()
        history = []
        for r in range(rounds):
            p_local = MNISTNet(); p_local.load_state_dict(fed.state_dict())
            q_local = MNISTNet(); q_local.load_state_dict(fed.state_dict())
            p_local = _train_epochs(p_local, XP, yP, epochs=1, seed=seed * 1000 + r)
            q_local = _train_epochs(q_local, XQ, yQ, epochs=1, seed=seed * 1000 + r + 7)
            avg = _avg_state(p_local.state_dict(), q_local.state_dict(), 0.5)
            fed.load_state_dict(avg)
            history.append(round(_accuracy(fed, X_test, y_test), 4))
        global_acc = history[-1]

        results.append({
            "seed": seed,
            "p_solo_acc": round(p_solo_acc, 4),
            "q_solo_acc": round(q_solo_acc, 4),
            "federated_acc": round(global_acc, 4),
            "history": history,
            "per_class_p_solo": _per_class_accuracy(p_solo, X_test, y_test),
            "per_class_q_solo": _per_class_accuracy(q_solo, X_test, y_test),
            "per_class_federated": _per_class_accuracy(fed, X_test, y_test),
        })
        print(f"[cotrain] seed {seed}: P-solo {p_solo_acc:.3f}  Q-solo {q_solo_acc:.3f}  "
              f"federated {global_acc:.3f}")

    fed_accs = [r["federated_acc"] for r in results]
    save("cotrain", {
        "experiment": "private-data co-training, disjoint digit classes",
        "version": 1,
        "config": {"rounds": rounds, "seeds": list(seeds),
                   "merge": "parallel FedAvg (both parties train from shared global each round, then average)",
                   "data": "P sees only digits 0-4, Q only 5-9; 2000-img held-out test"},
        "results": results,
        "summary": {
            "p_solo_mean": round(float(np.mean([r["p_solo_acc"] for r in results])), 4),
            "q_solo_mean": round(float(np.mean([r["q_solo_acc"] for r in results])), 4),
            "federated_mean": round(float(np.mean(fed_accs)), 4),
            "federated_std": round(float(np.std(fed_accs)), 4),
            "claim": "the merged model reads all ten digits; neither solo model can",
        },
        "caveat": "label-skew MNIST is the easy non-IID case — a mechanism demo, not a generalization claim",
    })


# ---------------------------------------------------------------------------
# crossover — proof cost vs model size on this machine
# ---------------------------------------------------------------------------

LADDER = [
    {"name": "784-32-10",       "hidden": [32],        },
    {"name": "784-64-32-10",    "hidden": [64, 32],    },
    {"name": "784-128-64-10",   "hidden": [128, 64],   },  # production circuit
    {"name": "784-256-128-10",  "hidden": [256, 128],  },
    {"name": "784-512-256-10",  "hidden": [512, 256],  },
]


def make_mlp(hidden):
    layers, prev = [], 784
    for h in hidden:
        layers += [nn.Linear(prev, h), nn.ReLU()]
        prev = h
    layers.append(nn.Linear(prev, 10))
    return nn.Sequential(*layers)


def run_crossover(repeats=2):
    import resource
    import onnx  # noqa: F401
    import ezkl
    import asyncio
    sys.path.insert(0, ZK_DIR)
    from challenge_net import get_challenge_batch, write_batch_input_json

    work = os.path.join(EXP_DIR, "_crossover_work")
    os.makedirs(work, exist_ok=True)
    P = lambda f: os.path.join(work, f)
    X, _ = get_challenge_batch(0, 8)
    write_batch_input_json(X, P("input.json"))

    results = []
    for spec in LADDER:
        params = sum(p.numel() for p in make_mlp(spec["hidden"]).parameters())
        entry = {"name": spec["name"], "params": params, "runs": [], "dnf": None}
        print(f"[crossover] {spec['name']} ({params:,} params)")
        try:
            for rep in range(repeats):
                torch.manual_seed(rep)
                mlp = make_mlp(spec["hidden"])
                # brief real training so weights are realistic, not random
                X_tr, y_tr, _, _ = _load_flat_mnist()
                t_train0 = time.time()
                _train_epochs(mlp, X_tr[:10000], y_tr[:10000], epochs=1, seed=rep)
                train_s = time.time() - t_train0

                torch.onnx.export(mlp, torch.zeros(8, 784), P("model.onnx"),
                                  input_names=["input"], output_names=["output"],
                                  opset_version=11, do_constant_folding=True, dynamo=False)
                args = ezkl.PyRunArgs()
                args.input_visibility = "hashed"
                args.output_visibility = "public"
                args.param_visibility = "private"
                args.decomp_legs = 4
                ezkl.gen_settings(model=P("model.onnx"), output=P("settings.json"),
                                  py_run_args=args)
                ezkl.calibrate_settings(data=P("input.json"), model=P("model.onnx"),
                                        settings=P("settings.json"), target="resources",
                                        lookup_safety_margin=2,
                                        scale_rebase_multiplier=[10], max_logrows=22)
                with open(P("settings.json")) as f:
                    logrows = json.load(f)["run_args"]["logrows"]
                ezkl.compile_circuit(model=P("model.onnx"),
                                     compiled_circuit=P("net.compiled"),
                                     settings_path=P("settings.json"))

                async def _srs():
                    await ezkl.get_srs(settings_path=P("settings.json"), srs_path=P("kzg.srs"))
                asyncio.run(_srs())

                t0 = time.time()
                ezkl.setup(model=P("net.compiled"), vk_path=P("vk.key"),
                           pk_path=P("pk.key"), srs_path=P("kzg.srs"),
                           disable_selector_compression=False)
                setup_s = time.time() - t0
                ezkl.gen_witness(data=P("input.json"), model=P("net.compiled"),
                                 output=P("witness.json"))
                t0 = time.time()
                ezkl.prove(witness=P("witness.json"), model=P("net.compiled"),
                           pk_path=P("pk.key"), proof_path=P("proof.json"),
                           srs_path=P("kzg.srs"))
                prove_s = time.time() - t0
                ok = ezkl.verify(proof_path=P("proof.json"), settings_path=P("settings.json"),
                                 vk_path=P("vk.key"), srs_path=P("kzg.srs"), reduced_srs=False)
                run = {
                    "logrows": logrows,
                    "train_s": round(train_s, 1),
                    "setup_s": round(setup_s, 1),
                    "prove_s": round(prove_s, 1),
                    "pk_gb": round(os.path.getsize(P("pk.key")) / 1e9, 3),
                    "proof_kb": round(os.path.getsize(P("proof.json")) / 1024, 1),
                    "verified": bool(ok),
                    "peak_rss_gb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e9, 2),
                }
                entry["runs"].append(run)
                print(f"  run {rep}: logrows {logrows}, prove {run['prove_s']}s, pk {run['pk_gb']}GB")
                # free the big pk between runs
                for f in ("pk.key", "kzg.srs"):
                    if os.path.exists(P(f)):
                        os.remove(P(f))
        except Exception as e:
            entry["dnf"] = str(e)[:300]
            print(f"  DNF: {entry['dnf']}")
        results.append(entry)
        # progressive save so a late OOM doesn't lose the ladder
        save("crossover", {
            "experiment": "proof cost vs model size (N=8 challenge circuit)",
            "version": 1,
            "config": {"repeats": repeats, "circuit": "hashed input, public output, private params, legs=4",
                       "note": "verify gas measured separately on the production circuit: 1,851,050 gas (hardhat)"},
            "results": results,
            "external_sources": [
                {"label": "EZKL (Halo2/KZG) — this work", "source_class": "measured"},
                {"label": "zkML field is moving to GPU provers and folding schemes; treat any extrapolation as different proof systems — not our curve",
                 "source_class": "external"},
            ],
        })


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--suite", required=True, choices=["cotrain", "crossover"])
    args = ap.parse_args()
    if args.suite == "cotrain":
        run_cotrain()
    else:
        run_crossover()
