// Groth16 proof generation (OPTIONAL, OFF BY DEFAULT).
//
// STATUS — GATEKEEPER SCHEMA CONFIRMED 2026-11-15 (see PROOF_STATUS.md):
// The gatekeeper circuit input schema was verified end to end on this VM:
// witness -> groth16.fullProve -> groth16.verify against the exported VK.
//   - Inputs: the 12 task fields + a private salt (987654321).
//   - decision: 1 = APPROVE, 0 = REJECT (confirmed BOTH ways: a trap task
//     with decision 1 and a valid task with decision 0 both fail the circuit
//     assert at GatekeeperEvaluation_79 line 102; the correct decisions verify).
//   - taskId: the number inside "gk_<n>_<suffix>" (e.g. "gk_24_9d1" -> 24).
//   - commitment (public signal 0) is computed inside the circuit as
//     Poseidon([salt, taskId]) — the public signal for salt 987654321,
//     taskId 24 equals the published Poseidon test value.
//   - Public signals (13, in order): commitment, registeredVkHash,
//     proofVkHash, minimum, publicBalance, expiryBlock, currentBlock,
//     recipient, conditionRecipient, amount, maxTransfer, decision, taskId.
//   - fullProve takes ~1 s on this VM.
// The vfy-policy INPUT SET is CONFIRMED (2026-11-15, via wasm
// getInputSignalSize probing — see test/probe-signals2.mjs): commitment,
// matchId, turnNumber, selfBalance, opponentBalance, action, amount,
// strategyParams[8], salt, circuitVersion (17 values). What is STILL UNKNOWN:
// the commitment recipe, the strategyParams semantics, the action/matchId
// encodings, the circuitVersion value, and the 9 public signals' order.
// proveSteal() returns an error until those are confirmed from the practice
// turn envelope — a proof attesting the wrong statement is worse than none.
//
// REMAINING RISK — response field names: the gatekeeper event page's expected
// response shows only decision/reason_code/proof_tx. The proof is attached as
// `proof` + `public_signals` (matching the Steal page's wording), but those
// field names are UNCONFIRMED until the signed preflight / first practice
// task shows the real envelope. That is why proofs stay OFF by default: set
// AGENT_GAMES_ENABLE_PROOFS=1 only after practice confirms the field names.
//
// SAFETY RULE (enforced by this module + server.mjs):
//   1. Proofs are DISABLED unless AGENT_GAMES_ENABLE_PROOFS=1.
//   2. A generated proof is returned ONLY if it verifies locally against the
//      exported verification key AND its public signals match the task.
//   3. If proof generation fails, times out, or fails local verification, the
//      server answers decision-only (gatekeeper: +12 -2 per correct decision;
//      steal: the action degrades to HOLD — see README.md for the cost).
// NEVER enable proofs in production on an unverified schema: a proof that
// attests the wrong statement is worse than no proof.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CIRCUITS = path.join(HERE, "..", "circuits");

let snarkjsPromise = null;
function loadSnarkjs() {
  if (!snarkjsPromise) {
    snarkjsPromise = import("snarkjs").catch(() => null);
  }
  return snarkjsPromise;
}

function readVk(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(CIRCUITS, `${name}-vk.json`), "utf8"));
  } catch {
    return null;
  }
}

// Gatekeeper input schema — CONFIRMED 2026-11-15 (see header + PROOF_STATUS.md).
// The circuit's INPUT signals are the 12 task fields + a private salt;
// `commitment` is a PUBLIC signal the circuit computes itself as
// Poseidon([salt, taskId]).
export const GATEKEEPER_CANDIDATE_INPUTS = [
  "registeredVkHash", "proofVkHash", "minimum", "publicBalance",
  "expiryBlock", "currentBlock", "recipient", "conditionRecipient",
  "amount", "maxTransfer", "decision", "taskId", "salt",
];

function taskIdNumber(taskId) {
  // "gk_24_9d1" -> 24. Fallback: 0 (documented guess).
  const m = /^gk_(\d+)_/.exec(String(taskId ?? ""));
  return m ? Number(m[1]) : 0;
}

/**
 * Attempt a gatekeeper proof. Returns { proof, publicSignals, circuitVersion }
 * on success, or { error } on any failure. NEVER throws.
 * @param {object} task - the gatekeeper task (type/task_id/input).
 * @param {string} decision - "APPROVE" | "REJECT".
 * @param {object} opts - { timeoutMs, salt, decisionApproveValue }.
 */
export async function proveGatekeeper(task, decision, opts = {}) {
  const snarkjs = await loadSnarkjs();
  if (!snarkjs) return { error: "snarkjs not installed" };
  const vk = readVk("gatekeeper");
  if (!vk) return { error: "gatekeeper VK not exported (run: snarkjs zkey export verificationkey circuits/gatekeeper_final.zkey circuits/gatekeeper-vk.json)" };
  const input = task?.input ?? {};
  const approveValue = opts.decisionApproveValue ?? 1; // CONFIRMED: 1 = APPROVE, 0 = REJECT (verified both ways, see PROOF_STATUS.md).
  const decisionValue = decision === "APPROVE" ? approveValue : 1 - approveValue;
  const candidate = {
    registeredVkHash: input.registered_vk,
    proofVkHash: input.proof_vk,
    minimum: String(input.minimum ?? ""),
    publicBalance: String(input.public_balance ?? ""),
    expiryBlock: input.expiry_block,
    currentBlock: input.current_block,
    recipient: input.recipient,
    conditionRecipient: input.condition_recipient,
    amount: String(input.amount ?? ""),
    maxTransfer: String(input.max_transfer ?? ""),
    decision: decisionValue,
    taskId: taskIdNumber(task?.task_id),
    salt: opts.salt ?? 987654321, // Salt for the commitment Poseidon([salt, taskId]). Value from the published Poseidon test vector; any fixed salt works as long as it is consistent — the platform re-verifies the proof, and the commitment binds the decision to this task. (The taskId number is what binds it to the task; the salt only needs to be fixed per agent.)
  };
  const timeoutMs = opts.timeoutMs ?? 30000;
  try {
    const { proof, publicSignals } = await withTimeout(
      snarkjs.groth16.fullProve(candidate, path.join(CIRCUITS, "gatekeeper.wasm"), path.join(CIRCUITS, "gatekeeper_final.zkey")),
      timeoutMs, "gatekeeper fullProve timed out");
    const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
    if (!ok) return { error: "generated proof FAILED local verification (schema mismatch — see README.md)" };
    return { proof, publicSignals };
  } catch (e) {
    return { error: `gatekeeper proof failed: ${String(e?.message ?? e).slice(0, 300)}` };
  }
}

/**
 * Attempt a Steal-the-VFY policy proof. Currently ALWAYS returns an error:
 * the vfy-policy input set is CONFIRMED (commitment, matchId, turnNumber,
 * selfBalance, opponentBalance, action, amount, strategyParams[8], salt,
 * circuitVersion) but the commitment recipe and strategyParams semantics are
 * still unknown — see PROOF_STATUS.md. Until they are confirmed from the
 * practice turn envelope, proveSteal() returns an error (the agent then
 * answers without a proof and the action degrades to HOLD).
 */
export async function proveSteal(/* parsedTurn, action, opts */) {
  return { error: "vfy-policy commitment recipe unknown (input set confirmed: commitment, matchId, turnNumber, selfBalance, opponentBalance, action, amount, strategyParams[8], salt, circuitVersion — see PROOF_STATUS.md); actions degrade to HOLD without a proof" };
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}
