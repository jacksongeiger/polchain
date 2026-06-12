/**
 * scripts/lib/wallets.js — wallet derivation and fee policy for PoLChain.
 *
 * Era 1 ran all four miners out of the deployer key with hand-assigned nonces,
 * so no submission was attributable on-chain. Era 2 gives every miner its own
 * wallet, derived from MINER_MNEMONIC at the standard path m/44'/60'/0'/0/{i+1}
 * (index 0 is reserved for the deployer/operator identity).
 *
 * Fee policy: Base Sepolia is EIP-1559; the old pinned 0.1-gwei legacy gasPrice
 * stalls whenever the base fee drifts above it. getFeeOpts() reads live fee
 * data with a small floor so transactions always price in.
 */
const { ethers } = require("ethers");

const MINER_NAMES = ["Miner Alpha", "Miner Beta", "Miner Gamma", "Miner Delta"];

function minerPath(id) {
  return `m/44'/60'/0'/0/${id + 1}`;
}

/** HD wallet for miner `id` (0-3), connected to `provider` if given. */
function getMinerWallet(id, provider = null) {
  const phrase = process.env.MINER_MNEMONIC;
  if (!phrase) {
    throw new Error("MINER_MNEMONIC missing from .env — run scripts/fundMiners.js for setup help");
  }
  const wallet = ethers.HDNodeWallet.fromMnemonic(
    ethers.Mnemonic.fromPhrase(phrase.trim()),
    minerPath(id)
  );
  return provider ? wallet.connect(provider) : wallet;
}

/** All four miner wallets, connected. */
function getMinerWallets(provider = null) {
  return MINER_NAMES.map((_, id) => getMinerWallet(id, provider));
}

/** The deployer/operator wallet (posts tasks, finalizes, funds miners). */
function getDeployerWallet(provider = null) {
  if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY missing from .env");
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY);
  return provider ? wallet.connect(provider) : wallet;
}

/**
 * Live EIP-1559 fee options with a floor, replacing pinned legacy gasPrice.
 */
async function getFeeOpts(provider, gasLimit = 600_000n) {
  const floor = ethers.parseUnits("0.05", "gwei");
  let maxPriorityFeePerGas = floor;
  let maxFeePerGas = ethers.parseUnits("0.5", "gwei");
  try {
    const fd = await provider.getFeeData();
    if (fd.maxPriorityFeePerGas && fd.maxPriorityFeePerGas > maxPriorityFeePerGas) {
      maxPriorityFeePerGas = fd.maxPriorityFeePerGas;
    }
    if (fd.maxFeePerGas) {
      // 2x headroom over the network estimate so a base-fee bump can't strand the tx
      const padded = fd.maxFeePerGas * 2n;
      if (padded > maxFeePerGas) maxFeePerGas = padded;
    }
  } catch { /* fall back to floors */ }
  if (maxFeePerGas < maxPriorityFeePerGas) maxFeePerGas = maxPriorityFeePerGas * 2n;
  return { maxFeePerGas, maxPriorityFeePerGas, gasLimit };
}

module.exports = { MINER_NAMES, minerPath, getMinerWallet, getMinerWallets, getDeployerWallet, getFeeOpts };
