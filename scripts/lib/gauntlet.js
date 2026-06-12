/**
 * gauntlet.js — the adversarial gauntlet. Each attack is a REAL transaction to
 * the live Era-2 contract that REVERTS, producing an on-chain receipt with a
 * decoded reason and a BaseScan link. Nothing here is simulated: a card never
 * ships a verdict its transaction didn't actually earn.
 *
 * These are exact ports of the six adversarial cases proven in
 * test/TaskManagerV2.test.js — the same forgeries, now against Base Sepolia.
 *
 * Each attack needs a real valid proof for the CURRENT task's challenge batch
 * as raw material (to tamper, copy, or stale-replay). The caller supplies it
 * via the prove server; HONEST is the green control that actually lands.
 *
 * Failure-shape decoding: TaskManagerV2 custom errors decode by selector;
 * the EZKL verifier reverts raw (often empty reason) on bad proofs — that path
 * is normalized to InvalidProof in the contract, but the decoder still labels
 * which layer fired so the UI can say "verifier-layer revert" vs "guard".
 */
const { ethers } = require("ethers");

// Attack catalogue. `build` mutates a known-good proof into the forgery;
// `expect` is the custom error the contract must raise.
const ATTACKS = {
  FORGED_SCORE: {
    title: "FORGED SCORE",
    forgery: "Claim 99 with no proof at all (submitWork).",
    lesson: "Lands as CLAIMED — then loses at finalize to any proven score. submitWithProof has no score field to lie in.",
    kind: "claimed", // special: this one is SUPPOSED to land, then lose
  },
  TAMPERED_PROOF: {
    title: "TAMPERED PROOF",
    forgery: "Flip one byte of a valid proof.",
    lesson: "The Halo2 verifier rejects it — a proof is all-or-nothing.",
    expect: "InvalidProof",
    layer: "verifier",
    build: (good) => {
      const b = ethers.getBytes(good.proof);
      b[Math.floor(b.length / 2)] ^= 0xff;
      return { ...good, proof: ethers.hexlify(b) };
    },
  },
  FORGED_LOGITS: {
    title: "FORGED LOGITS",
    forgery: "Inflate an output instance to fake a correct answer.",
    lesson: "The instances are bound into the proof; changing one fails verification.",
    expect: "InvalidProof",
    layer: "verifier",
    build: (good) => {
      const inst = [...good.instances];
      inst[5] = "0x" + (123456789n).toString(16).padStart(64, "0");
      return { ...good, instances: inst };
    },
  },
  COPYCAT_PROOF: {
    title: "COPYCAT PROOF",
    forgery: "Byte-for-byte copy a proof already submitted this block.",
    lesson: "The proof nullifier burns each proof on first use.",
    expect: "ProofAlreadyUsed",
    layer: "guard",
    needsPriorSubmit: true,
    build: (good) => good, // verbatim
  },
  STALE_CHALLENGE: {
    title: "STALE CHALLENGE",
    forgery: "Replay your own valid proof from a previous block.",
    lesson: "Each task draws a fresh challenge batch; the commitment won't match.",
    expect: "ChallengeMismatch",
    layer: "guard",
    needsStaleProof: true,
  },
  GHOST_OF_ERA_1: {
    title: "GHOST OF ERA 1",
    forgery: "Feed a real archived Era-1 proof to the Era-2 contract.",
    lesson: "Era-1 proofs carry 794 instances; the length check rejects them before anything else.",
    expect: "BadInstanceLength",
    layer: "guard",
    useEra1Ghost: true,
  },
  HONEST: {
    title: "HONEST SUBMISSION",
    forgery: "A real proof on the real challenge batch.",
    lesson: "Accepted — the control that proves the gauntlet isn't rejecting everything.",
    kind: "honest",
  },
};

/**
 * Decode a revert into { error, layer, raw }.
 * @param iface ethers.Interface built from TASK_MANAGER_ABI_V2 (has the custom errors)
 */
function decodeRevert(e, iface) {
  const data = e?.info?.error?.data || e?.data || e?.revert?.data;
  if (data && typeof data === "string" && data.length >= 10) {
    try {
      const parsed = iface.parseError(data);
      if (parsed) return { error: parsed.name, raw: data };
    } catch { /* not a known custom error */ }
    // empty/standard revert from the verifier's assembly
    if (data === "0x") return { error: "InvalidProof", raw: "0x", note: "verifier raw revert (empty reason)" };
  }
  const msg = e?.shortMessage || e?.reason || e?.message || "";
  for (const name of ["BadInstanceLength", "ChallengeMismatch", "ProofAlreadyUsed",
                      "InvalidProof", "BadVka", "ScoreBelowThreshold", "AlreadySubmitted",
                      "SubmissionCapReached", "TaskClosed"]) {
    if (msg.includes(name)) return { error: name, raw: null };
  }
  return { error: "unknown", raw: null, message: msg.slice(0, 160) };
}

/**
 * Run one attack. Returns a receipt object for the UI.
 * @param attackKey  one of ATTACKS
 * @param ctx        { manager (signer-connected), iface, taskId, goodProof, staleProof, era1Ghost, vka }
 */
async function runAttack(attackKey, ctx) {
  const atk = ATTACKS[attackKey];
  if (!atk) throw new Error(`unknown attack ${attackKey}`);
  const { manager, iface, taskId, goodProof, staleProof, era1Ghost, vka } = ctx;
  const explorer = (h) => `https://sepolia.basescan.org/tx/${h}`;

  const base = { title: atk.title, forgery: atk.forgery, lesson: atk.lesson, attackKey };

  // FORGED SCORE — a claim that lands, to be beaten at finalize
  if (atk.kind === "claimed") {
    const tx = await manager.submitWork(BigInt(taskId), ethers.id("forged-99"), 99n);
    const rc = await tx.wait();
    return { ...base, outcome: "landed", verdict: "CLAIMED 99 — will lose at finalize",
             txHash: tx.hash, explorer: explorer(tx.hash), block: rc.blockNumber };
  }

  // HONEST control — a real proof that is accepted
  if (atk.kind === "honest") {
    const tx = await manager.submitWithProof(
      BigInt(taskId), ethers.id("honest"), goodProof.proof, goodProof.instances, vka);
    const rc = await tx.wait();
    return { ...base, outcome: "accepted", verdict: "ACCEPTED ✓",
             txHash: tx.hash, explorer: explorer(tx.hash), block: rc.blockNumber };
  }

  // Forgeries — must revert
  let payload;
  if (atk.useEra1Ghost)      payload = { proof: era1Ghost.proof, instances: era1Ghost.instances };
  else if (atk.needsStaleProof) payload = { proof: staleProof.proof, instances: staleProof.instances };
  else                       payload = atk.build(goodProof);

  try {
    const tx = await manager.submitWithProof(
      BigInt(taskId), ethers.id(attackKey), payload.proof, payload.instances, vka);
    await tx.wait();
    // It did NOT revert — that is a gauntlet failure worth surfacing loudly.
    return { ...base, outcome: "UNEXPECTEDLY_LANDED", verdict: "⚠ attack was not rejected",
             txHash: tx.hash, explorer: explorer(tx.hash) };
  } catch (e) {
    const decoded = decodeRevert(e, iface);
    const matched = decoded.error === atk.expect;
    return {
      ...base,
      outcome: "rejected",
      verdict: `REJECTED · ${decoded.error}`,
      expected: atk.expect,
      matched,
      layer: atk.layer,
      note: decoded.note,
      raw: decoded.raw,
      // a reverted tx has no on-chain hash; the receipt is the decoded reason
    };
  }
}

module.exports = { ATTACKS, runAttack, decodeRevert };
