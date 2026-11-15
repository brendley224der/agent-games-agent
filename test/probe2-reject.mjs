import * as snarkjs from "snarkjs";
import fs from "node:fs";
const vk = JSON.parse(fs.readFileSync("./circuits/gatekeeper-vk.json", "utf8"));
const VK = "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";
const VK2 = "0xa4c1c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";
const ADDR = "0xDe42000000000000000000000000000000009f01";
const base = {
  registeredVkHash: VK, proofVkHash: VK, minimum: "1000", publicBalance: "1460",
  expiryBlock: 19842201, currentBlock: 19832000, recipient: ADDR, conditionRecipient: ADDR,
  amount: "500", maxTransfer: "1000", decision: 1, taskId: 24, salt: 987654321,
};
async function attempt(name, input) {
  try {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, "./circuits/gatekeeper.wasm", "./circuits/gatekeeper_final.zkey");
    const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
    console.log(`[${name}] prove OK, local verify: ${ok}`);
  } catch (e) {
    console.log(`[${name}] FAILED: ${String(e?.message ?? e).slice(0, 300)}`);
  }
}
// Trap scenario (VK substitution) with REJECT decision (0): should verify.
await attempt("trap-vkMismatch-decision0", { ...base, proofVkHash: VK2, decision: 0 });
// Same trap with APPROVE decision (1): should FAIL (wrong decision for the inputs).
await attempt("trap-vkMismatch-decision1", { ...base, proofVkHash: VK2, decision: 1 });
// Valid scenario with REJECT decision (0): should FAIL.
await attempt("valid-decision0", { ...base, decision: 0 });
// Threshold trap with decision 0: should verify.
await attempt("trap-threshold-decision0", { ...base, publicBalance: "500", decision: 0 });
