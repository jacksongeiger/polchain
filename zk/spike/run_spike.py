"""
run_spike.py — Era 2 feasibility spike. Gates G1-G5 from the Era 2 plan.

Decides the challenge batch size N and proves out every load-bearing EZKL
assumption BEFORE any contract or commitment is frozen:

  G1  scale        — full settings→calibrate→compile→setup→prove→verify at
                     batch size N. Kill thresholds: N=16 dies at logrows>21,
                     pk>12GB, or prove>600s; N=8 dies at logrows>20.
  G2  pk reuse     — 3 DISTINCT trained models, each: ONNX export →
                     compile_circuit against FROZEN settings → witness →
                     prove against the SINGLE FROZEN pk. All must verify and
                     produce distinct logits. Records recompile time.
  G3  commitment   — the hashed-input instance region must be a function of
                     the challenge batch ONLY: same batch under different
                     weights → identical hash instances; different batch →
                     different hash instances. This is what lets the contract
                     pin batchCommitment per task.
  G4  verifier     — create_evm_verifier emits Solidity; bytecode size vs
                     EIP-170 is checked at hardhat compile (phase 2a); here we
                     record sol size + instance layout. Peak RSS recorded.
  G5  fleet        — the three G2 cycles double as the rehearsal; window math
                     = provers × P95(recompile+witness+prove) × 1.25.

Run (from repo root, venv python, hours):
    caffeinate -i .venv/bin/python zk/spike/run_spike.py

Progressive output: zk/spike/spike_results.json after every step — safe to
tail/inspect while running. Artifacts in zk/spike/artifacts/ (gitignored).

N=8 runs before N=16 deliberately: on a 16GB machine an N=16 OOM must not
cost us the spike. N=16 is attempted only if N=8's pk suggests headroom.
"""

import json
import os
import resource
import sys
import time
import traceback

import torch

SPIKE_DIR = os.path.dirname(os.path.abspath(__file__))
ZK_DIR    = os.path.dirname(SPIKE_DIR)
sys.path.insert(0, ZK_DIR)

import ezkl  # noqa: E402
from model import MNISTNet, train_shard  # noqa: E402
from challenge_net import (  # noqa: E402
    export_challenge_onnx, get_challenge_batch, write_batch_input_json,
)

RESULTS_PATH = os.path.join(SPIKE_DIR, "spike_results.json")
ART_ROOT     = os.path.join(SPIKE_DIR, "artifacts")
GLOBAL_MODEL = os.path.join(ZK_DIR, "global_model.pth")

KILL = {
    16: {"logrows": 21, "pk_gb": 12.0, "prove_s": 600},
    8:  {"logrows": 20, "pk_gb": 12.0, "prove_s": 600},
}

RESULTS = {"machine": {"ram_gb": 16, "ncpu": 8}, "runs": {}, "chosen_n": None,
           "started_at": time.strftime("%Y-%m-%d %H:%M:%S")}


def save():
    RESULTS["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    with open(RESULTS_PATH, "w") as f:
        json.dump(RESULTS, f, indent=2)


def peak_rss_gb():
    # macOS reports ru_maxrss in BYTES (linux: KB)
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e9


def log(msg):
    print(f"[spike +{time.time() - T0:7.0f}s] {msg}", flush=True)


def hash_instance_count(settings_path):
    """How many leading instances belong to the hashed input region."""
    with open(settings_path) as f:
        s = json.load(f)
    # total instances = hash region + output felts; output is [N,10]
    total = s.get("num_instances") or sum(
        x if isinstance(x, int) else 0 for x in (s.get("instance_shapes") or [])
    )
    return s, total


def proof_instances(proof_path):
    with open(proof_path) as f:
        p = json.load(f)
    inst = p["instances"]
    # instances is [[felt, ...]] — one inner list per instance column group
    flat = [x for grp in inst for x in grp]
    return flat


def variant_models():
    """The real global model + two distinct finetunes — three weight sets."""
    base = MNISTNet()
    base.load_state_dict(torch.load(GLOBAL_MODEL))
    yield "global", base.state_dict()
    # variant_c's 3-epoch finetune drifts hardest — production updates are 1 epoch,
    # so it passing means the frozen settings have era-scale headroom (risk R-3).
    for name, (shard, seed, epochs) in {"variant_a": (1, 7, 1),
                                        "variant_b": (2, 99, 1),
                                        "variant_c": (3, 5, 3)}.items():
        m, acc = train_shard(shard_id=shard, n_epochs=epochs, seed=seed,
                             initial_state=base.state_dict())
        log(f"  {name}: finetuned shard {shard} ({epochs} ep), acc {acc:.3f}")
        yield name, m.state_dict()


def run_n(n):
    art = os.path.join(ART_ROOT, f"N{n}")
    os.makedirs(art, exist_ok=True)
    P = lambda f: os.path.join(art, f)
    run = {"n": n, "gates": {}, "killed": None}
    RESULTS["runs"][f"N{n}"] = run
    kill = KILL[n]

    # ---- G1: full pipeline at scale, real weights + real batch -------------
    # Calibration uses ADVERSARIALLY-GROWN weights (risk R-3): a hot high-LR
    # finetune of the global model produces larger weights than any production
    # one-epoch update will, so the frozen settings' decomposition range and
    # scales survive an era of weight evolution. A 1-epoch finetune at lr=1e-3
    # already overflowed settings calibrated on the un-finetuned global model.
    log(f"=== N={n} G1: export + settings + calibrate (adversarial weights) ===")
    state = torch.load(GLOBAL_MODEL)
    base = MNISTNet(); base.load_state_dict(state)
    adv, adv_acc = train_shard(shard_id=0, n_epochs=5, seed=1234,
                               initial_state=base.state_dict())
    # crank weights further: scale up 1.5x — pure range stress, never deployed
    adv_state = {k: v * 1.5 for k, v in adv.state_dict().items()}
    run["adversarial_cal"] = {"finetune_epochs": 5, "scale_factor": 1.5,
                              "finetune_acc": round(adv_acc, 4)}
    export_challenge_onnx(adv_state, n, P("cal_model.onnx"))
    export_challenge_onnx(state, n, P("model.onnx"))

    Xb, yb = get_challenge_batch(0, n)
    write_batch_input_json(Xb, P("cal_input.json"))

    # Era 1 calibrated on an all-zero canvas with decomp_legs=3 — real images
    # and real trained weights overflow that representable range (16384^3).
    # Ladder: widen decomposition first, drop scales (precision) only if forced.
    CAL_LADDER = [
        {"decomp_legs": 4, "scales": None},
        {"decomp_legs": 4, "scales": [6, 7, 8, 9, 10]},
        {"decomp_legs": 5, "scales": [6, 7, 8, 9, 10]},
    ]
    t = time.time()
    cal_err = None
    for attempt in CAL_LADDER:
        args = ezkl.PyRunArgs()
        args.input_visibility  = "hashed"
        args.output_visibility = "public"
        args.param_visibility  = "private"
        args.decomp_legs       = attempt["decomp_legs"]
        ezkl.gen_settings(model=P("cal_model.onnx"), output=P("settings.json"),
                          py_run_args=args)
        try:
            ezkl.calibrate_settings(
                data=P("cal_input.json"), model=P("cal_model.onnx"),
                settings=P("settings.json"), target="resources",
                lookup_safety_margin=2, scales=attempt["scales"],
                scale_rebase_multiplier=[10],
                max_logrows=kill["logrows"],
            )
            run["calibration"] = attempt
            cal_err = None
            break
        except Exception as e:
            cal_err = e
            log(f"calibration attempt {attempt} failed: {e}")
    if cal_err is not None:
        raise cal_err
    run["calibrate_s"] = round(time.time() - t, 1)

    with open(P("settings.json")) as f:
        settings = json.load(f)
    logrows = settings["run_args"]["logrows"]
    run["logrows"] = logrows
    run["scales"]  = {"input": settings["run_args"].get("input_scale"),
                      "param": settings["run_args"].get("param_scale")}
    save()
    log(f"calibrated: logrows={logrows} ({run['calibrate_s']}s)")
    if logrows > kill["logrows"]:
        run["killed"] = f"logrows {logrows} > {kill['logrows']}"
        save(); return run

    log("G1: compile + srs + setup (the RAM moment)")
    ezkl.compile_circuit(model=P("model.onnx"),
                         compiled_circuit=P("network.compiled"),
                         settings_path=P("settings.json"))
    import asyncio

    async def _fetch_srs():
        # get_srs must be called from inside a running loop (pyo3-asyncio)
        await ezkl.get_srs(settings_path=P("settings.json"), srs_path=P("kzg.srs"))
    asyncio.run(_fetch_srs())

    t = time.time()
    ezkl.setup(model=P("network.compiled"), vk_path=P("vk.key"),
               pk_path=P("pk.key"), srs_path=P("kzg.srs"),
               disable_selector_compression=False)
    run["setup_s"] = round(time.time() - t, 1)
    run["pk_gb"]   = round(os.path.getsize(P("pk.key")) / 1e9, 3)
    run["peak_rss_gb_after_setup"] = round(peak_rss_gb(), 2)
    save()
    log(f"setup done: pk={run['pk_gb']}GB rss={run['peak_rss_gb_after_setup']}GB ({run['setup_s']}s)")
    if run["pk_gb"] > kill["pk_gb"]:
        run["killed"] = f"pk {run['pk_gb']}GB > {kill['pk_gb']}GB"
        save(); return run

    t = time.time()
    ezkl.gen_witness(data=P("cal_input.json"), model=P("network.compiled"),
                     output=P("witness.json"))
    run["witness_s"] = round(time.time() - t, 1)

    t = time.time()
    ezkl.prove(witness=P("witness.json"), model=P("network.compiled"),
               pk_path=P("pk.key"), proof_path=P("proof.json"),
               srs_path=P("kzg.srs"))
    run["prove_s"] = round(time.time() - t, 1)
    run["proof_kb"] = round(os.path.getsize(P("proof.json")) / 1024, 1)
    save()
    log(f"prove: {run['prove_s']}s, {run['proof_kb']}KB")
    if run["prove_s"] > kill["prove_s"]:
        run["killed"] = f"prove {run['prove_s']}s > {kill['prove_s']}s"
        save(); return run

    ok = ezkl.verify(proof_path=P("proof.json"), settings_path=P("settings.json"),
                     vk_path=P("vk.key"), srs_path=P("kzg.srs"), reduced_srs=False)
    run["gates"]["G1"] = bool(ok)
    base_instances = proof_instances(P("proof.json"))
    run["instance_count"] = len(base_instances)
    run["expected_output_felts"] = n * 10
    run["hash_region_felts"] = len(base_instances) - n * 10
    save()
    log(f"G1 verify={ok}; instances={len(base_instances)} "
        f"(hash region {run['hash_region_felts']} + logits {n * 10})")
    if not ok:
        run["killed"] = "G1 verify failed"; save(); return run

    # ---- G2 + G3 + G5: frozen pk across distinct weights --------------------
    log(f"=== N={n} G2/G3/G5: 3 distinct models vs frozen pk ===")
    cycle_times, logits_sets, hash_regions = [], [], []
    g2_ok = True
    for name, sd in variant_models():
        t0 = time.time()
        export_challenge_onnx(sd, n, P(f"{name}.onnx"))
        ezkl.compile_circuit(model=P(f"{name}.onnx"),
                             compiled_circuit=P(f"{name}.compiled"),
                             settings_path=P("settings.json"))      # FROZEN settings
        recompile_s = time.time() - t0
        t1 = time.time()
        ezkl.gen_witness(data=P("cal_input.json"), model=P(f"{name}.compiled"),
                         output=P(f"{name}_witness.json"))
        ezkl.prove(witness=P(f"{name}_witness.json"), model=P(f"{name}.compiled"),
                   pk_path=P("pk.key"), proof_path=P(f"{name}_proof.json"),  # FROZEN pk
                   srs_path=P("kzg.srs"))
        ok = ezkl.verify(proof_path=P(f"{name}_proof.json"),
                         settings_path=P("settings.json"),
                         vk_path=P("vk.key"), srs_path=P("kzg.srs"),
                         reduced_srs=False)
        cycle = {"name": name, "recompile_s": round(recompile_s, 1),
                 "witness_prove_s": round(time.time() - t1, 1), "verified": bool(ok)}
        cycle_times.append(cycle)
        g2_ok &= bool(ok)
        inst = proof_instances(P(f"{name}_proof.json"))
        hash_regions.append(tuple(inst[: run["hash_region_felts"]]))
        logits_sets.append(tuple(inst[run["hash_region_felts"]:]))
        run["g2_cycles"] = cycle_times
        save()
        log(f"  {name}: recompile {cycle['recompile_s']}s, "
            f"witness+prove {cycle['witness_prove_s']}s, verified={ok}")

    distinct_logits = len(set(logits_sets)) == len(logits_sets)
    run["gates"]["G2"] = g2_ok and distinct_logits
    run["g2_distinct_logits"] = distinct_logits

    # G3a: same batch, different weights → identical hash region
    g3_same = len(set(hash_regions)) == 1
    # G3b: different batch, same weights → different hash region
    Xb1, _ = get_challenge_batch(1, n)
    write_batch_input_json(Xb1, P("batch1_input.json"))
    ezkl.gen_witness(data=P("batch1_input.json"), model=P("network.compiled"),
                     output=P("batch1_witness.json"))
    ezkl.prove(witness=P("batch1_witness.json"), model=P("network.compiled"),
               pk_path=P("pk.key"), proof_path=P("batch1_proof.json"),
               srs_path=P("kzg.srs"))
    inst_b1 = proof_instances(P("batch1_proof.json"))
    g3_diff = tuple(inst_b1[: run["hash_region_felts"]]) != hash_regions[0]
    run["gates"]["G3"] = g3_same and g3_diff
    run["g3"] = {"same_batch_same_hash": g3_same, "diff_batch_diff_hash": g3_diff}
    save()
    log(f"G2={run['gates']['G2']} G3={run['gates']['G3']} "
        f"(same-batch-stable={g3_same}, diff-batch-distinct={g3_diff})")

    # G5: window math from worst observed cycle
    full = [c["recompile_s"] + c["witness_prove_s"] for c in cycle_times]
    p95 = max(full)
    run["g5"] = {"cycle_s": full, "p95_s": round(p95, 1),
                 "window_1_prover_s": round(p95 * 1.25, 0),
                 "window_2_provers_s": round(2 * p95 * 1.25, 0)}
    run["gates"]["G5"] = True
    save()
    log(f"G5 window math: 1 prover={run['g5']['window_1_prover_s']}s, "
        f"2 provers={run['g5']['window_2_provers_s']}s")

    # ---- G4 (partial): emit the EVM verifier --------------------------------
    log(f"=== N={n} G4: create_evm_verifier ===")
    try:
        ezkl.create_evm_verifier(
            vk_path=P("vk.key"), settings_path=P("settings.json"),
            sol_code_path=P("VerifierV2.sol"), abi_path=P("verifier_abi.json"),
            srs_path=P("kzg.srs"), reusable=False,
        )
        run["verifier_sol_kb"] = round(os.path.getsize(P("VerifierV2.sol")) / 1024, 1)
        run["gates"]["G4_sol_emitted"] = True
        log(f"verifier sol emitted: {run['verifier_sol_kb']}KB "
            "(EIP-170 bytecode check happens at hardhat compile)")
    except Exception as e:
        run["gates"]["G4_sol_emitted"] = False
        run["g4_error"] = str(e)
    run["peak_rss_gb_final"] = round(peak_rss_gb(), 2)
    save()
    return run


def main():
    os.makedirs(ART_ROOT, exist_ok=True)
    save()

    # N=8 first — machine safety on 16GB RAM.
    for n in (8, 16):
        if n == 16:
            n8 = RESULTS["runs"].get("N8", {})
            pk8 = n8.get("pk_gb")
            if not n8.get("gates", {}).get("G1"):
                log("N=8 did not pass G1 — skipping N=16 attempt entirely")
                continue
            if pk8 and pk8 * 4 > KILL[16]["pk_gb"]:
                log(f"N=8 pk {pk8}GB ⇒ projected N=16 pk ~{pk8 * 4:.1f}GB > "
                    f"{KILL[16]['pk_gb']}GB — skipping N=16 (RAM safety)")
                RESULTS["runs"]["N16"] = {"n": 16, "killed": "projected pk too large",
                                          "gates": {}}
                save()
                continue
        try:
            run_n(n)
        except Exception as e:
            RESULTS["runs"][f"N{n}"] = {
                **RESULTS["runs"].get(f"N{n}", {"n": n, "gates": {}}),
                "killed": f"exception: {e}",
                "traceback": traceback.format_exc()[-3000:],
            }
            save()
            log(f"N={n} died: {e}")

    # Choose N: largest one whose G1+G2+G3 all passed
    for label in ("N16", "N8"):
        r = RESULTS["runs"].get(label, {})
        g = r.get("gates", {})
        if g.get("G1") and g.get("G2") and g.get("G3") and not r.get("killed"):
            RESULTS["chosen_n"] = r["n"]
            break
    save()
    log(f"SPIKE COMPLETE — chosen_n={RESULTS['chosen_n']}")


if __name__ == "__main__":
    T0 = time.time()
    main()
else:
    T0 = time.time()
