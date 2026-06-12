# PoLChain — Proof of Learning Protocol

A blockchain where blocks are mined by **training a neural network**. Miners train shards of an MNIST classifier, submit gradient hashes + scores (optionally backed by ZK proofs), and the highest-scoring submission per round wins POL tokens. The global model improves block by block via federated averaging. Deployed on **Base Sepolia** (chainId 84532).

## Status

Research prototype, fully working end-to-end on testnet. Global model at ~96.3% MNIST accuracy after ~1,090 blocks. Active branch: `ui-revamp`.

## Architecture

```
frontend (Vite + React, :5173)
   │  three-tier address fallback: live API → localStorage → build-time bundle
   ├── admin server (Express, :3001) — process mgmt, mode switch, SSE logs,
   │     proxies /api/accuracy + serves server/addresses.json (source of truth)
   ├── prove server (Flask + EZKL/Halo2 + PyTorch, :5001) — /train /prove
   │     /predict /accuracy; runs from .venv (see zk/requirements.txt)
   └── Base Sepolia contracts
         POLToken            ERC-20, 1M fixed supply
         TaskManagerBasic    hash-only submissions
         TaskManagerAdvanced ZK-verified submissions
         Verifier            EZKL Halo2 on-chain verifier
```

- **Basic/Advanced mode** — toggling mode in the UI **redeploys** the corresponding TaskManager via the admin server (fresh on-chain history).
- **Miners** — 4 simulated miners (Alpha/Beta/Gamma/Delta), each training a data-augmentation shard; FedAvg with quality gating aggregates winners into the global model.
- Contract addresses live in `server/addresses.json`; the frontend bundles a snapshot at build time so the UI never blocks on the network.

## Setup

```bash
npm install
cd frontend && npm install && cd ..
/opt/homebrew/bin/python3.12 -m venv .venv
.venv/bin/pip install -r zk/requirements.txt
cp .env.example .env   # PRIVATE_KEY, BASE_SEPOLIA_RPC_URL, BASESCAN_API_KEY
```

## Run

```bash
npm run frontend       # UI on :5173 (works read-only with no servers)
npm run server         # admin server on :3001
npm run prove-server   # ZK/inference server on :5001 (needs .venv)
npm run mining         # full loop: task poster + auto-miner + admin server
```

Contracts: `npm run compile`, `npm test`, `npm run deploy:baseSepolia`.

## Key decisions

- **Hardhat 2 (CJS), not Hardhat 3** — toolbox compatibility.
- **Python 3.12 venv** for the ZK stack — torch/ezkl wheels lag newer Pythons; system-Python installs were wiped by a Homebrew upgrade once (hence pinned `zk/requirements.txt`).
- **Tie goes to first submitter**; no submissions refunds the task owner.
- Runtime artifacts (`zk/global_model.pth`, `zk/accuracy_log.json`, `server/miner-stats.json`) are untracked — they churn on every mining run.
