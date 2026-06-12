// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev EZKL Halo2VerifierReusable: verifier logic is circuit-generic; the
///      circuit's verifying key travels as a bytes32[] "VKA" checked by digest.
interface IVerifierReusable {
    function verifyProof(
        bytes calldata proof,
        uint256[] calldata instances,
        bytes32[] memory vka
    ) external returns (bool success, bytes32 vka_digest, int256[] memory rescaled_instances);
}

/// @title TaskManagerV3 — Proof of Improvement.
///
/// V2 proved the score is real but paid winner-take-all. Because the global
/// model is public and miners warm-start from it, a lazy miner could submit a
/// near-copy of the already-good model, score high, and win for ~zero work.
/// V3 pays each miner in proportion to their MARGINAL IMPROVEMENT over the
/// current model on the block's challenge:
///
///     marginal_i = max(0, score_i - baseScore)
///     reward_i   = reward * marginal_i / Σ marginal_j
///
/// A non-improving copy earns nothing; there is no single winner; every genuine
/// improver is paid. Scores are still computed on-chain from the proof's public
/// logits.
///
/// BASE SCORE — the one disclosed trust assumption. We wanted to verify, in
/// circuit, that the base proof used the committed global model (param-
/// commitment). Measured reality (see docs/REWARD_REDESIGN.md): hashing the
/// 109k parameters in-circuit pushes the proof from logrows 18 → 23 (tens of GB
/// proving key, infeasible on consumer hardware). So instead the task's poster
/// establishes the base score from a REAL on-chain-verified proof on the same
/// challenge batch. What stays trustless: the base score is a genuine proven
/// score, the per-miner scores, the split math, and the payout. What is trusted:
/// that the poster's base proof used the current global model (it commits the
/// model's off-chain hash in `modelHash` for audit). This is consistent with the
/// operator already running the task cadence; a fully-trustless base awaits a
/// cheaper param-commitment scheme.
///
/// What V3 guarantees: you cannot be PAID without genuinely improving the model.
/// What it does NOT do: verify the improvement came from honest *training*.
contract TaskManagerV3 {
    // ------------------------------------------------------------------
    // Circuit constants (the frozen logrows-18 Era-2 circuit; V2 layout)
    // ------------------------------------------------------------------
    uint256 public constant N = 8;
    /// @notice instance layout: [0]=challenge(input) hash, [1 .. N*10]=logits.
    uint256 public constant CHALLENGE_IDX = 0;
    uint256 public constant LOGITS_OFFSET = 1;
    uint256 public constant EXPECTED_INSTANCES = 1 + N * 10;
    uint256 internal constant FIELD_PRIME =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    uint256 public constant MAX_UNVERIFIED = 16;
    uint256 public constant MAX_PROVEN     = 64;

    IERC20 public immutable polToken;
    IVerifierReusable public immutable verifier;
    bytes32 public immutable vkaDigest;
    bytes32 public immutable batchDataDigest;
    uint256 public immutable numBatches;

    uint256[] public batchCommitments;
    uint256[] public packedLabels;
    bool public isSealed;
    address public setupOperator;

    struct Task {
        uint256 id;
        string  description;
        uint256 threshold;
        uint256 reward;
        uint256 deadline;
        address poster;
        bytes32 modelHash;     // off-chain hash of the base global model (audit anchor)
        uint256 batchIdx;
        uint256 baseScore;     // base model's score on this batch (set via establishBase)
        bool    baseSet;
        bool    finalized;
    }

    struct Submission {
        address miner;
        bytes32 gradientHash;
        uint256 score;
        uint256 submittedAt;
        bool    zkVerified;
        bytes32 proofHash;
    }

    uint256 private _taskCounter;
    mapping(uint256 => Task) public tasks;
    mapping(uint256 => Submission[]) private _submissions;
    mapping(uint256 => uint256) public provenCount;
    mapping(uint256 => uint256) public unverifiedCount;
    mapping(uint256 => mapping(address => bool)) public hasSubmitted;
    mapping(bytes32 => bool) public proofUsed;

    event BatchesLoaded(uint256 fromIdx, uint256 count);
    event Sealed(uint256 numBatches);
    event TaskPosted(uint256 indexed taskId, address indexed poster, string description,
                     uint256 threshold, uint256 reward, uint256 deadline,
                     bytes32 modelHash, uint256 batchIdx);
    event BaseEstablished(uint256 indexed taskId, uint256 baseScore);
    event WorkSubmitted(uint256 indexed taskId, address indexed miner,
                        bytes32 gradientHash, uint256 score);
    event ProvenWorkSubmitted(uint256 indexed taskId, address indexed miner,
                              bytes32 gradientHash, uint256 score, bytes32 proofHash);
    event RewardPaid(uint256 indexed taskId, address indexed miner, uint256 marginal, uint256 reward);
    event TaskFinalized(uint256 indexed taskId, uint256 totalMarginal, uint256 rewardPaid, uint256 winners);

    error NotSetupOperator();
    error AlreadySealed();
    error NotSealed();
    error BatchDataMismatch();
    error TaskNotFound();
    error TaskClosed();
    error TaskNotExpired();
    error AlreadyFinalized();
    error AlreadySubmitted();
    error SubmissionCapReached();
    error BadInstanceLength();
    error ChallengeMismatch();
    error ProofAlreadyUsed();
    error BaseAlreadySet();
    error NotPoster();
    error BadVka();
    error InvalidProof();
    error ScoreBelowThreshold();
    error BadParams();

    constructor(
        address _polToken, address _verifier, bytes32 _vkaDigest,
        bytes32 _batchDataDigest, uint256 _numBatches
    ) {
        if (_polToken == address(0) || _verifier == address(0) || _numBatches == 0) revert BadParams();
        polToken        = IERC20(_polToken);
        verifier        = IVerifierReusable(_verifier);
        vkaDigest       = _vkaDigest;
        batchDataDigest = _batchDataDigest;
        numBatches      = _numBatches;
        setupOperator   = msg.sender;
    }

    // ------------------------------------------------------------------
    // Setup
    // ------------------------------------------------------------------
    function loadBatches(uint256[] calldata commitments, uint256[] calldata labels) external {
        if (msg.sender != setupOperator) revert NotSetupOperator();
        if (isSealed) revert AlreadySealed();
        if (commitments.length != labels.length) revert BadParams();
        uint256 from = batchCommitments.length;
        for (uint256 i = 0; i < commitments.length; i++) {
            batchCommitments.push(commitments[i]);
            packedLabels.push(labels[i]);
        }
        if (batchCommitments.length > numBatches) revert BadParams();
        emit BatchesLoaded(from, commitments.length);
    }

    function seal() external {
        if (msg.sender != setupOperator) revert NotSetupOperator();
        if (isSealed) revert AlreadySealed();
        if (batchCommitments.length != numBatches) revert BadParams();
        if (keccak256(abi.encode(batchCommitments, packedLabels)) != batchDataDigest) revert BatchDataMismatch();
        isSealed = true;
        setupOperator = address(0);
        emit Sealed(numBatches);
    }

    // ------------------------------------------------------------------
    // Task lifecycle
    // ------------------------------------------------------------------
    function postTask(
        string calldata description, uint256 threshold, uint256 reward,
        uint256 deadline, bytes32 modelHash
    ) external returns (uint256) {
        if (!isSealed) revert NotSealed();
        if (threshold > 100) revert BadParams();
        if (deadline <= block.timestamp) revert BadParams();
        if (reward == 0) revert BadParams();
        require(polToken.transferFrom(msg.sender, address(this), reward), "reward transfer failed");

        uint256 taskId = ++_taskCounter;
        uint256 batchIdx = uint256(keccak256(abi.encode(blockhash(block.number - 1), taskId))) % numBatches;
        Task storage t = tasks[taskId];
        t.id = taskId; t.description = description; t.threshold = threshold;
        t.reward = reward; t.deadline = deadline; t.poster = msg.sender;
        t.modelHash = modelHash; t.batchIdx = batchIdx;

        emit TaskPosted(taskId, msg.sender, description, threshold, reward, deadline, modelHash, batchIdx);
        return taskId;
    }

    /// @notice Establish the base score: a verified proof of the base model on
    ///         this task's challenge. Poster-only (they posted the task and
    ///         committed its modelHash). The score is trustless; the assumption
    ///         is that the poster proved the current global model — see header.
    function establishBase(
        uint256 taskId, bytes calldata proof, uint256[] calldata instances, bytes32[] calldata vka
    ) external {
        Task storage task = tasks[taskId];
        if (task.id == 0) revert TaskNotFound();
        if (msg.sender != task.poster) revert NotPoster();
        if (task.baseSet) revert BaseAlreadySet();
        if (instances.length != EXPECTED_INSTANCES) revert BadInstanceLength();
        if (instances[CHALLENGE_IDX] != batchCommitments[task.batchIdx]) revert ChallengeMismatch();
        if (keccak256(abi.encodePacked(vka)) != vkaDigest) revert BadVka();
        _verifyOnChain(proof, instances, vka);

        task.baseScore = _scoreFromInstances(instances, packedLabels[task.batchIdx]);
        task.baseSet = true;
        emit BaseEstablished(taskId, task.baseScore);
    }

    function submitWithProof(
        uint256 taskId, bytes32 gradientHash, bytes calldata proof,
        uint256[] calldata instances, bytes32[] calldata vka
    ) external {
        Task storage task = _openTask(taskId);
        if (hasSubmitted[taskId][msg.sender]) revert AlreadySubmitted();
        if (provenCount[taskId] >= MAX_PROVEN) revert SubmissionCapReached();
        if (instances.length != EXPECTED_INSTANCES) revert BadInstanceLength();
        if (instances[CHALLENGE_IDX] != batchCommitments[task.batchIdx]) revert ChallengeMismatch();

        bytes32 proofHash = keccak256(proof);
        if (proofUsed[proofHash]) revert ProofAlreadyUsed();
        if (keccak256(abi.encodePacked(vka)) != vkaDigest) revert BadVka();
        _verifyOnChain(proof, instances, vka);

        uint256 score = _scoreFromInstances(instances, packedLabels[task.batchIdx]);
        if (score < task.threshold) revert ScoreBelowThreshold();

        proofUsed[proofHash] = true;
        hasSubmitted[taskId][msg.sender] = true;
        provenCount[taskId] += 1;

        _submissions[taskId].push(Submission({
            miner: msg.sender, gradientHash: gradientHash, score: score,
            submittedAt: block.timestamp, zkVerified: true, proofHash: proofHash
        }));
        emit ProvenWorkSubmitted(taskId, msg.sender, gradientHash, score, proofHash);
    }

    /// @notice Unverified liveness path. Claimed submissions never earn under the
    ///         proportional split (only proven scores count toward marginal), so
    ///         this exists purely to keep the chain moving when the prover is
    ///         down. Capped against Sybil flooding.
    function submitWork(uint256 taskId, bytes32 gradientHash, uint256 score) external {
        Task storage task = _openTask(taskId);
        if (hasSubmitted[taskId][msg.sender]) revert AlreadySubmitted();
        if (unverifiedCount[taskId] >= MAX_UNVERIFIED) revert SubmissionCapReached();
        if (score > 100) revert BadParams();
        if (score < task.threshold) revert ScoreBelowThreshold();
        hasSubmitted[taskId][msg.sender] = true;
        unverifiedCount[taskId] += 1;
        _submissions[taskId].push(Submission({
            miner: msg.sender, gradientHash: gradientHash, score: score,
            submittedAt: block.timestamp, zkVerified: false, proofHash: bytes32(0)
        }));
        emit WorkSubmitted(taskId, msg.sender, gradientHash, score);
    }

    /// @notice Permissionless settlement. Reward split among PROVEN submissions
    ///         in proportion to marginal improvement over the base; nobody beats
    ///         the base (or base never set, baseScore=0 but then any positive
    ///         score is "improvement") → see header. Claimed submissions never earn.
    function finalizeTask(uint256 taskId) external {
        Task storage task = tasks[taskId];
        if (task.id == 0) revert TaskNotFound();
        if (task.finalized) revert AlreadyFinalized();
        if (block.timestamp < task.deadline) revert TaskNotExpired();
        task.finalized = true;

        Submission[] storage subs = _submissions[taskId];
        uint256 base = task.baseScore;

        uint256 total = 0;
        for (uint256 i = 0; i < subs.length; i++) {
            if (subs[i].zkVerified && subs[i].score > base) total += subs[i].score - base;
        }

        if (total == 0) {
            require(polToken.transfer(task.poster, task.reward), "refund failed");
            emit TaskFinalized(taskId, 0, 0, 0);
            return;
        }

        uint256 paid = 0;
        uint256 winners = 0;
        for (uint256 i = 0; i < subs.length; i++) {
            if (!subs[i].zkVerified || subs[i].score <= base) continue;
            uint256 marginal = subs[i].score - base;
            uint256 share = (task.reward * marginal) / total;
            if (share > 0) {
                require(polToken.transfer(subs[i].miner, share), "reward transfer failed");
                paid += share; winners += 1;
                emit RewardPaid(taskId, subs[i].miner, marginal, share);
            }
        }
        uint256 dust = task.reward - paid;
        if (dust > 0) require(polToken.transfer(task.poster, dust), "dust refund failed");
        emit TaskFinalized(taskId, total, paid, winners);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------
    function _verifyOnChain(bytes calldata proof, uint256[] calldata instances, bytes32[] calldata vka) internal {
        (bool callOk, bytes memory ret) = address(verifier).call(
            abi.encodeWithSelector(IVerifierReusable.verifyProof.selector, proof, instances, vka)
        );
        if (!callOk || ret.length < 32) revert InvalidProof();
        bool verified;
        assembly { verified := mload(add(ret, 32)) }
        if (!verified) revert InvalidProof();
    }

    function _scoreFromInstances(uint256[] calldata instances, uint256 packed)
        internal pure returns (uint256)
    {
        uint256 correct = 0;
        for (uint256 img = 0; img < N; img++) {
            uint256 b = LOGITS_OFFSET + img * 10;
            int256 bestVal = _toSigned(instances[b]);
            uint256 bestDigit = 0;
            for (uint256 d = 1; d < 10; d++) {
                int256 v = _toSigned(instances[b + d]);
                if (v > bestVal) { bestVal = v; bestDigit = d; }
            }
            if (bestDigit == ((packed >> (img * 4)) & 0xF)) correct++;
        }
        return (correct * 100) / N;
    }

    function _toSigned(uint256 felt) internal pure returns (int256) {
        return felt <= FIELD_PRIME / 2 ? int256(felt) : -int256(FIELD_PRIME - felt);
    }

    function _openTask(uint256 taskId) internal view returns (Task storage task) {
        task = tasks[taskId];
        if (task.id == 0) revert TaskNotFound();
        if (task.finalized || block.timestamp >= task.deadline) revert TaskClosed();
    }

    // ------------------------------------------------------------------
    // Reads
    // ------------------------------------------------------------------
    function getTask(uint256 taskId) external view returns (Task memory) {
        if (tasks[taskId].id == 0) revert TaskNotFound();
        return tasks[taskId];
    }
    function getSubmissionCount(uint256 taskId) external view returns (uint256) {
        return _submissions[taskId].length;
    }
    function getSubmission(uint256 taskId, uint256 index) external view returns (Submission memory) {
        require(index < _submissions[taskId].length, "index out of bounds");
        return _submissions[taskId][index];
    }
    function getAllSubmissions(uint256 taskId) external view returns (Submission[] memory) {
        return _submissions[taskId];
    }
    function totalTasks() external view returns (uint256) { return _taskCounter; }
    function getTaskChallenge(uint256 taskId)
        external view returns (uint256 batchIdx, uint256 commitment, uint256 labels)
    {
        Task storage task = tasks[taskId];
        if (task.id == 0) revert TaskNotFound();
        return (task.batchIdx, batchCommitments[task.batchIdx], packedLabels[task.batchIdx]);
    }
}
