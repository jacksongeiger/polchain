export const ADDRESSES = {
  POLToken: "0x502fA15f7d246515f53550ff8AD829d5926F9e67",
  TaskManager: "0x9C8A698e43C53A754B3d4A3Ce81C7125Eb4fd13e",
};

export const POL_TOKEN_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

export const TASK_MANAGER_ABI = [
  "function owner() view returns (address)",
  "function polToken() view returns (address)",
  "function totalTasks() view returns (uint256)",
  "function getTask(uint256 taskId) view returns (tuple(uint256 id, string description, uint256 threshold, uint256 reward, uint256 deadline, bool finalized, address winner))",
  "function getSubmissionCount(uint256 taskId) view returns (uint256)",
  "function getSubmission(uint256 taskId, uint256 index) view returns (tuple(address miner, bytes32 gradientHash, uint256 score, uint256 submittedAt))",
  "function getAllSubmissions(uint256 taskId) view returns (tuple(address miner, bytes32 gradientHash, uint256 score, uint256 submittedAt)[])",
  "function postTask(string description, uint256 threshold, uint256 reward, uint256 deadline) returns (uint256)",
  "function submitWork(uint256 taskId, bytes32 gradientHash, uint256 score)",
  "function finalizeTask(uint256 taskId)",
  "event TaskPosted(uint256 indexed taskId, string description, uint256 threshold, uint256 reward, uint256 deadline)",
  "event WorkSubmitted(uint256 indexed taskId, address indexed miner, bytes32 gradientHash, uint256 score)",
  "event TaskFinalized(uint256 indexed taskId, address indexed winner, uint256 reward)",
];
