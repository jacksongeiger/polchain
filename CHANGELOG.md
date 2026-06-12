# Changelog

## 2026-06-11

- **fix(env):** Restored the ZK prove server — Homebrew's Python upgrade had wiped the system site-packages holding ezkl/torch, leaving the Model view, live inference, and accuracy history dead. Deps now pinned in `zk/requirements.txt`, installed into `.venv` (Python 3.12); `npm run prove-server`, the admin server, and `miningLoop.js` all spawn the venv interpreter with a system-python fallback.
- **refine(ui):** Committed the April working-tree changes — Chain view miner identity softened ("Miner Alpha" naming, calmer palette); Model view gained `useChartZoom` (wheel-zoom + drag-pan accuracy chart, inline + fullscreen, reset control).
- **fix(ui):** Duplicate React keys in the Model "Recent blocks" table (task_id restarts after model resets) — key now includes row index; eliminated ~6,300 repeated console errors.
- **chore:** Untracked runtime artifacts (`zk/global_model.pth`, `zk/accuracy_log.json`, `server/miner-stats.json`) that were gitignored in April but never removed from the index; ignored `.venv`, `graphify-out/`, `zk/__pycache__/`.
- Added README.md and this changelog.
- Verified end-to-end in browser: Chain view (595 blocks, live mining card), Model view (96.3% accuracy chart with zoom, live inference predicted a drawn "1" at 98.1%), production build clean.

## 2026-04-01 → 2026-04-09 (commits db51cd3 … 3288c8c)

- PoLChain v1: basic/advanced mode, ZK attack simulator, proof inspector, federated learning views; crypto-native dashboard revamp + targeted reverts; single-source contract addressing with three-tier fallback; multi-RPC FallbackProvider.

## 2026-03 → 2026-04 (earlier)

- MNIST federated learning, FedAvg quality gating + adaptive digit routing, ZK verifier via EZKL Halo2, auto-finalization, miner simulator, always-on mining loop, Admin panel.
