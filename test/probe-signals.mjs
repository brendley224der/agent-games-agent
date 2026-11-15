// Signal discovery: ask each circuit's wasm which input-signal names exist.
// The wasm exports getInputSignalSize(fnvHash(name)) -> size (>=0) or -1.
// This resolves the "unknown input schema" problem without the .sym file.
// Gatekeeper names are tested as a control (all 13 must be FOUND, size 1).
import { WitnessCalculatorBuilder } from "circom_runtime";
import fs from "node:fs";

function fnvHash(str) {
  const uint64_max = BigInt(2) ** BigInt(64);
  let hash = BigInt("0xCBF29CE484222325");
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str[i].charCodeAt(0));
    hash *= BigInt(0x100000001B3);
    hash %= uint64_max;
  }
  let shash = hash.toString(16);
  shash = "0".repeat(16 - shash.length).concat(shash);
  return shash;
}

async function discover(wasmPath, candidates) {
  const wasm = fs.readFileSync(wasmPath);
  const wc = await WitnessCalculatorBuilder(wasm);
  const ex = wc.instance.exports;
  console.log(`\n=== ${wasmPath} ===`);
  console.log(`getInputSize (total input values): ${ex.getInputSize()}, witnessSize: ${ex.getWitnessSize()}`);
  const found = [];
  for (const name of candidates) {
    const h = fnvHash(name);
    const size = ex.getInputSignalSize(parseInt(h.slice(0, 8), 16), parseInt(h.slice(8, 16), 16));
    if (size >= 0) { console.log(`  FOUND  ${name} (size ${size})`); found.push([name, size]); }
    else { console.log(`  -      ${name}`); }
  }
  console.log(`Found ${found.length}/${candidates.length}: ${found.map(([n, s]) => `${n}:${s}`).join(", ")}`);
  return found;
}

await discover("./circuits/gatekeeper.wasm", [
  "registeredVkHash", "proofVkHash", "minimum", "publicBalance", "expiryBlock",
  "currentBlock", "recipient", "conditionRecipient", "amount", "maxTransfer",
  "decision", "taskId", "salt", "commitment",
]);

await discover("./circuits/vfy-policy.wasm", [
  "strategyCommitment", "commitment", "commitmentHash", "policyCommitment",
  "policyHash", "policy", "policyId", "strategy", "strategyId",
  "matchId", "matchID", "match", "gameId", "round",
  "turn", "myBalance", "opponentBalance", "balances",
  "myExposedBalance", "opponentExposedBalance", "exposedBalance",
  "action", "actionAmount", "amount",
  "salt", "publicInputsHash", "inputsHash",
  "prevAction", "opponentLastAction", "lastAction", "opponentAction",
  "fortifyCost", "extractCap", "cap", "cost",
  "circuitVersion", "version", "decision",
]);
