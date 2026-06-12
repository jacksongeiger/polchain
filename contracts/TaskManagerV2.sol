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

/// @title TaskManagerV2 — Proof of Learning, Era 2: scores are computed by
///        the contract from proofs — not claimed.
///
/// Era 1's hole: `submitWithProof` verified that *a* proof was valid but never
/// inspected its public instances, so the score parameter beside it was taken
/// on faith and any old proof could be replayed forever. V2 removes the score
/// parameter entirely. A proven submission carries a Halo2 proof of a batched
/// forward pass over a per-task challenge batch drawn from a pool committed at
/// deployment; the contract checks the challenge binding, burns the proof
/// nullifier, verifies on-chain, then computes the score itself from the
/// proof's public logit outputs via signed-field argmax.
///
/// After `seal()` the contract has ZERO privileged functions: anyone may post
/// tasks, submit work, and finalize. Unproven `submitWork` survives as a
/// second-class liveness path — a claimed score can never beat any proof.
contract TaskManagerV2 {
    // ------------------------------------------------------------------
    // Circuit constants (fixed by the frozen Era-2 EZKL circuit)
    // ------------------------------------------------------------------
    /// @notice images per challenge batch; proven scores are multiples of 100/N
    uint256 public constant N = 8;
    /// @notice instances layout: [0] = Poseidon batch commitment, [1..N*10] = logits
    uint256 public constant EXPECTED_INSTANCES = 1 + N * 10;
    /// @notice BN254 scalar field modulus — logits above p/2 decode as negative
    uint256 internal constant FIELD_PRIME =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    uint256 public constant MAX_UNVERIFIED = 16; // anti-Sybil cap, claimed path only
    uint256 public constant MAX_PROVEN     = 64; // proven slots cost a valid proof

    // ------------------------------------------------------------------
    // Immutable wiring
    // ------------------------------------------------------------------
    IERC20 public immutable polToken;
    IVerifierReusable public immutable verifier;
    /// @notice keccak256 of the circuit's verifying-key artifact (bytes32[] vka)
    bytes32 public immutable vkaDigest;
    /// @notice keccak256 over (batchCommitments ++ packedLabels), checked at seal()
    bytes32 public immutable batchDataDigest;
    uint256 public immutable numBatches;

    // ------------------------------------------------------------------
    // Challenge pool (loaded in chunks, then sealed forever)
    // ------------------------------------------------------------------
    uint256[] public batchCommitments;  // batchIdx → Poseidon felt (instances[0])
    uint256[] public packedLabels;      // batchIdx → N labels, 4 bits each
    bool public isSealed;
    address public setupOperator;       // address(0) after seal — ownerless

    // ------------------------------------------------------------------
    // Tasks & submissions
    // ------------------------------------------------------------------
    struct Task {
        uint256 id;
        string  description;
        uint256 threshold;     // minimum score (0-100)
        uint256 reward;        // POL escrowed
        uint256 deadline;
        address poster;        // receives the refund if no submissions
        bytes32 modelHash;     // global-model lineage commitment for this block
        uint256 batchIdx;      // challenge batch, derived at post time
        bool    finalized;
        address winner;
    }

    struct Submission {
        address miner;
        bytes32 gradientHash;
        uint256 score;
        uint256 submittedAt;
        bool    zkVerified;
        bytes32 proofHash;     // 0x0 for claimed submissions
    }

    uint256 private _taskCounter;
    mapping(uint256 => Task) public tasks;
    mapping(uint256 => Submission[]) private _submissions;
    mapping(uint256 => uint256) public provenCount;
    mapping(uint256 => uint256) public unverifiedCount;
    mapping(uint256 => mapping(address => bool)) public hasSubmitted;
    /// @notice global proof nullifier — a proof's bytes are spendable once, ever
    mapping(bytes32 => bool) public proofUsed;

    // ------------------------------------------------------------------
    // Events & errors
    // ------------------------------------------------------------------
    event BatchesLoaded(uint256 fromIdx, uint256 count);
    event Sealed(uint256 numBatches);
    event TaskPosted(uint256 indexed taskId, address indexed poster, string description,
                     uint256 threshold, uint256 reward, uint256 deadline,
                     bytes32 modelHash, uint256 batchIdx);
    event WorkSubmitted(uint256 indexed taskId, address indexed miner,
                        bytes32 gradientHash, uint256 score);
    event ProvenWorkSubmitted(uint256 indexed taskId, address indexed miner,
                              bytes32 gradientHash, uint256 score, bytes32 proofHash);
    event TaskFinalized(uint256 indexed taskId, address indexed winner,
                        uint256 reward, bool zkVerified);

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
    error BadInstanceLength();   // an Era-1 proof (794 instances) dies here
    error ChallengeMismatch();   // replaying your own proof from another task dies here
    error ProofAlreadyUsed();    // byte-copying a confirmed proof dies here
    error BadVka();
    error InvalidProof();        // tampered bytes or forged logits die here
    error ScoreBelowThreshold();
    error BadParams();

    constructor(
        address _polToken,
        address _verifier,
        bytes32 _vkaDigest,
        bytes32 _batchDataDigest,
        uint256 _numBatches
    ) {
        if (_polToken == address(0) || _verifier == address(0) || _numBatches == 0) {
            revert BadParams();
        }
        polToken        = IERC20(_polToken);
        verifier        = IVerifierReusable(_verifier);
        vkaDigest       = _vkaDigest;
        batchDataDigest = _batchDataDigest;
        numBatches      = _numBatches;
        setupOperator   = msg.sender;
    }

    // ------------------------------------------------------------------
    // Setup (pre-seal only; the contract is inert for mining until sealed)
    // ------------------------------------------------------------------

    function loadBatches(uint256[] calldata commitments, uint256[] calldata labels)
        external
    {
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

    /// @notice Verify the loaded pool against the digest pinned at deploy,
    ///         then renounce setup forever. After this call the contract has
    ///         no privileged functions of any kind.
    function seal() external {
        if (msg.sender != setupOperator) revert NotSetupOperator();
        if (isSealed) revert AlreadySealed();
        if (batchCommitments.length != numBatches) revert BadParams();
        if (keccak256(abi.encode(batchCommitments, packedLabels)) != batchDataDigest) {
            revert BatchDataMismatch();
        }
        isSealed = true;
        setupOperator = address(0);
        emit Sealed(numBatches);
    }

    // ------------------------------------------------------------------
    // Task lifecycle — fully permissionless after seal
    // ------------------------------------------------------------------

    /// @notice Post a task, escrowing `reward` POL from the caller. The
    ///         challenge batch is drawn from the committed pool using the
    ///         previous block hash — fixed at post time, unknown in advance.
    function postTask(
        string calldata description,
        uint256 threshold,
        uint256 reward,
        uint256 deadline,
        bytes32 modelHash
    ) external returns (uint256) {
        if (!isSealed) revert NotSealed();
        if (threshold > 100) revert BadParams();
        if (deadline <= block.timestamp) revert BadParams();
        if (reward == 0) revert BadParams();

        require(polToken.transferFrom(msg.sender, address(this), reward),
                "TaskManagerV2: reward transfer failed");

        uint256 taskId = ++_taskCounter;
        uint256 batchIdx = uint256(
            keccak256(abi.encode(blockhash(block.number - 1), taskId))
        ) % numBatches;

        tasks[taskId] = Task({
            id: taskId,
            description: description,
            threshold: threshold,
            reward: reward,
            deadline: deadline,
            poster: msg.sender,
            modelHash: modelHash,
            batchIdx: batchIdx,
            finalized: false,
            winner: address(0)
        });

        emit TaskPosted(taskId, msg.sender, description, threshold, reward,
                        deadline, modelHash, batchIdx);
        return taskId;
    }

    /// @notice Proven submission. There is deliberately NO score parameter:
    ///         the score is computed from the proof's public logit instances.
    /// @param vka The circuit's verifying-key artifact; pinned by digest at
    ///            deploy and registered with the reusable verifier. Supplied
    ///            via calldata because it is cheaper than storing 337 words.
    function submitWithProof(
        uint256 taskId,
        bytes32 gradientHash,
        bytes calldata proof,
        uint256[] calldata instances,
        bytes32[] calldata vka
    ) external {
        Task storage task = _openTask(taskId);
        if (hasSubmitted[taskId][msg.sender]) revert AlreadySubmitted();
        if (provenCount[taskId] >= MAX_PROVEN) revert SubmissionCapReached();

        // 1. Layout check first — an Era-1 single-inference proof has the
        //    wrong instance count and must die before any indexing.
        if (instances.length != EXPECTED_INSTANCES) revert BadInstanceLength();

        // 2. Challenge binding: the proof's hashed-input instance must match
        //    this task's committed batch. A proof for any other batch — e.g.
        //    your own valid proof from a previous task — fails here.
        if (instances[0] != batchCommitments[task.batchIdx]) revert ChallengeMismatch();

        // 3. Nullifier: proof bytes spend once, ever. A byte-copied proof
        //    fails here and the original submission stays credited.
        bytes32 proofHash = keccak256(proof);
        if (proofUsed[proofHash]) revert ProofAlreadyUsed();

        // 4. VKA pinning, then on-chain Halo2 verification.
        if (keccak256(abi.encodePacked(vka)) != vkaDigest) revert BadVka();
        _verifyOnChain(proof, instances, vka);

        // 5. THE POINT: the contract computes the score from proven logits.
        uint256 score = _scoreFromInstances(instances, packedLabels[task.batchIdx]);
        if (score < task.threshold) revert ScoreBelowThreshold();

        proofUsed[proofHash] = true;
        hasSubmitted[taskId][msg.sender] = true;
        provenCount[taskId] += 1;

        _submissions[taskId].push(Submission({
            miner: msg.sender,
            gradientHash: gradientHash,
            score: score,
            submittedAt: block.timestamp,
            zkVerified: true,
            proofHash: proofHash
        }));

        emit ProvenWorkSubmitted(taskId, msg.sender, gradientHash, score, proofHash);
    }

    /// @notice Unproven submission — kept for liveness, permanently second
    ///         class: any proven submission beats any claimed score. Capped
    ///         so a Sybil flood of claims can never crowd out a prover.
    function submitWork(uint256 taskId, bytes32 gradientHash, uint256 score) external {
        Task storage task = _openTask(taskId);
        if (hasSubmitted[taskId][msg.sender]) revert AlreadySubmitted();
        if (unverifiedCount[taskId] >= MAX_UNVERIFIED) revert SubmissionCapReached();
        if (score > 100) revert BadParams();
        if (score < task.threshold) revert ScoreBelowThreshold();

        hasSubmitted[taskId][msg.sender] = true;
        unverifiedCount[taskId] += 1;

        _submissions[taskId].push(Submission({
            miner: msg.sender,
            gradientHash: gradientHash,
            score: score,
            submittedAt: block.timestamp,
            zkVerified: false,
            proofHash: bytes32(0)
        }));

        emit WorkSubmitted(taskId, msg.sender, gradientHash, score);
    }

    /// @notice Permissionless settlement after the deadline. Ranking:
    ///         any proven submission beats any claimed one; among proven,
    ///         highest score wins with ties broken by lowest
    ///         keccak256(taskId, proofHash) — NOT submission order, which
    ///         would hand every tie to prove-queue position. Among claimed
    ///         (only when zero proofs exist): highest score, then earliest.
    function finalizeTask(uint256 taskId) external {
        Task storage task = tasks[taskId];
        if (task.id == 0) revert TaskNotFound();
        if (task.finalized) revert AlreadyFinalized();
        if (block.timestamp < task.deadline) revert TaskNotExpired();

        task.finalized = true;

        Submission[] storage subs = _submissions[taskId];
        if (subs.length == 0) {
            require(polToken.transfer(task.poster, task.reward),
                    "TaskManagerV2: refund failed");
            emit TaskFinalized(taskId, address(0), 0, false);
            return;
        }

        uint256 bestIdx = 0;
        for (uint256 i = 1; i < subs.length; i++) {
            if (_beats(taskId, subs[i], subs[bestIdx])) bestIdx = i;
        }

        address winner = subs[bestIdx].miner;
        task.winner = winner;
        require(polToken.transfer(winner, task.reward),
                "TaskManagerV2: reward transfer failed");
        emit TaskFinalized(taskId, winner, task.reward, subs[bestIdx].zkVerified);
    }

    // ------------------------------------------------------------------
    // Scoring & ranking internals
    // ------------------------------------------------------------------

    /// @dev Low-level verifier call: the EZKL reusable verifier reverts raw
    ///      (often with empty reason) on bad proofs, and its hand-rolled
    ///      assembly return encoding for the rescaled-instances tail does not
    ///      ABI-decode cleanly — so every failure shape is normalized to
    ///      InvalidProof and only the leading bool word of the return data is
    ///      read.
    function _verifyOnChain(
        bytes calldata proof,
        uint256[] calldata instances,
        bytes32[] calldata vka
    ) internal {
        (bool callOk, bytes memory ret) = address(verifier).call(
            abi.encodeWithSelector(IVerifierReusable.verifyProof.selector,
                                   proof, instances, vka)
        );
        if (!callOk || ret.length < 32) revert InvalidProof();
        bool verified;
        assembly { verified := mload(add(ret, 32)) }
        if (!verified) revert InvalidProof();
    }

    /// @dev Signed-field argmax per image over the proof's public logits.
    ///      Felts above p/2 decode as negative. instances[1 + img*10 + d].
    function _scoreFromInstances(uint256[] calldata instances, uint256 packed)
        internal
        pure
        returns (uint256)
    {
        uint256 correct = 0;
        for (uint256 img = 0; img < N; img++) {
            uint256 base = 1 + img * 10;
            int256 bestVal = _toSigned(instances[base]);
            uint256 bestDigit = 0;
            for (uint256 d = 1; d < 10; d++) {
                int256 v = _toSigned(instances[base + d]);
                if (v > bestVal) {
                    bestVal = v;
                    bestDigit = d;
                }
            }
            if (bestDigit == ((packed >> (img * 4)) & 0xF)) correct++;
        }
        return (correct * 100) / N;
    }

    function _toSigned(uint256 felt) internal pure returns (int256) {
        return felt <= FIELD_PRIME / 2
            ? int256(felt)
            : -int256(FIELD_PRIME - felt);
    }

    /// @dev Does `a` beat `b`?
    function _beats(uint256 taskId, Submission storage a, Submission storage b)
        internal
        view
        returns (bool)
    {
        if (a.zkVerified != b.zkVerified) return a.zkVerified; // proof beats claim, always
        if (a.score != b.score) return a.score > b.score;
        if (a.zkVerified) {
            // grinding this tie-break costs one full prove run per attempt
            return uint256(keccak256(abi.encode(taskId, a.proofHash)))
                 < uint256(keccak256(abi.encode(taskId, b.proofHash)));
        }
        return a.submittedAt < b.submittedAt;
    }

    function _openTask(uint256 taskId) internal view returns (Task storage task) {
        task = tasks[taskId];
        if (task.id == 0) revert TaskNotFound();
        if (task.finalized || block.timestamp >= task.deadline) revert TaskClosed();
    }

    // ------------------------------------------------------------------
    // Read functions (Era-1-compatible shapes + Era-2 additions)
    // ------------------------------------------------------------------

    function getTask(uint256 taskId) external view returns (Task memory) {
        if (tasks[taskId].id == 0) revert TaskNotFound();
        return tasks[taskId];
    }

    function getSubmissionCount(uint256 taskId) external view returns (uint256) {
        return _submissions[taskId].length;
    }

    function getSubmission(uint256 taskId, uint256 index)
        external view returns (Submission memory)
    {
        require(index < _submissions[taskId].length, "TaskManagerV2: index out of bounds");
        return _submissions[taskId][index];
    }

    function getAllSubmissions(uint256 taskId)
        external view returns (Submission[] memory)
    {
        return _submissions[taskId];
    }

    function totalTasks() external view returns (uint256) {
        return _taskCounter;
    }

    /// @notice Everything a prover needs for this task's challenge.
    function getTaskChallenge(uint256 taskId)
        external view returns (uint256 batchIdx, uint256 commitment, uint256 labels)
    {
        Task storage task = tasks[taskId];
        if (task.id == 0) revert TaskNotFound();
        return (task.batchIdx, batchCommitments[task.batchIdx], packedLabels[task.batchIdx]);
    }
}
