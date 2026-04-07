import { createCoinbaseWalletSDK } from "@coinbase/wallet-sdk";
import { ethers } from "ethers";

const BASE_SEPOLIA_CHAIN_ID = 84532;

// Multi-endpoint Base Sepolia RPC list. publicnode is preferred because it
// has the most consistent CORS + bot-detection behavior across browsers and
// extensions; sepolia.base.org is kept as a fallback. Override the entire
// list via VITE_BASE_SEPOLIA_RPC (comma-separated) for self-hosted Alchemy
// or Infura endpoints.
const DEFAULT_RPCS = [
  "https://base-sepolia-rpc.publicnode.com",
  "https://sepolia.base.org",
];
const RPC_URLS = (import.meta.env.VITE_BASE_SEPOLIA_RPC ?? DEFAULT_RPCS.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const BASE_SEPOLIA_RPC = RPC_URLS[0];

// Singleton Coinbase provider (only created if MetaMask is absent)
let cbProvider = null;

// Singleton read provider — created lazily on first use
let _readProvider = null;

function getCoinbaseProvider() {
  if (!cbProvider) {
    const sdk = createCoinbaseWalletSDK({
      appName: "PoLChain",
      appChainIds: [BASE_SEPOLIA_CHAIN_ID],
    });
    cbProvider = sdk.getProvider();
  }
  return cbProvider;
}

// Returns the raw EIP-1193 provider to use, and which wallet type it is
function resolveProvider() {
  if (typeof window !== "undefined" && window.ethereum) {
    return { eip1193: window.ethereum, type: "metamask" };
  }
  return { eip1193: getCoinbaseProvider(), type: "coinbase" };
}

// Read-only provider — no wallet needed for browsing tasks. Uses
// FallbackProvider with quorum=1 so any one of the configured RPC endpoints
// can satisfy a request, surviving CORS issues, rate limits, and extension
// blocking on individual RPCs.
export function getReadProvider() {
  if (_readProvider) return _readProvider;

  if (RPC_URLS.length === 1) {
    _readProvider = new ethers.JsonRpcProvider(RPC_URLS[0], BASE_SEPOLIA_CHAIN_ID, {
      staticNetwork: true,
    });
  } else {
    const providers = RPC_URLS.map((url, i) => ({
      provider: new ethers.JsonRpcProvider(url, BASE_SEPOLIA_CHAIN_ID, { staticNetwork: true }),
      priority: i + 1,           // 1 = preferred
      stallTimeout: 2000,        // ms before falling through to next provider
      weight: 1,
    }));
    _readProvider = new ethers.FallbackProvider(providers, BASE_SEPOLIA_CHAIN_ID, {
      quorum: 1,                 // accept the first non-error response
    });
  }
  return _readProvider;
}

/** Reset the singleton read provider — used after a CALL_EXCEPTION storm to
 *  rebuild fresh provider instances and clear any internal stalled state. */
export function resetReadProvider() {
  _readProvider = null;
}

/** Diagnostic helper — returns the configured RPC URLs for logging. */
export function getRpcUrls() {
  return [...RPC_URLS];
}

// Connect wallet and return signer + ethers provider + which wallet was used
export async function connectWallet() {
  const { eip1193, type } = resolveProvider();

  await eip1193.request({ method: "eth_requestAccounts" });

  // For MetaMask, prompt a network switch to Base Sepolia if needed
  if (type === "metamask") {
    try {
      await eip1193.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x14A34" }], // 84532
      });
    } catch (err) {
      // 4902 = chain not added yet
      if (err.code === 4902) {
        await eip1193.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: "0x14A34",
            chainName: "Base Sepolia",
            rpcUrls: [BASE_SEPOLIA_RPC],
            nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
            blockExplorerUrls: ["https://sepolia.basescan.org"],
          }],
        });
      } else {
        throw err;
      }
    }
  }

  const ethersProvider = new ethers.BrowserProvider(eip1193, BASE_SEPOLIA_CHAIN_ID);
  const signer = await ethersProvider.getSigner();
  const address = await signer.getAddress();
  return { ethersProvider, signer, address, walletType: type };
}

export function shortAddress(addr) {
  if (!addr) return "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function formatPOL(wei) {
  return Number(ethers.formatEther(wei)).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });
}

export function formatDeadline(unixTs) {
  return new Date(Number(unixTs) * 1000).toLocaleString();
}

export function timeLeft(unixTs) {
  const diff = Number(unixTs) * 1000 - Date.now();
  if (diff <= 0) return "Expired";
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h > 48) return `${Math.floor(h / 24)}d left`;
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}
