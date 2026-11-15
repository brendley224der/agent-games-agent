# AgentGames agent server — local test results

Run: 2026-11-15T09:33:57.938Z

- Passed: 43
- Failed: 0

- PASS server refuses to start without AGENT_GAMES_HMAC_SECRET
- PASS server becomes healthy
- PASS GET /health 200 + agent axvenoir
- PASS GET /health response is HMAC-signed
- PASS gatekeeper valid -> APPROVE/VALID_CONDITION
- PASS gatekeeper valid -> APPROVE/VALID_CONDITION response signed
- PASS gatekeeper VK_SUBSTITUTION
- PASS gatekeeper VK_SUBSTITUTION response signed
- PASS gatekeeper THRESHOLD_MISMATCH
- PASS gatekeeper THRESHOLD_MISMATCH response signed
- PASS gatekeeper PROOF_REUSED (same proof_tx as t1)
- PASS gatekeeper PROOF_REUSED (same proof_tx as t1) response signed
- PASS gatekeeper EXPIRED_CONDITION
- PASS gatekeeper EXPIRED_CONDITION response signed
- PASS gatekeeper RECIPIENT_MISMATCH
- PASS gatekeeper RECIPIENT_MISMATCH response signed
- PASS gatekeeper AMOUNT_OVERFLOW
- PASS gatekeeper AMOUNT_OVERFLOW response signed
- PASS gatekeeper MALFORMED (missing fields)
- PASS gatekeeper MALFORMED (missing fields) response signed
- PASS bad HMAC -> 401
- PASS missing HMAC -> 401
- PASS idempotent replay returns identical body
- PASS proof recorded once despite replay
- PASS steal turn 1 (equal) -> EXTRACT with amount
- PASS steal turn 1 response signed
- PASS steal turn 1 idempotencyKey = matchId:turn
- PASS steal ahead + opponent extracted -> FORTIFY, no amount field
- PASS steal behind -> EXTRACT
- PASS steal malformed (no matchId) -> 400
- PASS steal replay returns identical body
- PASS steal bad HMAC -> 401
- PASS unknown task type -> 400
- PASS preflight -> 200 ok
- PASS proof server becomes healthy
- PASS proofs-enabled: valid task APPROVE with proof + public_signals
- PASS proofs-enabled: commitment == Poseidon(salt, taskId)
- PASS proofs-enabled: public signals match task (decision 1, taskId 24, minimum 1000)
- PASS proofs-enabled: proof verifies locally against exported VK
- PASS proofs-enabled: trap task REJECT with proof that verifies locally
- PASS proofs-enabled: steal turn answered without proof (vfy commitment recipe unknown)
- PASS state file persists seen proof_tx
- PASS state file persists idempotent responses

Notes:
- Tests run against the real server on 127.0.0.1:18099 with a throwaway test HMAC secret.
- Section 8 runs a second server instance with AGENT_GAMES_ENABLE_PROOFS=1 and verifies gatekeeper proofs locally against the exported VK (vfy-policy proofs remain unknown — see PROOF_STATUS.md).
