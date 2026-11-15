// BOUNDED vfy-policy diagnostic sweep (round 3, final).
// All commitment recipes fail at VfyPolicyProof_154 line 72. Vary ONE input
// at a time (with commitment=1) to see whether any variant passes line 72
// or fails at a DIFFERENT line — that localizes what line 72 checks.
// After this, STOP: the commitment recipe + strategyParams semantics need
// the dashboard / practice turn envelope.
import * as snarkjs from "snarkjs";

function base(overrides = {}) {
  return {
    commitment: "1",
    matchId: 1,
    turnNumber: 1,
    selfBalance: "100",
    opponentBalance: "100",
    action: 1,
    amount: "10",
    strategyParams: [0, 0, 0, 0, 0, 0, 0, 0],
    salt: 987654321,
    circuitVersion: 1,
    ...overrides,
  };
}

const variants = [
  ["baseline (action=1 EXTRACT, amount=10)", {}],
  ["action=0 HOLD, amount=0", { action: 0, amount: "0" }],
  ["action=2 FORTIFY, amount=0", { action: 2, amount: "0" }],
  ["action=3 (out of range?)", { action: 3 }],
  ["circuitVersion=0", { circuitVersion: 0 }],
  ["turnNumber=0", { turnNumber: 0 }],
  ["selfBalance=0", { selfBalance: "0" }],
  ["amount=0 with action=1", { amount: "0" }],
];

for (const [label, overrides] of variants) {
  try {
    const { publicSignals } = await snarkjs.groth16.fullProve(
      base(overrides), "./circuits/vfy-policy.wasm", "./circuits/vfy-policy_final.zkey");
    console.log(`${label} -> SUCCESS publicSignals=${JSON.stringify(publicSignals)}`);
  } catch (e) {
    const msg = String(e?.message ?? e);
    const line = msg.match(/line: \d+/)?.[0] ?? msg.split("\n")[0].slice(0, 80);
    console.log(`${label} -> FAILED at ${line}`);
  }
}
