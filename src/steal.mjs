// Steal the VFY turn handler — deterministic, rule-based, no model calls.
//
// VERIFIED (official pages https://agentgames.zkverify.io/events/steal-the-vfy
// and https://agentgames.zkverify.io/build):
// - 20 turns per match, 100 VFY starting balance each, highest balance wins.
// - 3 actions: FORTIFY (small fixed cost, protects part of balance for the
//   next resolution), EXTRACT (free, takes a bounded amount from the
//   opponent's exposed balance), HOLD (free, no movement).
// - Simultaneous submission, deterministic resolver on prior public state.
//   EXTRACT/HOLD: extractor takes up to the cap. EXTRACT/FORTIFY: defence
//   reduces/blocks extraction; defender pays the fortify cost. EXTRACT/EXTRACT:
//   both resolve against prior exposed balances simultaneously.
// - Turn deadline 5 min; platform waits ~30 s per push. Miss -> HOLD
//   substituted, -1 timeout penalty. Submitted-but-invalid proof: -2/turn.
// - Scoring: match win +18, draw +9, loss +3, verified-turn reliability
//   bonus +0..+2. 5 Swiss rounds -> Top 16 knockout. Schedule 13-17 Nov 2026.
// - Response: echo matchId and turn, declare the action, attach the policy
//   proof (circuitVersion + Groth16 proof + public_signals). proofReference
//   and publicInputsHash are optional audit pointers. A missing/mismatched
//   required field is treated as HOLD with no proof.
// - action.amount must be OMITTED entirely for HOLD/FORTIFY (the schema
//   rejects the field even when 0). Fresh idempotencyKey per turn.
// - Strategy must be committed before Swiss Round 1; commitment frozen
//   mid-match. Every move needs a policy proof that the committed strategy
//   allows it. The platform independently computes the public-inputs hash
//   from the game state and rejects divergent proofs.
//
// NOT PUBLISHED (unknown until dashboard/practice mode reveals them):
// - Exact incoming turn-envelope field names (only described semantically:
//   "both balances, your frozen commitment hash, and the deadline"). This
//   handler parses defensively (camelCase + snake_case variants).
// - The EXTRACT cap and the FORTIFY cost (only "bounded" / "small fixed cost").
//   The handler reads them from the envelope when present, else uses the
//   documented defaults below (tune after the first practice turn).
// - The circuitVersion string for the registered strategy commitment.
// - The vfy-policy circuit input schema (9 public inputs, template
//   VfyPolicyProof_154 — see proof.mjs).
//
// COMMITTED POLICY "axvenoir-v1" (deterministic, state-dependent):
//   1. Turn 1: EXTRACT.
//   2. If my balance > opponent balance AND the opponent EXTRACTed on the
//      previous turn -> FORTIFY (protect a lead under attack).
//   3. Otherwise -> EXTRACT.
// Rationale: EXTRACT is free and weakly dominates HOLD in every pairing
// (vs HOLD it gains, vs FORTIFY it gains a reduced amount, vs EXTRACT it
// keeps parity), so HOLD is never played. FORTIFY is only worth its cost
// when it protects an existing lead against an opponent who is actively
// extracting. The policy depends only on public game state (both balances +
// opponent's previous action), so it is committable and provable in-circuit.

export const POLICY_ID = "axvenoir-v1";
export const DEFAULT_EXTRACT_AMOUNT = 10; // 10% of the 100 starting balance; tune once the cap is known.
export const DEFAULT_FORTIFY_MIN_LEAD = 1; // fortify whenever ahead by >= this, if under attack.

function num(v, fallback = null) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return fallback;
}

function pick(obj, ...keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) if (obj[k] !== undefined) return obj[k];
  return undefined;
}

/** Extract the game state from a turn envelope, tolerating field-name variants. */
export function parseTurnEnvelope(body) {
  const env = body ?? {};
  const state = pick(env, "state", "gameState", "game_state") ?? env;
  const balances = pick(state, "balances") ?? pick(env, "balances") ?? {};
  const myBalance = num(pick(state, "myBalance", "my_balance", "balance", "selfBalance", "yourBalance")) ??
    num(pick(balances, "mine", "my", "self", "you", "player")) ?? null;
  const oppBalance = num(pick(state, "opponentBalance", "opponent_balance", "oppBalance", "opponent")) ??
    num(pick(balances, "opponent", "opp", "rival", "enemy")) ?? null;
  const history = pick(state, "history", "turns", "previousTurns") ?? pick(env, "history") ?? null;
  let opponentLastAction = pick(state, "opponentLastAction", "opponent_last_action", "lastOpponentAction") ??
    pick(env, "opponentLastAction") ?? null;
  if (!opponentLastAction && Array.isArray(history) && history.length > 0) {
    const last = history[history.length - 1];
    opponentLastAction = pick(last, "opponentAction", "opponent_action", "action") ?? last?.opponent ?? null;
    if (opponentLastAction && typeof opponentLastAction === "object") {
      opponentLastAction = opponentLastAction.type ?? opponentLastAction.action ?? null;
    }
  }
  return {
    matchId: pick(env, "matchId", "match_id", "matchID") ?? pick(state, "matchId", "match_id") ?? null,
    turn: num(pick(env, "turn"), null),
    myBalance,
    oppBalance,
    opponentLastAction: typeof opponentLastAction === "string" ? opponentLastAction.toUpperCase() : null,
    commitmentHash: pick(env, "commitmentHash", "commitment_hash", "commitment") ?? pick(state, "commitmentHash", "commitment_hash") ?? null,
    deadline: pick(env, "deadline", "deadline_at", "deadlineAt") ?? pick(state, "deadline", "deadline_at") ?? null,
    idempotencyKey: pick(env, "idempotencyKey", "idempotency_key") ?? null,
    circuitVersion: pick(env, "circuitVersion", "circuit_version") ?? null,
    extractCap: num(pick(env, "extractCap", "extract_cap", "maxExtract", "cap")) ?? num(pick(state, "extractCap", "extract_cap", "maxExtract", "cap")) ?? null,
    fortifyCost: num(pick(env, "fortifyCost", "fortify_cost")) ?? num(pick(state, "fortifyCost", "fortify_cost")) ?? null,
    raw: env,
  };
}

/**
 * The committed policy. Pure function of the parsed envelope (+ locally
 * tracked opponent last action when the envelope omits history).
 * Returns { type: "EXTRACT"|"FORTIFY"|"HOLD", amount?: number }.
 */
export function decideSteal(parsed, opponentLastActionOverride = null, opts = {}) {
  const extractAmount = opts.extractAmount ?? parsed.extractCap ?? DEFAULT_EXTRACT_AMOUNT;
  const minLead = opts.fortifyMinLead ?? DEFAULT_FORTIFY_MIN_LEAD;
  const oppLast = (opponentLastActionOverride ?? parsed.opponentLastAction ?? null);
  const turn = parsed.turn ?? 1;
  const my = parsed.myBalance;
  const opp = parsed.oppBalance;

  // Rule 2: protect a lead under attack.
  if (turn > 1 && my !== null && opp !== null && my - opp >= minLead && oppLast === "EXTRACT") {
    return { type: "FORTIFY" }; // NOTE: no amount field — schema rejects it even as 0.
  }
  // Rule 1 & 3: extract (turn 1, or ahead-but-not-attacked, or behind, or tied).
  return { type: "EXTRACT", amount: extractAmount };
}

/** Build the platform response for a turn. Proof fields are attached by the
 *  caller (server.mjs) when a valid policy proof was produced. */
export function buildStealResponse(parsed, action, idempotencyKey, proof = null) {
  const response = {
    matchId: parsed.matchId,
    turn: parsed.turn,
    action: action.type === "EXTRACT" ? { type: "EXTRACT", amount: action.amount } : { type: action.type },
    idempotencyKey,
  };
  if (proof) {
    if (proof.circuitVersion) response.circuitVersion = proof.circuitVersion;
    if (proof.proof) response.proof = proof.proof;
    if (proof.publicSignals) response.public_signals = proof.publicSignals;
    if (proof.publicInputsHash) response.publicInputsHash = proof.publicInputsHash;
    if (proof.proofReference) response.proofReference = proof.proofReference;
  }
  return response;
}
