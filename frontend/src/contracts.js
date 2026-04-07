// Build-time fallback. The runtime path in config.js fetches fresh values from
// the admin server's GET /api/addresses on every page load — these are only
// used if the admin server is unreachable AND localStorage has no cache.
import buildTimeAddresses from "../../server/addresses.json";

export const ADDRESSES = buildTimeAddresses;

/** Returns the TaskManager address for the given mode string. */
export function getActiveTaskManager(mode) {
  return mode === "basic" ? ADDRESSES.TaskManagerBasic : ADDRESSES.TaskManagerAdvanced;
}

export const POL_TOKEN_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

// Submission tuple now includes zkVerified bool
const SUBMISSION_TUPLE = "tuple(address miner, bytes32 gradientHash, uint256 score, uint256 submittedAt, bool zkVerified)";

export const TASK_MANAGER_ABI = [
  "function owner() view returns (address)",
  "function polToken() view returns (address)",
  "function verifier() view returns (address)",
  "function totalTasks() view returns (uint256)",
  "function getTask(uint256 taskId) view returns (tuple(uint256 id, string description, uint256 threshold, uint256 reward, uint256 deadline, bool finalized, address winner))",
  "function getSubmissionCount(uint256 taskId) view returns (uint256)",
  `function getSubmission(uint256 taskId, uint256 index) view returns (${SUBMISSION_TUPLE})`,
  `function getAllSubmissions(uint256 taskId) view returns (${SUBMISSION_TUPLE}[])`,
  "function postTask(string description, uint256 threshold, uint256 reward, uint256 deadline) returns (uint256)",
  "function setVerifier(address verifier)",
  "function submitWork(uint256 taskId, bytes32 gradientHash, uint256 score)",
  "function submitWithProof(uint256 taskId, bytes32 gradientHash, uint256 score, bytes proof, uint256[] instances)",
  "function finalizeTask(uint256 taskId)",
  "event TaskPosted(uint256 indexed taskId, string description, uint256 threshold, uint256 reward, uint256 deadline)",
  "event WorkSubmitted(uint256 indexed taskId, address indexed miner, bytes32 gradientHash, uint256 score)",
  "event ZKWorkSubmitted(uint256 indexed taskId, address indexed miner, bytes32 gradientHash, uint256 score)",
  "event TaskFinalized(uint256 indexed taskId, address indexed winner, uint256 reward)",
  "event VerifierSet(address indexed verifier)",
];
