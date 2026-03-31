const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const ONE_DAY = 60 * 60 * 24;
const SUPPLY = ethers.parseEther("1000000");

describe("POLToken", function () {
  let token, owner, other;

  beforeEach(async function () {
    [owner, other] = await ethers.getSigners();
    const POLToken = await ethers.getContractFactory("POLToken");
    token = await POLToken.deploy();
  });

  it("has correct name and symbol", async function () {
    expect(await token.name()).to.equal("Proof of Learning");
    expect(await token.symbol()).to.equal("POL");
  });

  it("mints 1,000,000 POL to deployer", async function () {
    expect(await token.totalSupply()).to.equal(SUPPLY);
    expect(await token.balanceOf(owner.address)).to.equal(SUPPLY);
  });

  it("mints nothing to other addresses", async function () {
    expect(await token.balanceOf(other.address)).to.equal(0n);
  });
});

describe("TaskManager", function () {
  let token, manager, owner, miner1, miner2, other;
  const REWARD = ethers.parseEther("1000");
  const THRESHOLD = 70;

  async function deployFixture() {
    [owner, miner1, miner2, other] = await ethers.getSigners();

    const POLToken = await ethers.getContractFactory("POLToken");
    token = await POLToken.deploy();

    const TaskManager = await ethers.getContractFactory("TaskManager");
    manager = await TaskManager.deploy(await token.getAddress());

    // Approve TaskManager to pull reward tokens for each test
    await token.approve(await manager.getAddress(), ethers.MaxUint256);
  }

  async function postTask(threshold = THRESHOLD, reward = REWARD, offsetSeconds = ONE_DAY) {
    const deadline = (await time.latest()) + offsetSeconds;
    const tx = await manager.postTask("Train ResNet on CIFAR-10", threshold, reward, deadline);
    const receipt = await tx.wait();
    // Parse TaskPosted event to get taskId
    const event = receipt.logs.map((l) => {
      try { return manager.interface.parseLog(l); } catch { return null; }
    }).find((e) => e && e.name === "TaskPosted");
    return { taskId: event.args.taskId, deadline };
  }

  beforeEach(deployFixture);

  // ---------------------------------------------------------------------------
  describe("postTask", function () {
    it("owner can post a task and escrow is funded", async function () {
      const { taskId } = await postTask();
      const task = await manager.getTask(taskId);
      expect(task.description).to.equal("Train ResNet on CIFAR-10");
      expect(task.threshold).to.equal(THRESHOLD);
      expect(task.reward).to.equal(REWARD);
      expect(task.finalized).to.be.false;
      expect(await token.balanceOf(await manager.getAddress())).to.equal(REWARD);
    });

    it("non-owner cannot post a task", async function () {
      const deadline = (await time.latest()) + ONE_DAY;
      await expect(
        manager.connect(other).postTask("task", 50, REWARD, deadline)
      ).to.be.revertedWith("TaskManager: not owner");
    });

    it("rejects threshold > 100", async function () {
      const deadline = (await time.latest()) + ONE_DAY;
      await expect(manager.postTask("task", 101, REWARD, deadline))
        .to.be.revertedWith("TaskManager: threshold exceeds 100");
    });

    it("rejects deadline in the past", async function () {
      const past = (await time.latest()) - 1;
      await expect(manager.postTask("task", 50, REWARD, past))
        .to.be.revertedWith("TaskManager: deadline in the past");
    });

    it("rejects zero reward", async function () {
      const deadline = (await time.latest()) + ONE_DAY;
      await expect(manager.postTask("task", 50, 0, deadline))
        .to.be.revertedWith("TaskManager: reward must be nonzero");
    });
  });

  // ---------------------------------------------------------------------------
  describe("submitWork", function () {
    let taskId;
    const hash = ethers.keccak256(ethers.toUtf8Bytes("gradient-v1"));

    beforeEach(async function () {
      ({ taskId } = await postTask());
    });

    it("miner can submit a qualifying score", async function () {
      await expect(manager.connect(miner1).submitWork(taskId, hash, 85))
        .to.emit(manager, "WorkSubmitted")
        .withArgs(taskId, miner1.address, hash, 85);

      expect(await manager.getSubmissionCount(taskId)).to.equal(1);
      const sub = await manager.getSubmission(taskId, 0);
      expect(sub.miner).to.equal(miner1.address);
      expect(sub.score).to.equal(85);
      expect(sub.gradientHash).to.equal(hash);
    });

    it("rejects score below threshold", async function () {
      await expect(
        manager.connect(miner1).submitWork(taskId, hash, THRESHOLD - 1)
      ).to.be.revertedWith("TaskManager: score below threshold");
    });

    it("rejects score > 100", async function () {
      await expect(
        manager.connect(miner1).submitWork(taskId, hash, 101)
      ).to.be.revertedWith("TaskManager: score exceeds 100");
    });

    it("rejects submission after deadline", async function () {
      await time.increase(ONE_DAY + 1);
      await expect(
        manager.connect(miner1).submitWork(taskId, hash, 80)
      ).to.be.revertedWith("TaskManager: deadline passed");
    });

    it("rejects submission to nonexistent task", async function () {
      await expect(
        manager.connect(miner1).submitWork(999, hash, 80)
      ).to.be.revertedWith("TaskManager: task does not exist");
    });

    it("multiple miners can submit", async function () {
      const hash2 = ethers.keccak256(ethers.toUtf8Bytes("gradient-v2"));
      await manager.connect(miner1).submitWork(taskId, hash, 75);
      await manager.connect(miner2).submitWork(taskId, hash2, 90);
      expect(await manager.getSubmissionCount(taskId)).to.equal(2);
    });
  });

  // ---------------------------------------------------------------------------
  describe("finalizeTask", function () {
    let taskId;

    beforeEach(async function () {
      ({ taskId } = await postTask());
      const hash1 = ethers.keccak256(ethers.toUtf8Bytes("gradient-1"));
      const hash2 = ethers.keccak256(ethers.toUtf8Bytes("gradient-2"));
      await manager.connect(miner1).submitWork(taskId, hash1, 75);
      await manager.connect(miner2).submitWork(taskId, hash2, 92);
    });

    it("cannot finalize before deadline", async function () {
      await expect(manager.finalizeTask(taskId))
        .to.be.revertedWith("TaskManager: deadline not reached");
    });

    it("owner finalizes and highest scorer wins", async function () {
      await time.increase(ONE_DAY + 1);
      const before = await token.balanceOf(miner2.address);

      await expect(manager.finalizeTask(taskId))
        .to.emit(manager, "TaskFinalized")
        .withArgs(taskId, miner2.address, REWARD);

      expect(await token.balanceOf(miner2.address)).to.equal(before + REWARD);
      const task = await manager.getTask(taskId);
      expect(task.finalized).to.be.true;
      expect(task.winner).to.equal(miner2.address);
    });

    it("cannot finalize twice", async function () {
      await time.increase(ONE_DAY + 1);
      await manager.finalizeTask(taskId);
      await expect(manager.finalizeTask(taskId))
        .to.be.revertedWith("TaskManager: task already finalized");
    });

    it("non-owner cannot finalize", async function () {
      await time.increase(ONE_DAY + 1);
      await expect(manager.connect(other).finalizeTask(taskId))
        .to.be.revertedWith("TaskManager: not owner");
    });

    it("refunds owner when no submissions exist", async function () {
      // Post a new task with no submissions
      const deadline2 = (await time.latest()) + ONE_DAY;
      await manager.postTask("Empty task", 50, REWARD, deadline2);
      const emptyId = await manager.totalTasks();

      await time.increase(ONE_DAY + 1);
      const before = await token.balanceOf(owner.address);
      await manager.finalizeTask(emptyId);
      expect(await token.balanceOf(owner.address)).to.equal(before + REWARD);
    });

    it("first-submitted wins on tie", async function () {
      // Post fresh task, have miner1 submit first with same score as miner2
      const { taskId: tieTaskId } = await postTask(50, REWARD, ONE_DAY * 2);
      const h1 = ethers.keccak256(ethers.toUtf8Bytes("tie-1"));
      const h2 = ethers.keccak256(ethers.toUtf8Bytes("tie-2"));
      await manager.connect(miner1).submitWork(tieTaskId, h1, 80);
      await manager.connect(miner2).submitWork(tieTaskId, h2, 80);

      await time.increase(ONE_DAY * 2 + 1);
      await expect(manager.finalizeTask(tieTaskId))
        .to.emit(manager, "TaskFinalized")
        .withArgs(tieTaskId, miner1.address, REWARD);
    });
  });

  // ---------------------------------------------------------------------------
  describe("read functions", function () {
    it("getAllSubmissions returns all entries", async function () {
      const { taskId } = await postTask();
      const h1 = ethers.keccak256(ethers.toUtf8Bytes("g1"));
      const h2 = ethers.keccak256(ethers.toUtf8Bytes("g2"));
      await manager.connect(miner1).submitWork(taskId, h1, 75);
      await manager.connect(miner2).submitWork(taskId, h2, 88);
      const all = await manager.getAllSubmissions(taskId);
      expect(all.length).to.equal(2);
      expect(all[0].miner).to.equal(miner1.address);
      expect(all[1].miner).to.equal(miner2.address);
    });

    it("totalTasks increments with each post", async function () {
      expect(await manager.totalTasks()).to.equal(0);
      await postTask();
      await postTask();
      expect(await manager.totalTasks()).to.equal(2);
    });
  });
});
