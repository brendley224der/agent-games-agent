# Groth16 proof status — what is known, what is not, and how to finish it

Date: 2026-11-15. All work done locally on this VM; nothing submitted anywhere.

## Why proofs matter

- **Proof Gatekeeper:** a correct decision without a valid proof costs an extra
  −2 and earns no reliability bonus (+0..+5). Net per correct decision: +10
  without proof, +12 + bonus share with proof. Decisions alone still score.
- **Steal the VFY:** a missing/mismatched required field (including the policy
  proof) degrades the action to HOLD with no proof. Without proofs the agent
  can only HOLD every turn while the opponent extracts against it — effectively
  unplayable. The policy proof is load-bearing here.

## Verified locally (2026-11-15)

- Circuit artifacts downloaded from `agentgames.zkverify.io/circuits`:
  - `gatekeeper.wasm` 1,755,820 B, sha256 `be00aefe…92764f`
  - `gatekeeper_final.zkey` 309,750 B, sha256 `adfe95a4…f80d`
  - `vfy-policy.wasm` 2,991,212 B, sha256 `bc099825…060b134d2`
  - `vfy-policy_final.zkey` 810,586 B, sha256 `f9666a16…ce41`
  Sizes match the figures published by other participants.
- `snarkjs@0.7.6` installed (npm, free). VKs exported:
  - gatekeeper: curve bn128, protocol groth16, **nPublic 13**,
    vkHash `0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`
    (matches `/api/circuit-info`).
  - vfy-policy: curve bn128, protocol groth16, **nPublic 9**,
    vkHash `0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047`.
- Wasm binaries contain NO signal names (strings probe) — only template names:
  - gatekeeper main template `GatekeeperEvaluation_79`, with `PoseidonEx_69`,
    `LessEqThan_77`, `GreaterThan_76`, `GreaterEqThan_75`, `AND_78`.
  - vfy-policy main template `VfyPolicyProof_154`, with `PoseidonEx_72`,
    `PoseidonEx_152`, `LessEqThan_77`, `GreaterThan_80`, `GreaterEqThan_76`,
    `AND_82`. Two Poseidon gadgets — consistent with a commitment hash plus a
    public-inputs hash.
- `circuits/gatekeeper-vk.json` and `circuits/vfy-policy-vk.json` are the
  exported verification keys (public data, safe to commit).

## Gatekeeper schema — CONFIRMED 2026-11-15

Verified end to end on this VM (witness → `groth16.fullProve` →
`groth16.verify` against the exported VK, ~1 s per proof):

- **Inputs:** the 12 task fields + a private salt (987654321).
- **decision:** 1 = APPROVE, 0 = REJECT — confirmed BOTH ways:
  - Valid scenario (balance 1460 ≥ minimum 1000, amount 500 ≤ cap 1000, VKs
    equal, recipient matches, not expired) with decision 1 → proof generated,
    **local verify: true**.
  - VK-substitution trap with decision 0 → verify true; the same trap with
    decision 1 → FAILS the circuit assert (GatekeeperEvaluation_79 line 102).
  - Valid scenario with decision 0 → FAILS the same assert.
  - Threshold trap with decision 0 → verify true.
  So the circuit enforces decision == evaluation result.
- **taskId:** the number inside `gk_<n>_<suffix>` (e.g. `gk_24_9d1` → 24).
- **commitment** (public signal 0) is computed inside the circuit as
  Poseidon([salt, taskId]). For salt 987654321, taskId 24 the public signal is
  `4538591768452999874275481926009620849813943225939850916630922448132760538048`
  — its first 63 digits match the Poseidon test value published by Medium
  `@saifulsidik801` (`Poseidon([987654321, 24])`); the full 76-digit field
  element is the confirmed value.
- **Public signals (13, in order):** commitment, registeredVkHash, proofVkHash,
  minimum, publicBalance, expiryBlock, currentBlock, recipient,
  conditionRecipient, amount, maxTransfer, decision, taskId. All 13 match the
  task fields in the confirming run.
- Any fixed salt works for proof validity (the platform cannot recompute the
  commitment without the salt); the taskId number is what binds the proof to
  the task.

The two published participant accounts are consistent with this result
(Medium `@saifulsidik801`: the 13 public signals in the order above; Dicky
Can: the 13 input signal names = 12 fields + salt).

Probe scripts: `test/probe2.mjs` (the confirming run), `test/probe2-reject.mjs`
(the four decision-encoding runs), `test/probe-gatekeeper.js` (first probe —
NOTE: its empty-input attempt HANGS; the witness calculation with missing
inputs never returns on this VM, the process had to be killed after ~7 min.
Always pass a complete input object).
`test/run-tests.mjs` section 8 covers proofs end to end through the real
server (proofs-enabled instance).

## vfy-policy schema — INPUT SET CONFIRMED, commitment recipe still unknown

Discovered 2026-11-15 by probing the wasm's `getInputSignalSize` export
(FNV-1a hash of each candidate name; size ≥ 1 = input signal — the method was
validated against the gatekeeper control, where all 13 confirmed inputs
returned size 1 and `commitment` returned 0). Scripts:
`test/probe-signals.mjs`, `test/probe-signals2.mjs`.

- **Inputs (10 signals, sizes sum to 17 = `getInputSize()`):**
  commitment (1), matchId (1), turnNumber (1), selfBalance (1),
  opponentBalance (1), action (1), amount (1), strategyParams (8 — an array
  of 8 field elements), salt (1), circuitVersion (1).
- **Public signals:** 9 (nPublic 9). Which 9 and in what order is UNKNOWN.
  Likely candidates: the 8 scalar inputs except salt + one computed hash
  (the circuit has two Poseidon gadgets — one for the commitment, one
  probably for a public-inputs hash).
- **Still unknown:** the commitment recipe (which Poseidon inputs, in what
  order), what the 8 `strategyParams` values mean, the `action` encoding,
  the `matchId` encoding, the `circuitVersion` value, and the public-signal
  order. These can only be learned from the dashboard / practice turn
  envelope (which shows the real matchId, turn, balances, and the committed
  policy the platform expects).
- **Diagnostic (test/probe-vfy2.mjs, probe-vfy3.mjs):** three commitment
  recipes tried (commitment=1; Poseidon([salt, ...params]);
  Poseidon([...params])) and 8 one-input variants (action 0/2/3, amount 0,
  circuitVersion 0, turnNumber 0, selfBalance 0) — ALL fail at the same
  first assert, `VfyPolicyProof_154 line: 72`, regardless of the other
  inputs. Line 72 is most plausibly the commitment/strategy consistency
  check. Do NOT keep guessing recipes blindly; get the real envelope first.
- Until the recipe is confirmed, `proveSteal()` returns an error and Steal
  turns are answered without a proof (actions degrade to HOLD — see
  README.md).

## Open sub-questions (remaining)

- vfy-policy: commitment recipe, strategyParams semantics, action/matchId
  encodings, circuitVersion value, public-signal order (see above).
- Response field names for proofs: the gatekeeper event page shows only
  decision/reason_code/proof_tx; the Steal page says "proof and
  public_signals". This server attaches `proof` + `public_signals` when
  proofs are enabled — confirm via the signed preflight / first practice task
  before enabling proofs in production.
- HMAC digest encoding (assumed lowercase hex; verifier also accepts
  `sha256=`-prefixed and base64) — confirm the same way.
- Exact Steal turn-envelope field names — confirm from the first practice turn.
- EXTRACT cap + FORTIFY cost — read from the envelope when present.
- `circuitVersion` value for Steal — from the dashboard at registration.

## How to finish (checklist)

1. ~~Confirm the gatekeeper schema~~ — DONE 2026-11-15.
2. Confirm the vfy-policy commitment recipe + strategyParams semantics
   (input set identified; needs the dashboard / practice turn envelope).
3. Confirm the response field names for proofs + HMAC encoding via the signed
   preflight / first practice task.
4. Only then set `AGENT_GAMES_ENABLE_PROOFS=1` in production.
5. Re-run `npm test` after any proof change.

## Safety rule (enforced)

`src/proof.mjs` never returns a proof that did not verify locally against the
exported VK, and proofs are OFF by default. A proof attesting the wrong
statement is worse than no proof.
