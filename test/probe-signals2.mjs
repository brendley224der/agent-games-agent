// vfy-policy signal discovery, round 2: brute-force a wordlist of plausible
// input-signal names through the wasm's getInputSignalSize.
// Semantics established by the gatekeeper control: size >= 1 = input signal,
// size 0 = not an input signal. The found sizes must sum to getInputSize()
// (17) for the set to be complete.
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

const CANDIDATES = [
  // balances
  "balance", "balances", "myBalance", "opponentBalance", "selfBalance",
  "playerBalance", "balance0", "balance1", "balA", "balB", "myBal", "oppBal",
  "exposed", "exposedBalance", "myExposed", "oppExposed", "frozen", "frozenBalance",
  "myExposedBalance", "opponentExposedBalance",
  // identity / position
  "matchId", "match", "gameId", "game", "round", "turn", "turnNumber", "turnNo",
  "turnIndex", "step", "move", "moveNumber", "t", "id", "matchID",
  // action
  "action", "amount", "actionAmount", "actionType", "choice",
  // policy / strategy / commitment
  "policy", "policyId", "policyHash", "policyCommitment", "strategy",
  "strategyId", "strategyCommitment", "commitment", "commitmentHash",
  "strategyHash", "params", "policyParams", "strategyParams", "threshold",
  "extractThreshold", "fortifyThreshold", "cooperateThreshold",
  // hashes / state
  "salt", "publicInputsHash", "inputsHash", "stateHash", "gameState", "state",
  // misc
  "circuitVersion", "version", "decision",
  "prevAction", "opponentAction", "lastAction", "opponentLastAction",
  "previousAction", "oppAction", "lastOppAction",
  "nonce", "expiry", "deadline", "block", "currentBlock",
  // more guesses
  "in", "input", "data", "proof", "witness", "secret", "key", "seed",
  "player", "opponent", "self", "me", "you", "a", "b", "x", "y",
  "balanceA", "balanceB", "bal", "bals", "scores", "score",
  "extract", "fortify", "hold", "cooperate", "defect",
  "policyVersion", "strategyVersion", "commitmentVersion",
  "matchHash", "gameHash", "turnHash", "stateCommitment",
];

const wasm = fs.readFileSync("./circuits/vfy-policy.wasm");
const wc = await WitnessCalculatorBuilder(wasm);
const ex = wc.instance.exports;
const total = ex.getInputSize();
console.log(`vfy-policy getInputSize (total input values): ${total}`);
const found = [];
for (const name of CANDIDATES) {
  const h = fnvHash(name);
  const size = ex.getInputSignalSize(parseInt(h.slice(0, 8), 16), parseInt(h.slice(8, 16), 16));
  if (size >= 1) { console.log(`FOUND ${name} (size ${size})`); found.push([name, size]); }
}
const sum = found.reduce((a, [, s]) => a + s, 0);
console.log(`\nFound ${found.length} input signals, sizes sum to ${sum} / total ${total}.`);
if (sum === total) console.log("COMPLETE: input set fully identified.");
else console.log(`INCOMPLETE: ${total - sum} input value(s) still unaccounted for.`);
