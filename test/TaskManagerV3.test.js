/**
 * TaskManagerV3 — Proof of Improvement.
 *
 * Proven path + gauntlet run against the REAL EZKL verifier with REAL spike
 * proofs (test/fixtures/era2_testdata.json, the logrows-18 param-private
 * circuit — unchanged from V2). The marginal-reward MATH runs against a mock
 * verifier so we can force exact scores (real proofs all score 100 on their
 * batch, which can't exercise a proportional split).
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const fixture = require("./fixtures/era2_testdata.json");

const FIELD_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const toSigned = (f) => { const v = BigInt(f); return v <= FIELD_PRIME / 2n ? v : v - FIELD_PRIME; };

function expectedScore(instances, labels) {
  let correct = 0;
  for (let img = 0; img < 8; img++) {
    let bestVal = toSigned(instances[1 + img * 10]), bestDigit = 0;
    for (let d = 1; d < 10; d++) {
      const v = toSigned(instances[1 + img * 10 + d]);
      if (v > bestVal) { bestVal = v; bestDigit = d; }
    }
    if (bestDigit === labels[img]) correct++;
  }
  return Math.floor((correct * 100) / 8);
}
const vkaDigestOf = (vka) => ethers.keccak256(ethers.concat(vka));
const batchDigestOf = (c, l) =>
  ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256[]", "uint256[]"], [c, l]));

const commitments = fixture.batches.map((b) => BigInt(b.commitment));
const packedLabels = fixture.batches.map((b) => BigInt(b.packedLabels));

async function post(manager, signer, threshold = 0) {
  const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
  const rc = await (await manager.connect(signer).postTask(
    "task", threshold, ethers.parseEther("100"), deadline, ethers.id("model")
  )).wait();
  const ev = rc.logs.map((l) => { try { return manager.interface.parseLog(l); } catch { return null; } })
    .find((p) => p && p.name === "TaskPosted");
  return { taskId: ev.args.taskId, batchIdx: Number(ev.args.batchIdx) };
}
const proofForBatch = (b) => (b === 1 ? fixture.proofs.batch1 : fixture.proofs.global);
const otherBatchProof = (b) => (b === 1 ? fixture.proofs.global : fixture.proofs.batch1);
const labelsForBatch = (b) => fixture.batches[b].labels;

describe("TaskManagerV3 — Proof of Improvement", function () {
  this.timeout(180_000);

  // ---- real verifier / real proofs ----------------------------------------
  describe("real proofs through the real verifier", () => {
    async function realStack() {
      const [op, alice, bob] = await ethers.getSigners();
      const token = await (await ethers.getContractFactory("POLToken")).deploy();
      const verifier = await (await ethers.getContractFactory("Halo2VerifierReusable")).deploy();
      await verifier.registerVka(fixture.vka);
      const manager = await (await ethers.getContractFactory("TaskManagerV3")).deploy(
        await token.getAddress(), await verifier.getAddress(),
        vkaDigestOf(fixture.vka), batchDigestOf(commitments, packedLabels), 2
      );
      await manager.loadBatches(commitments, packedLabels);
      await manager.seal();
      await token.approve(await manager.getAddress(), ethers.MaxUint256);
      await token.transfer(alice.address, ethers.parseEther("10000"));
      await token.connect(alice).approve(await manager.getAddress(), ethers.MaxUint256);
      return { token, verifier, manager, op, alice, bob };
    }

    it("computes the score on-chain from a real proof, and establishBase works (poster-only)", async () => {
      const { manager, op, bob } = await realStack();
      const { taskId, batchIdx } = await post(manager, op);
      const p = proofForBatch(batchIdx);

      await expect(manager.connect(bob).establishBase(taskId, p.proof, p.instances, fixture.vka))
        .to.be.revertedWithCustomError(manager, "NotPoster");
      const rc = await (await manager.connect(op).establishBase(taskId, p.proof, p.instances, fixture.vka)).wait();
      console.log(`      ⛽ establishBase (real verify): ${rc.gasUsed} gas`);

      const task = await manager.getTask(taskId);
      expect(Number(task.baseScore)).to.equal(expectedScore(p.instances, labelsForBatch(batchIdx)));
      expect(task.baseSet).to.equal(true);
    });

    it("identical models (base == miner) → nobody improves → poster refunded", async () => {
      const { token, manager, op, alice, bob } = await realStack();
      // alice posts so we can watch her balance cleanly
      const before = await token.balanceOf(alice.address);
      const { taskId, batchIdx } = await post(manager, alice);
      const p = proofForBatch(batchIdx);
      await manager.connect(alice).establishBase(taskId, p.proof, p.instances, fixture.vka);
      // bob proves a DIFFERENT real model (variant) — still ~100, no improvement
      const v = batchIdx === 1 ? fixture.proofs.batch1 : fixture.proofs.variant_a;
      if (v.instances[0] === p.instances[0] && v !== p) {
        await manager.connect(bob).submitWithProof(taskId, ethers.id("g"), v.proof, v.instances, fixture.vka);
      }
      await ethers.provider.send("evm_increaseTime", [3601]);
      await manager.finalizeTask(taskId);
      expect(await token.balanceOf(alice.address)).to.equal(before); // full refund
    });

    describe("gauntlet (real proofs must revert)", () => {
      it("GHOST OF ERA 1 → BadInstanceLength", async () => {
        const { manager, op, bob } = await realStack();
        const { taskId } = await post(manager, op);
        await expect(manager.connect(bob).submitWithProof(
          taskId, ethers.id("ghost"), fixture.era1_ghost.proof, fixture.era1_ghost.instances, fixture.vka
        )).to.be.revertedWithCustomError(manager, "BadInstanceLength");
      });
      it("STALE CHALLENGE → ChallengeMismatch", async () => {
        const { manager, op, bob } = await realStack();
        const { taskId, batchIdx } = await post(manager, op);
        const s = otherBatchProof(batchIdx);
        await expect(manager.connect(bob).submitWithProof(taskId, ethers.id("s"), s.proof, s.instances, fixture.vka))
          .to.be.revertedWithCustomError(manager, "ChallengeMismatch");
      });
      it("COPYCAT proof → ProofAlreadyUsed", async () => {
        const { manager, op, bob, alice } = await realStack();
        const { taskId, batchIdx } = await post(manager, op);
        const p = proofForBatch(batchIdx);
        await manager.connect(bob).submitWithProof(taskId, ethers.id("h"), p.proof, p.instances, fixture.vka);
        await expect(manager.connect(alice).submitWithProof(taskId, ethers.id("c"), p.proof, p.instances, fixture.vka))
          .to.be.revertedWithCustomError(manager, "ProofAlreadyUsed");
      });
      it("TAMPERED proof → InvalidProof", async () => {
        const { manager, op, bob } = await realStack();
        const { taskId, batchIdx } = await post(manager, op);
        const p = proofForBatch(batchIdx);
        const b = ethers.getBytes(p.proof); b[1000] ^= 0xff;
        await expect(manager.connect(bob).submitWithProof(taskId, ethers.id("t"), ethers.hexlify(b), p.instances, fixture.vka))
          .to.be.revertedWithCustomError(manager, "InvalidProof");
      });
    });
  });

  // ---- marginal-reward math (mock verifier, forced scores) -----------------
  describe("marginal-reward split (mock verifier)", () => {
    async function mockStack() {
      const signers = await ethers.getSigners();
      const [op] = signers;
      const token = await (await ethers.getContractFactory("POLToken")).deploy();
      const mock = await (await ethers.getContractFactory("MockVerifierV2")).deploy();
      const labels = [BigInt(fixture.batches[0].packedLabels), BigInt(fixture.batches[1].packedLabels)];
      const manager = await (await ethers.getContractFactory("TaskManagerV3")).deploy(
        await token.getAddress(), await mock.getAddress(), ethers.keccak256("0x"),
        batchDigestOf([1n, 2n], labels), 2
      );
      await manager.loadBatches([1n, 2n], labels);
      await manager.seal();
      await token.approve(await manager.getAddress(), ethers.MaxUint256);
      return { token, manager, signers, labels };
    }
    function labelsFromPacked(p) {
      const o = []; for (let i = 0; i < 8; i++) o.push(Number((BigInt(p) >> BigInt(i * 4)) & 0xfn)); return o;
    }
    // logits that argmax to `digits`, prefixed with the batch commitment
    function synth(commitment, digits) {
      const inst = [commitment];
      for (let img = 0; img < 8; img++) for (let d = 0; d < 10; d++) inst.push(d === digits[img] ? 1000n : 1n);
      return inst.map((v) => "0x" + BigInt(v).toString(16).padStart(64, "0"));
    }
    // craft instances scoring exactly `correct`/8 on the given batch
    function instancesScoring(commitment, labels, correct) {
      const digits = labels.map((l, i) => (i < correct ? l : (l + 1) % 10));
      return synth(commitment, digits);
    }

    it("splits reward proportional to marginal improvement over base", async () => {
      const { token, manager, signers } = await mockStack();
      const [op, , bob, carol] = signers;
      const { taskId, batchIdx } = await post(manager, op);
      const commitment = batchIdx === 0 ? 1n : 2n;
      const labels = labelsFromPacked(fixture.batches[batchIdx].packedLabels);

      // base = 4/8 = 50
      await manager.establishBase(taskId, "0x", instancesScoring(commitment, labels, 4), []);
      // bob 6/8=75 (marginal 25), carol 7/8=87 (marginal 37)
      await manager.connect(bob).submitWithProof(taskId, ethers.id("b"),
        ethers.hexlify(ethers.randomBytes(64)), instancesScoring(commitment, labels, 6), []);
      await manager.connect(carol).submitWithProof(taskId, ethers.id("c"),
        ethers.hexlify(ethers.randomBytes(64)), instancesScoring(commitment, labels, 7), []);

      const bobBefore = await token.balanceOf(bob.address);
      const carolBefore = await token.balanceOf(carol.address);
      await ethers.provider.send("evm_increaseTime", [3601]);
      await manager.finalizeTask(taskId);

      const reward = ethers.parseEther("100");
      const bobGain = (await token.balanceOf(bob.address)) - bobBefore;
      const carolGain = (await token.balanceOf(carol.address)) - carolBefore;
      // 75→marginal 25, 87→marginal 37 (12.5-step scores: 75 and 87 = 6/8,7/8 → 75,87; base 50)
      const mB = 75 - 50, mC = 87 - 50, tot = mB + mC;
      expect(bobGain).to.equal(reward * BigInt(mB) / BigInt(tot));
      expect(carolGain).to.equal(reward * BigInt(mC) / BigInt(tot));
      console.log(`      💰 bob ${ethers.formatEther(bobGain)} / carol ${ethers.formatEther(carolGain)} POL (marginal ${mB}:${mC})`);
    });

    it("a free-rider AT the base earns zero", async () => {
      const { token, manager, signers } = await mockStack();
      const [op, , bob, carol] = signers;
      const { taskId, batchIdx } = await post(manager, op);
      const commitment = batchIdx === 0 ? 1n : 2n;
      const labels = labelsFromPacked(fixture.batches[batchIdx].packedLabels);
      await manager.establishBase(taskId, "0x", instancesScoring(commitment, labels, 6), []); // base 75
      // bob ties the base (75 → marginal 0); carol beats it (87 → marginal 37)
      await manager.connect(bob).submitWithProof(taskId, ethers.id("b"),
        ethers.hexlify(ethers.randomBytes(64)), instancesScoring(commitment, labels, 6), []);
      await manager.connect(carol).submitWithProof(taskId, ethers.id("c"),
        ethers.hexlify(ethers.randomBytes(64)), instancesScoring(commitment, labels, 7), []);
      const bobBefore = await token.balanceOf(bob.address);
      await ethers.provider.send("evm_increaseTime", [3601]);
      await manager.finalizeTask(taskId);
      expect((await token.balanceOf(bob.address)) - bobBefore).to.equal(0n); // free-rider earns nothing
    });

    it("nobody beats the base → poster refunded in full", async () => {
      const { token, manager, signers } = await mockStack();
      const [op, , bob] = signers;
      const before = await token.balanceOf(op.address);
      const { taskId, batchIdx } = await post(manager, op);
      const commitment = batchIdx === 0 ? 1n : 2n;
      const labels = labelsFromPacked(fixture.batches[batchIdx].packedLabels);
      await manager.establishBase(taskId, "0x", instancesScoring(commitment, labels, 7), []); // base 87
      await manager.connect(bob).submitWithProof(taskId, ethers.id("b"),
        ethers.hexlify(ethers.randomBytes(64)), instancesScoring(commitment, labels, 5), []); // 62 < 87
      await ethers.provider.send("evm_increaseTime", [3601]);
      await manager.finalizeTask(taskId);
      expect(await token.balanceOf(op.address)).to.equal(before); // net zero: refunded
    });

    it("base can only be set once, by the poster", async () => {
      const { manager, signers } = await mockStack();
      const [op, , bob] = signers;
      const { taskId, batchIdx } = await post(manager, op);
      const commitment = batchIdx === 0 ? 1n : 2n;
      const labels = labelsFromPacked(fixture.batches[batchIdx].packedLabels);
      await manager.establishBase(taskId, "0x", instancesScoring(commitment, labels, 4), []);
      await expect(manager.establishBase(taskId, "0x", instancesScoring(commitment, labels, 4), []))
        .to.be.revertedWithCustomError(manager, "BaseAlreadySet");
    });

    it("Sybil flood of claims is capped and never blocks a prover", async () => {
      const { manager, signers } = await mockStack();
      const [op] = signers;
      const { taskId } = await post(manager, op);
      for (let i = 0; i < 16; i++)
        await manager.connect(signers[4 + i]).submitWork(taskId, ethers.id(`s${i}`), 90);
      await expect(manager.connect(signers[3]).submitWork(taskId, ethers.id("s17"), 90))
        .to.be.revertedWithCustomError(manager, "SubmissionCapReached");
    });
  });
});
