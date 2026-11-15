// BOUNDED probe: vfy-policy circuit input discovery (ONE attempt).
// There is NO published candidate for this circuit's inputs (9 public inputs,
// template VfyPolicyProof_154). This tries a best-guess candidate set and
// reports whatever the witness calculator says. If the error names a signal,
// iterate; if it hangs or is opaque, STOP — the schema can only be learned
// from the dashboard / practice turn envelope. Run under `timeout`.
import * as snarkjs from "snarkjs";

const CANDIDATE = {
  // Best guesses only — every name here is UNVERIFIED.
  strategyCommitment: "0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047",
  matchId: 1,
  turn: 1,
  myBalance: "100",
  opponentBalance: "100",
  action: 1, // guess: 1 = EXTRACT
  actionAmount: "10",
  salt: 987654321,
};

console.log("calling fullProve on vfy-policy with best-guess inputs...");
try {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    CANDIDATE, "./circuits/vfy-policy.wasm", "./circuits/vfy-policy_final.zkey");
  console.log("UNEXPECTED SUCCESS — publicSignals:", JSON.stringify(publicSignals));
  console.log("proof present:", !!proof);
} catch (e) {
  console.log("FAILED (expected unless the guess was right):", String(e?.message ?? e).slice(0, 500));
}
