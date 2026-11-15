// BOUNDED vfy-policy fullProve probe (round 2).
// Input set is CONFIRMED (see probe-signals2.mjs): commitment, matchId,
// turnNumber, selfBalance, opponentBalance, action, amount, strategyParams[8],
// salt, circuitVersion — 17 values total.
// This tries 3 commitment recipes and reports the first failing assert for
// each. The assert messages reveal what the circuit enforces and in what
// order. STOP after these attempts and document; the strategyParams semantics
// (what the 8 numbers mean) still need the dashboard / practice envelope.
import * as snarkjs from "snarkjs";
import { buildPoseidon } from "circomlibjs";

const poseidon = await buildPoseidon();
const F = poseidon.F;
const P = (arr) => F.toObject(poseidon(arr.map((x) => BigInt(x)))).toString();

const SALT = 987654321;
const PARAMS = [0, 0, 0, 0, 0, 0, 0, 0];

function base(commitment) {
  return {
    commitment: commitment.toString(),
    matchId: 1,
    turnNumber: 1,
    selfBalance: "100",
    opponentBalance: "100",
    action: 1, // guess: 1 = EXTRACT
    amount: "10",
    strategyParams: PARAMS,
    salt: SALT,
    circuitVersion: 1,
  };
}

const attempts = [
  ["A: commitment=1 (baseline)", "1"],
  ["B: commitment=Poseidon([salt, ...params])", P([SALT, ...PARAMS])],
  ["C: commitment=Poseidon([...params])", P(PARAMS)],
];

const vk = JSON.parse((await import("node:fs")).readFileSync("./circuits/vfy-policy-vk.json", "utf8"));
for (const [label, commitment] of attempts) {
  console.log(`\n--- ${label} ---`);
  console.log(`commitment = ${commitment}`);
  try {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      base(commitment), "./circuits/vfy-policy.wasm", "./circuits/vfy-policy_final.zkey");
    console.log("SUCCESS — publicSignals:", JSON.stringify(publicSignals));
    const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
    console.log("local verify:", ok);
  } catch (e) {
    console.log("FAILED:", String(e?.message ?? e).split("\n").slice(0, 4).join(" | "));
  }
}
