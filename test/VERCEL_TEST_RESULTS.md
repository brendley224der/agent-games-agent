# AgentGames agent — Vercel handler test results

Run: 2026-11-15T09:33:58.806Z

- Passed: 15
- Failed: 0

- PASS vercel GET /health 200 + agent axvenoir
- PASS vercel GET /health response is HMAC-signed
- PASS vercel POST gatekeeper valid -> APPROVE/VALID_CONDITION
- PASS vercel POST gatekeeper response signed
- PASS vercel POST same task -> identical body (warm-instance idempotency)
- PASS vercel POST bad HMAC -> 401
- PASS vercel POST missing HMAC -> 401
- PASS vercel POST steal turn 1 -> EXTRACT with amount
- PASS vercel state file persists seen proof_tx to AGENT_GAMES_STATE_FILE
- PASS vercel state file persists idempotent responses
- PASS vercel cold-start state loss: reused proof_tx re-decided APPROVE (documented caveat, not PROOF_REUSED)
- PASS vercel degraded state (unwritable): GET still 200
- PASS vercel degraded state (unwritable): POST gatekeeper still 200 APPROVE
- PASS createHandler throws without AGENT_GAMES_HMAC_SECRET
- PASS vercel entry with no secret (subprocess) -> 500 server_misconfigured

Notes:
- Invokes api/index.mjs directly with mock Node http req/res objects (no Vercel account, no vercel dev/deploy).
- The cold-start check documents the Vercel state caveat: a fresh handler with no state file re-decides a reused proof_tx as APPROVE instead of PROOF_REUSED (see README.md).
