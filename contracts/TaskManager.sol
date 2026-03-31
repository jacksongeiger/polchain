// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title TaskManager — Proof of Learning Mining Protocol
/// @notice Owner posts training tasks with POL rewards; miners submit gradient
///         hashes and performance scores; highest scorer after the deadline wins.
contract TaskManager {
    struct Task {
        uint256 id;
        string description;
        uint256 threshold;      // minimum score (0-100) required to submit
        uint256 reward;         // POL tokens (in wei) locked for this task
        uint256 deadline;       // unix timestamp after which finalize is allowed
        bool finalized;
        address winner;         // set after finalization
    }

    struct Submission {
        address miner;
        bytes32 gradientHash;
        uint256 score;          // 0-100
        uint256 submittedAt;
    }

    IERC20 public immutable polToken;
    address public owner;
    uint256 private _taskCounter;

    mapping(uint256 => Task) public tasks;
    // taskId => array of submissions
    mapping(uint256 => Submission[]) private _submissions;

    event TaskPosted(uint256 indexed taskId, string description, uint256 threshold, uint256 reward, uint256 deadline);
    event WorkSubmitted(uint256 indexed taskId, address indexed miner, bytes32 gradientHash, uint256 score);
    event TaskFinalized(uint256 indexed taskId, address indexed winner, uint256 reward);

    modifier onlyOwner() {
        require(msg.sender == owner, "TaskManager: not owner");
        _;
    }

    constructor(address _polToken) {
        owner = msg.sender;
        polToken = IERC20(_polToken);
    }

    /// @notice Post a new training task. Caller must have approved `reward` POL to this contract first.
    /// @param description  Human-readable task description
    /// @param threshold    Minimum score (0-100) a submission must meet
    /// @param reward       POL token amount (in wei) paid to the winner
    /// @param deadline     Unix timestamp; submissions accepted before this, finalize after
    function postTask(
        string calldata description,
        uint256 threshold,
        uint256 reward,
        uint256 deadline
    ) external onlyOwner returns (uint256) {
        require(threshold <= 100, "TaskManager: threshold exceeds 100");
        require(deadline > block.timestamp, "TaskManager: deadline in the past");
        require(reward > 0, "TaskManager: reward must be nonzero");

        // Pull the reward into escrow
        require(polToken.transferFrom(msg.sender, address(this), reward), "TaskManager: reward transfer failed");

        uint256 taskId = ++_taskCounter;
        tasks[taskId] = Task({
            id: taskId,
            description: description,
            threshold: threshold,
            reward: reward,
            deadline: deadline,
            finalized: false,
            winner: address(0)
        });

        emit TaskPosted(taskId, description, threshold, reward, deadline);
        return taskId;
    }

    /// @notice Submit a gradient hash and performance score for a task.
    /// @param taskId       The task to submit against
    /// @param gradientHash keccak256 hash of the submitted gradient
    /// @param score        Performance score 0-100; must be >= task threshold
    function submitWork(
        uint256 taskId,
        bytes32 gradientHash,
        uint256 score
    ) external {
        Task storage task = tasks[taskId];
        require(task.id != 0, "TaskManager: task does not exist");
        require(!task.finalized, "TaskManager: task already finalized");
        require(block.timestamp < task.deadline, "TaskManager: deadline passed");
        require(score <= 100, "TaskManager: score exceeds 100");
        require(score >= task.threshold, "TaskManager: score below threshold");

        _submissions[taskId].push(Submission({
            miner: msg.sender,
            gradientHash: gradientHash,
            score: score,
            submittedAt: block.timestamp
        }));

        emit WorkSubmitted(taskId, msg.sender, gradientHash, score);
    }

    /// @notice Finalize a task after its deadline. Finds the highest-scoring
    ///         submission and transfers the POL reward to that miner.
    ///         If no valid submissions exist, reward is returned to the owner.
    function finalizeTask(uint256 taskId) external onlyOwner {
        Task storage task = tasks[taskId];
        require(task.id != 0, "TaskManager: task does not exist");
        require(!task.finalized, "TaskManager: task already finalized");
        require(block.timestamp >= task.deadline, "TaskManager: deadline not reached");

        task.finalized = true;

        Submission[] storage subs = _submissions[taskId];
        if (subs.length == 0) {
            // No submissions — return escrow to owner
            require(polToken.transfer(owner, task.reward), "TaskManager: refund failed");
            emit TaskFinalized(taskId, address(0), 0);
            return;
        }

        // Find the highest-scoring submission (first-submitted wins ties)
        uint256 bestIndex = 0;
        for (uint256 i = 1; i < subs.length; i++) {
            if (subs[i].score > subs[bestIndex].score) {
                bestIndex = i;
            }
        }

        address winner = subs[bestIndex].miner;
        task.winner = winner;

        require(polToken.transfer(winner, task.reward), "TaskManager: reward transfer failed");
        emit TaskFinalized(taskId, winner, task.reward);
    }

    // -------------------------------------------------------------------------
    // Read functions
    // -------------------------------------------------------------------------

    function getTask(uint256 taskId) external view returns (Task memory) {
        require(tasks[taskId].id != 0, "TaskManager: task does not exist");
        return tasks[taskId];
    }

    function getSubmissionCount(uint256 taskId) external view returns (uint256) {
        return _submissions[taskId].length;
    }

    function getSubmission(uint256 taskId, uint256 index) external view returns (Submission memory) {
        require(index < _submissions[taskId].length, "TaskManager: index out of bounds");
        return _submissions[taskId][index];
    }

    function getAllSubmissions(uint256 taskId) external view returns (Submission[] memory) {
        return _submissions[taskId];
    }

    function totalTasks() external view returns (uint256) {
        return _taskCounter;
    }
}
