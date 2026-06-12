// NOTE: addresses live in server/addresses.json and are loaded by config.js.
// This module is intentionally JSON-import-free so Node ESM can load it
// without `with { type: "json" }` import attributes when backend scripts
// dynamic-import it for ABIs.

export const POL_TOKEN_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

// ---------------------------------------------------------------------------
// Era 2 — TaskManagerV2. Scores are computed by the contract from proofs:
// submitWithProof has NO score parameter. Ownerless after seal(); postTask
// and finalizeTask are permissionless.
// ---------------------------------------------------------------------------
const SUBMISSION_TUPLE_V2 = "tuple(address miner, bytes32 gradientHash, uint256 score, uint256 submittedAt, bool zkVerified, bytes32 proofHash)";
const TASK_TUPLE_V2 = "tuple(uint256 id, string description, uint256 threshold, uint256 reward, uint256 deadline, address poster, bytes32 modelHash, uint256 batchIdx, bool finalized, address winner)";

export const TASK_MANAGER_ABI_V2 = [
  "function polToken() view returns (address)",
  "function verifier() view returns (address)",
  "function vkaDigest() view returns (bytes32)",
  "function isSealed() view returns (bool)",
  "function numBatches() view returns (uint256)",
  "function N() view returns (uint256)",
  "function totalTasks() view returns (uint256)",
  `function getTask(uint256 taskId) view returns (${TASK_TUPLE_V2})`,
  "function getTaskChallenge(uint256 taskId) view returns (uint256 batchIdx, uint256 commitment, uint256 labels)",
  "function getSubmissionCount(uint256 taskId) view returns (uint256)",
  `function getSubmission(uint256 taskId, uint256 index) view returns (${SUBMISSION_TUPLE_V2})`,
  `function getAllSubmissions(uint256 taskId) view returns (${SUBMISSION_TUPLE_V2}[])`,
  "function provenCount(uint256 taskId) view returns (uint256)",
  "function unverifiedCount(uint256 taskId) view returns (uint256)",
  "function proofUsed(bytes32 proofHash) view returns (bool)",
  "function postTask(string description, uint256 threshold, uint256 reward, uint256 deadline, bytes32 modelHash) returns (uint256)",
  "function submitWork(uint256 taskId, bytes32 gradientHash, uint256 score)",
  "function submitWithProof(uint256 taskId, bytes32 gradientHash, bytes proof, uint256[] instances, bytes32[] vka)",
  "function finalizeTask(uint256 taskId)",
  "event TaskPosted(uint256 indexed taskId, address indexed poster, string description, uint256 threshold, uint256 reward, uint256 deadline, bytes32 modelHash, uint256 batchIdx)",
  "event WorkSubmitted(uint256 indexed taskId, address indexed miner, bytes32 gradientHash, uint256 score)",
  "event ProvenWorkSubmitted(uint256 indexed taskId, address indexed miner, bytes32 gradientHash, uint256 score, bytes32 proofHash)",
  "event TaskFinalized(uint256 indexed taskId, address indexed winner, uint256 reward, bool zkVerified)",
  // custom errors — the gauntlet decoder names which layer fired
  "error BadInstanceLength()",
  "error ChallengeMismatch()",
  "error ProofAlreadyUsed()",
  "error BadVka()",
  "error InvalidProof()",
  "error ScoreBelowThreshold()",
  "error AlreadySubmitted()",
  "error SubmissionCapReached()",
  "error TaskClosed()",
  "error TaskNotExpired()",
  "error AlreadyFinalized()",
  "error TaskNotFound()",
  "error BadParams()",
];

// Era 1 (sealed archive) — kept for the archived-chain inspector.
const SUBMISSION_TUPLE = "tuple(address miner, bytes32 gradientHash, uint256 score, uint256 submittedAt, bool zkVerified)";

export const TASK_MANAGER_ABI_V1 = [
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

// Legacy alias — Era-1 code paths that still import TASK_MANAGER_ABI keep
// working against the archive until they are migrated or deleted.
export const TASK_MANAGER_ABI = TASK_MANAGER_ABI_V1;
