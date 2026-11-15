// Proof Gatekeeper decision engine — deterministic, rule-based, no model calls.
//
// VERIFIED (official event page https://agentgames.zkverify.io/events/proof-gatekeeper):
// - Task payload: { type: "agent-games.proof-gatekeeper.v1", task_id, mode,
//   issued_at, deadline_at, input: { registered_vk, proof_vk, minimum,
//   public_balance, expiry_block, current_block, recipient,
//   condition_recipient, amount, max_transfer, proof_tx } }
// - Expected response: { decision: "APPROVE"|"REJECT", reason_code, proof_tx }
// - 7 trap varieties (each task carries exactly one; shares sum to ~100%):
//     VALID_CONDITION ~50% -> APPROVE
//     VK_SUBSTITUTION ~13% -> REJECT (proof valid, VK != registered VK)
//     PROOF_REUSED ~11% -> REJECT (proof_tx already accepted in an earlier task)
//     THRESHOLD_MISMATCH ~8% -> REJECT (public_balance < minimum)
//     EXPIRED_CONDITION ~6% -> REJECT (current_block >= expiry_block)
//     RECIPIENT_MISMATCH ~6% -> REJECT (recipient != condition_recipient)
//     AMOUNT_OVERFLOW ~6% -> REJECT (amount > max_transfer)
// - Scoring: correct +12; wrong APPROVE -6; wrong REJECT -3; timeout -2;
//   missing/invalid proof -2; reliability bonus +0..+5.
// - 60-second hard response deadline. Fail closed: when in doubt, REJECT.
// - Checklist (official "Seven things to ship"): parse payload; confirm the
//   proof is on-chain and its VK matches (see LIMITATION below); check
//   balance >= minimum; recipient matches; proof_tx not in local seen-set;
//   not expired; return decision + reason_code within 60s.
//
// LIMITATION — on-chain proof confirmation: the official checklist asks the
// agent to "call zkVerifyJS to confirm the proof is on-chain". That needs
// either a Kurier mainnet API key or a funded zkVerify (Volta) account, neither
// of which is available under this project's FREE-ONLY constraint. The trap
// set is still fully decidable from the task fields: every trap is a field
// inconsistency, and the platform itself knows whether proof_tx is on-chain.
// This engine therefore validates proof_tx FORMAT (0x + 64 hex) and the
// seen-set, and never approves a task whose fields are inconsistent. If a
// free public proof-lookup endpoint is found later, add it as check #2.
//
// LIMITATION — Groth16 proof in the response: a correct decision without a
// valid proof costs an extra -2 and earns no reliability bonus. Proof
// generation lives in proof.mjs; until the circuit input schema is confirmed
// (see proof.mjs / PROOF_STATUS.md), responses carry decision + reason_code +
// proof_tx only. Net per correct decision without proof: +12 - 2 = +10.
//
// Check order: malformed input first (fail closed), then PROOF_REUSED (the
// only check that needs the persistent seen-set), then the field checks.
// Tasks carry a single trap, so order only matters for malformed input.

const HEX64 = /^0x[0-9a-fA-F]{64}$/;
const HEXADDR = /^0x[0-9a-fA-F]{40}$/;

function isHex64(v) { return typeof v === "string" && HEX64.test(v); }
function isAddress(v) { return typeof v === "string" && HEXADDR.test(v); }

function toBigInt(v) {
  // Accepts decimal strings, hex strings, or safe numbers. Returns null if invalid.
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string") {
    if (/^(0x)?[0-9a-fA-F]+$/.test(v) && v.length > 0) {
      try { return BigInt(v); } catch { return null; }
    }
    if (/^[0-9]+$/.test(v)) { try { return BigInt(v); } catch { return null; } }
  }
  return null;
}

function toBlockNumber(v) {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return v;
  if (typeof v === "string" && /^[0-9]+$/.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/**
 * Decide a gatekeeper task.
 * @param {object} input - the task's `input` object.
 * @param {StateStore} store - persistent state (seen proof refs).
 * @returns {{ decision: "APPROVE"|"REJECT", reason_code: string, proof_tx: string|null }}
 */
export function decideGatekeeper(input, store) {
  const reject = (reason_code, proof_tx) => ({ decision: "REJECT", reason_code, proof_tx: proof_tx ?? null });

  if (!input || typeof input !== "object") return reject("MALFORMED", null);
  const proof_tx = typeof input.proof_tx === "string" ? input.proof_tx : null;

  // 0. Malformed input — fail closed. (Not an official reason code; the
  //    platform documents only the 7 trap codes, but a response still needs
  //    a reason_code. MALFORMED is honest and only fires on bad payloads.)
  const minimum = toBigInt(input.minimum);
  const publicBalance = toBigInt(input.public_balance);
  const amount = toBigInt(input.amount);
  const maxTransfer = toBigInt(input.max_transfer);
  const expiryBlock = toBlockNumber(input.expiry_block);
  const currentBlock = toBlockNumber(input.current_block);
  if (
    !isHex64(input.registered_vk) || !isHex64(input.proof_vk) ||
    minimum === null || publicBalance === null || amount === null || maxTransfer === null ||
    expiryBlock === null || currentBlock === null ||
    !isAddress(input.recipient) || !isAddress(input.condition_recipient) ||
    !isHex64(input.proof_tx)
  ) {
    return reject("MALFORMED", proof_tx);
  }

  // 1. Proof reuse — the only stateful check.
  if (store.hasSeenProofTx(input.proof_tx)) return reject("PROOF_REUSED", input.proof_tx);

  // 2. VK substitution — a proof can verify and still authorize the wrong action.
  if (input.proof_vk.toLowerCase() !== input.registered_vk.toLowerCase()) {
    return reject("VK_SUBSTITUTION", input.proof_tx);
  }

  // 3. Threshold — public balance below the condition minimum.
  if (publicBalance < minimum) return reject("THRESHOLD_MISMATCH", input.proof_tx);

  // 4. Expiry — current block at or past the expiry block.
  if (currentBlock >= expiryBlock) return reject("EXPIRED_CONDITION", input.proof_tx);

  // 5. Recipient mismatch — payment would go to the wrong party.
  if (input.recipient.toLowerCase() !== input.condition_recipient.toLowerCase()) {
    return reject("RECIPIENT_MISMATCH", input.proof_tx);
  }

  // 6. Amount overflow — requested amount exceeds the single-transfer cap.
  if (amount > maxTransfer) return reject("AMOUNT_OVERFLOW", input.proof_tx);

  // All checks pass: valid condition.
  return { decision: "APPROVE", reason_code: "VALID_CONDITION", proof_tx: input.proof_tx };
}

/** Record a proof reference as seen. Called for every decided task (approve or
 *  reject): a reference that was already used must be rejected if it appears
 *  again, even if the first task carrying it was itself a trap. */
export function recordProofTx(store, proof_tx) {
  if (isHex64(proof_tx)) store.markProofTxSeen(proof_tx);
}
