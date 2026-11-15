// Probe: discover the gatekeeper circuit's input signal names by trial.
// Uses snarkjs groth16.fullProve (witness + prove in one call). Candidate names
// are leads from two published participant accounts — UNVERIFIED until a proof
// verifies locally against the exported VK.
const snarkjs = require("snarkjs");
const fs = require("fs");

const WASM = "./circuits/gatekeeper.wasm";
const ZKEY = "./circuits/gatekeeper_final.zkey";
const VK = JSON.parse(fs.readFileSync("/tmp/gk-vk.json", "utf8"));

const VK_HASH = "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";
const ADDR = "0xDe42000000000000000000000000000000009f01";

async function attempt(name, input) {
  try {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
    console.log(`[${name}] proof generated, publicSignals=${JSON.stringify(publicSignals)}`);
    const ok = await snarkjs.groth16.verify(VK, publicSignals, proof);
    console.log(`[${name}] groth16 verify: ${ok ? "OK *** CONFIRMED ***" : "FAIL"}`);
    if (ok) {
      fs.writeFileSync(`/tmp/gk-proof-${name}.json`, JSON.stringify({ proof, publicSignals }, null, 2));
    }
    return ok;
  } catch (e) {
    console.log(`[${name}] FAILED: ${String(e && e.message ? e.message : e).slice(0, 600)}`);
    return false;
  }
}

(async () => {
  await attempt("empty", {});
  await attempt("cand1", {
    registeredVkHash: VK_HASH,
    proofVkHash: VK_HASH,
    minimum: "1000",
    publicBalance: "1460",
    expiryBlock: 19842201,
    currentBlock: 19832000,
    recipient: ADDR,
    conditionRecipient: ADDR,
    amount: "500",
    maxTransfer: "1000",
    decision: 1,
    taskId: 24,
    salt: 987654321,
  });
})();
