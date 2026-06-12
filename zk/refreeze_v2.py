"""
refreeze_v2.py — re-freeze the Era-2 circuit with param_visibility="hashed".

The reward redesign needs the proof to publicly commit to the model's
parameters (a Poseidon hash, as a public instance) so the contract can:
  - trust a base score (base proof's param-hash must == the committed model)
  - reject copycat models (same param-hash = same model)

This re-runs the frozen-circuit pipeline once with the new visibility, prints
the EXACT instance layout (so the contract knows which index is the param
hash and where logits start), and writes new artifacts to zk/v2/.

Calibration reuses the spike's hardening: settings are calibrated on an
adversarially-grown model so they survive an era of weight drift.

Run (from repo root):  caffeinate -i .venv/bin/python zk/refreeze_v2.py
Then:                  .venv/bin/python zk/challenge_pool.py   (new commitments)
"""

import asyncio
import json
import os
import sys
import time

import torch

ZK_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ZK_DIR)

import ezkl  # noqa: E402
from model import MNISTNet, train_shard  # noqa: E402
from challenge_net import export_challenge_onnx, get_challenge_batch, write_batch_input_json  # noqa: E402

N        = 8
OUT      = os.path.join(ZK_DIR, "v2")
GLOBAL   = os.path.join(ZK_DIR, "global_model.pth")
P        = lambda f: os.path.join(OUT, f)
T0       = time.time()
log      = lambda m: print(f"[refreeze +{time.time()-T0:6.0f}s] {m}", flush=True)

CAL_LADDER = [
    {"decomp_legs": 4, "scales": None},
    {"decomp_legs": 4, "scales": [6, 7, 8, 9, 10]},
    {"decomp_legs": 5, "scales": [6, 7, 8, 9, 10]},
]


def proof_instances(path):
    with open(path) as f:
        p = json.load(f)
    return [x for grp in p["instances"] for x in grp]


def main():
    os.makedirs(OUT, exist_ok=True)

    # adversarial calibration model (range stress) + the real model to prove
    log("training adversarial calibration model (range stress)…")
    base = MNISTNet(); base.load_state_dict(torch.load(GLOBAL))
    adv, _ = train_shard(0, n_epochs=5, seed=1234, initial_state=base.state_dict())
    adv_state = {k: v * 1.5 for k, v in adv.state_dict().items()}
    export_challenge_onnx(adv_state, N, P("cal_model.onnx"))
    export_challenge_onnx(torch.load(GLOBAL), N, P("model.onnx"))

    Xb, _ = get_challenge_batch(0, N)
    write_batch_input_json(Xb, P("cal_input.json"))

    log("calibrating with param_visibility=hashed…")
    cal_err = None
    for attempt in CAL_LADDER:
        args = ezkl.PyRunArgs()
        args.input_visibility  = "hashed"
        args.output_visibility = "public"
        args.param_visibility  = "hashed"     # ← THE CHANGE
        args.decomp_legs       = attempt["decomp_legs"]
        ezkl.gen_settings(model=P("cal_model.onnx"), output=P("settings.json"), py_run_args=args)
        try:
            ezkl.calibrate_settings(
                data=P("cal_input.json"), model=P("cal_model.onnx"),
                settings=P("settings.json"), target="resources",
                lookup_safety_margin=2, scales=attempt["scales"],
                scale_rebase_multiplier=[10], max_logrows=21,
            )
            cal_err = None; break
        except Exception as e:
            cal_err = e; log(f"  calib attempt {attempt} failed: {str(e)[:80]}")
    if cal_err: raise cal_err

    with open(P("settings.json")) as f:
        logrows = json.load(f)["run_args"]["logrows"]
    log(f"calibrated: logrows={logrows}")

    log("compile + srs + setup…")
    ezkl.compile_circuit(model=P("model.onnx"), compiled_circuit=P("network.compiled"),
                         settings_path=P("settings.json"))
    async def _srs(): await ezkl.get_srs(settings_path=P("settings.json"), srs_path=P("kzg.srs"))
    asyncio.run(_srs())
    ezkl.setup(model=P("network.compiled"), vk_path=P("vk.key"), pk_path=P("pk.key"),
               srs_path=P("kzg.srs"), disable_selector_compression=False)
    pk_gb = os.path.getsize(P("pk.key")) / 1e9
    log(f"setup done: pk={pk_gb:.2f}GB")

    log("proving global model on batch 0 (layout probe)…")
    ezkl.gen_witness(data=P("cal_input.json"), model=P("network.compiled"), output=P("witness.json"))
    ezkl.prove(witness=P("witness.json"), model=P("network.compiled"),
               pk_path=P("pk.key"), proof_path=P("probe_proof.json"), srs_path=P("kzg.srs"))
    inst = proof_instances(P("probe_proof.json"))
    n_logits = N * 10
    n_hashes = len(inst) - n_logits
    log(f"INSTANCE LAYOUT: total={len(inst)}  hashes={n_hashes}  logits={n_logits}")

    # confirm which leading instances are hashes vs logits by reading the witness
    with open(P("witness.json")) as f:
        w = json.load(f)
    poseidon = w.get("processed_inputs", {}).get("poseidon_hash")
    param_poseidon = w.get("processed_params", {}).get("poseidon_hash")
    log(f"input poseidon_hash:  {poseidon}")
    log(f"param poseidon_hash:  {param_poseidon}")

    log("create_evm_verifier (reusable) + vka…")
    async def _ver():
        await ezkl.create_evm_verifier(
            vk_path=P("vk.key"), settings_path=P("settings.json"),
            sol_code_path=P("VerifierV3Reusable.sol"), abi_path=P("verifier_abi.json"),
            srs_path=P("kzg.srs"), reusable=True)
        await ezkl.create_evm_vka(
            vk_path=P("vk.key"), settings_path=P("settings.json"),
            vka_path=P("vka.bin"), srs_path=P("kzg.srs"), decimals=0)
    asyncio.run(_ver())

    summary = {
        "n": N, "logrows": logrows, "pk_gb": round(pk_gb, 3),
        "instance_count": len(inst), "n_hashes": n_hashes, "n_logits": n_logits,
        "input_poseidon": poseidon, "param_poseidon": param_poseidon,
        "verifier_sol_kb": round(os.path.getsize(P("VerifierV3Reusable.sol")) / 1024, 1),
        "vka_bytes": os.path.getsize(P("vka.bin")),
    }
    with open(P("refreeze_summary.json"), "w") as f:
        json.dump(summary, f, indent=2)
    log(f"DONE: {json.dumps(summary)}")


if __name__ == "__main__":
    main()
