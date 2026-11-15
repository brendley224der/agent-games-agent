import * as snarkjs from "snarkjs";
console.log("snarkjs loaded");
const input = {
  registeredVkHash: "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0",
  proofVkHash: "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0",
  minimum: "1000", publicBalance: "1460", expiryBlock: 19842201, currentBlock: 19832000,
  recipient: "0xDe42000000000000000000000000000000009f01",
  conditionRecipient: "0xDe42000000000000000000000000000000009f01",
  amount: "500", maxTransfer: "1000", decision: 1, taskId: 24, salt: 987654321,
};
console.log("calling fullProve...");
const t0 = Date.now();
const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, "./circuits/gatekeeper.wasm", "./circuits/gatekeeper_final.zkey");
console.log(`fullProve done in ${Date.now() - t0}ms, publicSignals=${JSON.stringify(publicSignals)}`);
import fs from "node:fs";
const vk = JSON.parse(fs.readFileSync("./circuits/gatekeeper-vk.json", "utf8"));
console.log("verify:", await snarkjs.groth16.verify(vk, publicSignals, proof));
