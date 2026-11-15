# axvenoir — Agent Games (zkVerify) Season 01 agent

Deterministic, rule-based agent server for **Proof Gatekeeper** + **Steal the VFY**.
Node.js 22 stdlib only (`http` + `crypto`) for the server; `snarkjs` is an
optional dependency used only for Groth16 proofs. No model calls, no paid
services, no secrets in code.

## Run

```bash
# 1. Install (snarkjs is optional — the server runs without it)
npm install

# 2. Set the secret issued ONCE at agent registration (never commit it)
export AGENT_GAMES_HMAC_SECRET=<hex or base64 secret from registration>

# 3. Start (listens on :8080 by default; put a reverse proxy on 443 in front)
npm start
```

Health check: `GET /` or `GET /health` → `{"status":"ok","agent":"axvenoir",...}`.

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `AGENT_GAMES_HMAC_SECRET` | — (required) | 32-byte secret from registration; hex (64 chars) or base64. Server refuses to start without it. |
| `PORT` | `8080` | Local listen port. Production: reverse-proxy 443 → this port (platform forbids custom ports on the public URL). |
| `AGENT_NAME` | `axvenoir` | |
| `AGENT_GAMES_ENABLE_PROOFS` | `0` | Set `1` ONLY after practice confirms the proof response field names (see `src/proof.mjs` + `PROOF_STATUS.md`). Gatekeeper schema is CONFIRMED; vfy-policy commitment recipe is still unknown. |
| `AGENT_GAMES_CIRCUIT_VERSION_VFY` | — | `circuitVersion` string for Steal the VFY (from registration/dashboard). Required to play Steal. |
| `AGENT_GAMES_STATE_FILE` | `./data/state.json` | Durable seen-proof set + idempotency cache. Keep this file across restarts. |
| `AGENT_GAMES_PROOF_TIMEOUT_MS` | `30000` | Proof attempt budget; on timeout the decision is answered without a proof. |
| `AGENT_GAMES_PROOF_SALT` | `987654321` | Salt for the gatekeeper commitment. Any fixed salt works (the circuit computes Poseidon([salt, taskId]) itself); 987654321 is the published example value. |

## Deploying on Vercel (free Hobby tier)

The server also runs as a Vercel Serverless Function (`api/index.mjs` —
same shared handler as `server.mjs`, see `src/handler.mjs`). No code
changes are needed to deploy; only dashboard settings.

1. Import the repo in the Vercel dashboard
   (https://github.com/brendley224der/agent-games-agent). Vercel detects
   the `api/` directory as a Node.js function; there is no build step and
   no framework.
2. Set these environment variables in the project settings:
   - `AGENT_GAMES_HMAC_SECRET` — the 32-byte secret from agent registration (required).
   - `AGENT_GAMES_STATE_FILE` — `/tmp/state.json` (required on Vercel; see the state caveat below).
   - `AGENT_GAMES_ENABLE_PROOFS` — `0` initially (only set `1` after practice confirms the proof response field names).
   - `AGENT_GAMES_CIRCUIT_VERSION_VFY` — set later, once the dashboard shows the `circuitVersion` for Steal.
3. Deploy. The endpoint is `https://<project>.vercel.app/api/index` — use
   that as the Agent Endpoint when registering the agent in the dashboard.
4. Verify: `GET https://<project>.vercel.app/api/index` →
   `{"status":"ok","agent":"axvenoir",...}`. A missing secret answers
   `500 {"error":"server_misconfigured"}` instead of crashing.

`vercel.json` (in the repo root) sets:
- `maxDuration: 300` — the Hobby maximum under Fluid compute, which is the
  default for new projects (official Vercel Functions limits, 2026-08-24:
  Hobby 300 s default and maximum; Pro/Enterprise 800 s). The agent needs
  at most ~30 s per Steal turn plus ~1 s for a Groth16 proof and cold start,
  so 300 s is generous headroom. If the project ever runs with Fluid compute
  disabled (legacy), Hobby caps at 60 s and a 300 s setting fails the build —
  lower it to 60 in that case.
- `includeFiles: "circuits/**"` — the Groth16 artifacts are loaded via
  `fs` at runtime (`proof.mjs`), which Vercel's file tracer (`@vercel/nft`)
  cannot reliably see, so they are force-included in the bundle. Verified
  locally with `@vercel/nft` (2026-11-15): the tracer happens to find all 6
  circuit files today because their paths are static string literals, but
  that is a heuristic — `includeFiles` guarantees they are present even if
  the path construction ever becomes dynamic. Without the artifacts, proof
  generation fails and the agent answers decision-only. `snarkjs` itself IS
  traced (dynamic `import("snarkjs")` with a literal specifier, plus its
  dependencies), so it needs no include.

### State caveat on Vercel (read this before registering)

On Vercel the on-disk state lives in `/tmp`, which is writable per
invocation but does NOT survive cold starts and is not shared between
function instances. The store (`src/store.mjs`) already tolerates this: a
missing or unwritable state file logs an error and the handler keeps
answering (verified by `npm run test:vercel`). What degrades:
- Idempotency cache: a task re-delivered to a cold instance is re-decided
  instead of replayed. Decisions are deterministic, so the re-decision is
  the same — the platform gets the same answer.
- Seen-proof set: cross-invocation `PROOF_REUSED` detection is weakened.
  A trap task whose `proof_tx` was seen by a previous (now-cold) instance
  can be wrongly APPROVEd. This is the one real cost of serverless hosting.
- Per-match opponent tracking (`matchState`) is in-memory only and resets
  per instance; the envelope's history wins when present, otherwise the
  policy falls back to EXTRACT.

If the rounds ever show repeat-delivery or proof-reuse losses, the fix is a
persistent store (e.g. Vercel KV / an external DB) or a long-running host —
both out of scope for this free-tier deploy.

## Request flow (every POST)

1. Read the raw body. Verify `x-agent-games-signature` (HMAC-SHA256 over the
   raw body) **before parsing anything**. Bad/missing signature → 401.
2. Parse JSON → route by envelope `type` (gatekeeper / steal / preflight).
3. Idempotency: gatekeeper `task_id`, Steal envelope `idempotencyKey`
   (else `matchId:turn`). Replays return the exact stored response.
4. Decide (fail closed). Optionally generate a Groth16 proof (off by default;
   only returned if it verifies locally). Proof failure never blocks the
   decision — the decision is answered without it.
5. Sign the raw response body (`x-agent-games-signature`) and answer.
   Gatekeeper deadline 60 s; Steal push window ~30 s. This server answers in
   milliseconds without proofs, seconds with them.

## Proof Gatekeeper — decision rules (verified from the official event page)

Task: `{type:"agent-games.proof-gatekeeper.v1", task_id, mode, issued_at,
deadline_at, input:{registered_vk, proof_vk, minimum, public_balance,
expiry_block, current_block, recipient, condition_recipient, amount,
max_transfer, proof_tx}}`.

Response: `{decision:"APPROVE"|"REJECT", reason_code, proof_tx}` (+ `proof` /
`public_signals` when proofs are enabled and generated).

| Check (in order) | Fails as |
|---|---|
| Malformed input (bad types/fields) | REJECT / `MALFORMED` (not an official code; fail-closed only) |
| `proof_tx` already seen | REJECT / `PROOF_REUSED` |
| `proof_vk` ≠ `registered_vk` | REJECT / `VK_SUBSTITUTION` |
| `public_balance` < `minimum` | REJECT / `THRESHOLD_MISMATCH` |
| `current_block` ≥ `expiry_block` | REJECT / `EXPIRED_CONDITION` |
| `recipient` ≠ `condition_recipient` | REJECT / `RECIPIENT_MISMATCH` |
| `amount` > `max_transfer` | REJECT / `AMOUNT_OVERFLOW` |
| All pass | APPROVE / `VALID_CONDITION` |

Scoring: correct +12; wrong APPROVE −6; wrong REJECT −3; timeout −2;
missing/invalid proof −2; reliability bonus +0..+5. A correct decision
without a proof nets +10. ~50% of tasks are valid; the rest are one of the
six traps above. Rounds: 8 daily, 13–21 Nov 2026, 16:00–02:00 IST
(17:30–03:30 WIB), 8 tasks/agent/round. Rounds 01–02 already ran; 03 is
15 Nov, 04–08 are 16–20 Nov.

Known limitation: the official checklist asks the agent to confirm the proof
is on-chain via zkVerifyJS/Kurier. That needs a Kurier API key or a funded
zkVerify account — not available under this project's FREE-ONLY constraint.
Every trap is still decidable from the task fields; the platform itself knows
whether `proof_tx` is on-chain. This engine validates `proof_tx` format and
the seen-set, and never approves inconsistent fields.

## Steal the VFY — committed policy `axvenoir-v1`

20 turns/match, 100 VFY each, highest balance wins. Actions: FORTIFY (small
fixed cost), EXTRACT (free, bounded take), HOLD (free, no movement).
Turn deadline 5 min; platform waits ~30 s per push. Scoring: win +18, draw
+9, loss +3, reliability bonus +0..+2, timeout −1/turn, invalid proof −2/turn.
5 Swiss rounds → Top 16 knockout, 13–17 Nov 2026.

Policy (deterministic, depends only on public game state):
1. Turn 1: EXTRACT.
2. If my balance > opponent balance AND the opponent EXTRACTed last turn:
   FORTIFY (protect a lead under attack).
3. Otherwise: EXTRACT.

Rationale: EXTRACT is free and weakly dominates HOLD in every pairing, so
HOLD is never played. FORTIFY is only worth its cost when it protects an
existing lead against an active extractor. `action.amount` is omitted entirely
for HOLD/FORTIFY (the platform schema rejects the field even as 0).

Without a valid policy proof every declared action degrades to HOLD — so
Steal the VFY is only playable once the vfy-policy proof works (see
`PROOF_STATUS.md`). The handler still answers every turn (fail closed to the
policy action); it just cannot score without proofs.

## Protocol facts: verified vs unknown

VERIFIED (official pages read 2026-11-15 + local checks):
- Task/response shapes above; 7 gatekeeper traps + shares; scoring both tracks;
  60 s gatekeeper deadline; 5-min Steal turns; HMAC header name + raw-body rule.
- Circuits: gatekeeper Groth16/BN128, 13 public inputs, vkHash
  `0x6b79c6…d77b0`; vfy-policy Groth16/BN128, 9 public inputs, vkHash
  `0x6c56…e047` (both from `/api/circuit-info`, VKs re-exported locally).
- Artifacts in `circuits/` (sizes match the published figures).
- Rules: platform never runs your code; public HTTPS only, no custom ports;
  offline = forfeit; manual play prohibited; practice 10 dispatches/hour.

UNKNOWN / ASSUMED (confirm via signed preflight + first practice task):
- HMAC digest encoding (assumed lowercase hex; verifier also accepts
  `sha256=`-prefixed and base64) and secret display format (assumed hex/base64).
- Exact Steal turn-envelope field names (only described semantically in docs;
  the handler parses camelCase/snake_case variants defensively).
- EXTRACT cap + FORTIFY cost (only "bounded"/"small fixed cost" published;
  read from the envelope when present, else default extract 10).
- `circuitVersion` value for Steal (needs the dashboard value).
- Groth16 schemas: **gatekeeper CONFIRMED** (13 inputs = 12 task fields +
  salt; decision 1=APPROVE, 0=REJECT; commitment = Poseidon([salt, taskId]);
  public signals in task order — see `PROOF_STATUS.md`). **vfy-policy input
  set CONFIRMED** (commitment, matchId, turnNumber, selfBalance,
  opponentBalance, action, amount, strategyParams[8], salt, circuitVersion)
  but the commitment recipe, strategyParams semantics, and public-signal
  order are still unknown — they need the practice turn envelope.
- The exact response field names for proofs (gatekeeper page shows only
  decision/reason_code/proof_tx). See `PROOF_STATUS.md`.
- Whether on-chain proof confirmation (Kurier/zkVerifyJS) has a free route.

## Tests

`npm test` — 43 checks, all passing (2026-11-15): server refuses to start
without a secret; health endpoint + signature; all 7 gatekeeper trap
varieties + malformed; bad/missing HMAC → 401; idempotent replays return
identical bodies; proof recorded once despite replay; Steal turns (EXTRACT /
FORTIFY-without-amount / behind → EXTRACT / malformed → 400); unknown type →
400; preflight → 200; proofs-enabled instance: valid + trap gatekeeper tasks
return proofs that verify locally against the exported VK, commitment equals
Poseidon(salt, taskId), public signals match the task; Steal turn answered
without proof (vfy commitment recipe still unknown); state persisted to disk.
Full log: `test/TEST_RESULTS.md`.

`npm run test:vercel` — 15 checks, all passing (2026-11-15): invokes
`api/index.mjs` directly with mock Node req/res objects (no Vercel account
needed); health + signature; gatekeeper decision + warm-instance
idempotency; bad/missing HMAC → 401; Steal turn; state persisted to the
`/tmp` path; cold-start state loss re-decides a reused proof_tx as APPROVE
(the documented caveat); unwritable state file degrades gracefully;
missing secret → 500 `server_misconfigured`. Full log:
`test/VERCEL_TEST_RESULTS.md`.

## What is still needed (NOT done by this build)

1. **GitHub repo** — CREATED 2026-11-15: https://github.com/brendley224der/agent-games-agent
   (public, personal account, README initial commit). Still needed: PUSH this
   code to it (needs a GitHub Personal Access Token — password login cannot
   push from the terminal).
2. **Public HTTPS endpoint** — CHOSEN: Vercel (free Hobby tier), 2026-11-15.
   The adapter is built (`api/index.mjs` + `vercel.json`, shared handler in
   `src/handler.mjs`; `npm test` 43/43 and `npm run test:vercel` 15/15
   passing locally). Still needed: import the repo in the Vercel dashboard,
   set the env vars (see "Deploying on Vercel" above), deploy, and use the
   endpoint URL when registering the agent. The server must stay UP
   (offline = forfeit). Note the state caveat: `/tmp` does not survive cold
   starts, so cross-invocation PROOF_REUSED detection is weakened.
3. **Agent registration** — register the agent in the dashboard (name
   `axvenoir`, tracks Proof Gatekeeper + Steal the VFY, repo URL, endpoint).
   The platform issues the 32-byte HMAC secret ONCE — save it to
   `AGENT_GAMES_HMAC_SECRET` (never commit it). Also note the
   `circuitVersion` for Steal.
4. **Signed preflight + at least one practice task** per track (entry
   requirement), then verify the HMAC format + envelope field names against
   the real envelopes and fix any assumption that proves wrong.
5. **Groth16 proofs** — confirm the circuit input schemas (see
   `PROOF_STATUS.md`) and enable `AGENT_GAMES_ENABLE_PROOFS=1`. Without
   them: gatekeeper scores +10/correct decision; Steal cannot score.
6. **Strategy commitment** for Steal must be registered before Swiss Round 1
   pairing (commitment frozen mid-match). Note: Steal Swiss runs 13–17 Nov —
   rounds may already be underway; check the dashboard for late-entry rules.
