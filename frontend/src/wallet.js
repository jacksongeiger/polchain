import { createCoinbaseWalletSDK } from "@coinbase/wallet-sdk";
import { ethers } from "ethers";

const BASE_SEPOLIA_CHAIN_ID = 84532;
const BASE_SEPOLIA_RPC = "https://sepolia.base.org";

// Singleton Coinbase provider (only created if MetaMask is absent)
let cbProvider = null;

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

// Read-only provider — no wallet needed for browsing tasks
export function getReadProvider() {
  return new ethers.JsonRpcProvider(BASE_SEPOLIA_RPC, BASE_SEPOLIA_CHAIN_ID);
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
