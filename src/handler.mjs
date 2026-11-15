// Shared request handler for the axvenoir Agent Games agent.
//
// This module owns ALL request handling; it is used by two entrypoints:
//   - server.mjs        — long-running Node http server (local / VPS)
//   - api/index.mjs     — Vercel Serverless Function (Node.js runtime)
//
// Both entrypoints pass Node http IncomingMessage / ServerResponse objects,
// so one handler serves both. The handler is created lazily via
// createHandler() so each runtime can decide what a missing secret means:
// server.mjs exits FATAL (the test suite checks that); the Vercel entry
// answers 500 server_misconfigured instead of crashing the function.
//
// Request flow (every POST, in order) — see README.md for the full list:
//   1. Read the raw body (max 1 MiB). Verify x-agent-games-signature BEFORE
//      parsing anything. Bad/missing signature -> 401, no work done.
//   2. Parse JSON. Unknown/invalid JSON -> 400 (signed).
//   3. Route by envelope type; idempotency key = gatekeeper task_id, or the
//      Steal envelope's idempotencyKey (else matchId:turn). A repeat key
//      returns the exact stored response (same body, re-signed).
//   4. Decide (gatekeeper.mjs / steal.mjs). Fail closed on any doubt.
//   5. Optionally generate a Groth16 proof (proof.mjs; off by default, and
//      only returned if it verifies locally). Proof failure never blocks the
//      decision — the decision is answered without it.
//   6. Sign the raw response body with x-agent-games-signature and answer.
//      Gatekeeper deadline is 60 s; Steal push window is ~30 s. This server
//      answers in milliseconds without proofs, seconds with them.
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseSecret, verifySignature, signBody } from "./hmac.mjs";
import { StateStore } from "./store.mjs";
import { decideGatekeeper, recordProofTx } from "./gatekeeper.mjs";
import { parseTurnEnvelope, decideSteal, buildStealResponse, POLICY_ID } from "./steal.mjs";
import { proveGatekeeper, proveSteal } from "./proof.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

const MAX_BODY = 1024 * 1024;

/** Read the agent configuration from the environment (see README.md). */
export function loadConfig() {
  return {
    port: Number(process.env.PORT ?? 8080),
    agentName: process.env.AGENT_NAME ?? "axvenoir",
    proofsEnabled: process.env.AGENT_GAMES_ENABLE_PROOFS === "1",
    circuitVersionVfy: process.env.AGENT_GAMES_CIRCUIT_VERSION_VFY ?? null,
    stateFile: process.env.AGENT_GAMES_STATE_FILE ?? path.join(ROOT, "data", "state.json"),
    proofTimeoutMs: Number(process.env.AGENT_GAMES_PROOF_TIMEOUT_MS ?? 30000),
    proofSalt: process.env.AGENT_GAMES_PROOF_SALT ? Number(process.env.AGENT_GAMES_PROOF_SALT) : undefined,
  };
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/**
 * Build the request handler. Throws if AGENT_GAMES_HMAC_SECRET is unset or
 * unparseable — callers decide the failure mode (server.mjs: FATAL exit;
 * api/index.mjs: 500 on every request). The returned handler is safe to call
 * for the lifetime of the process; state is held in the closure.
 */
export function createHandler(config = loadConfig()) {
  if (!process.env.AGENT_GAMES_HMAC_SECRET) {
    throw new Error("AGENT_GAMES_HMAC_SECRET is not set. The secret is issued once at agent registration — it is never stored in code or in this repo.");
  }
  const SECRET = parseSecret(process.env.AGENT_GAMES_HMAC_SECRET);
  const store = new StateStore(config.stateFile);

  // Per-match opponent tracking (in-memory; envelope history wins when present).
  // A restart loses this — the policy then treats the next turn as if the
  // opponent's last action is unknown (EXTRACT default). Acceptable degradation.
  const matchState = new Map(); // matchId -> { lastOpponentAction, lastTurn }

  function send(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      "content-type": "application/json",
      "x-agent-games-signature": signBody(SECRET, body),
    });
    res.end(body);
  }

  function isGatekeeper(body) {
    const t = String(body?.type ?? "");
    return t.includes("proof-gatekeeper") || t.includes("gatekeeper");
  }

  function isSteal(body) {
    const t = String(body?.type ?? "");
    return t.includes("steal") || t.includes("vfy") || body?.matchId !== undefined || body?.match_id !== undefined;
  }

  function isPreflight(body) {
    const t = String(body?.type ?? "").toLowerCase();
    return t.includes("preflight") || t.includes("health") || t.includes("ping");
  }

  async function handleGatekeeper(body, startedAt) {
    const taskId = String(body?.task_id ?? "");
    const input = body?.input ?? null;
    const { decision, reason_code, proof_tx } = decideGatekeeper(input, store);
    if (proof_tx) recordProofTx(store, proof_tx);
    const response = { decision, reason_code, proof_tx };

    if (config.proofsEnabled && decision) {
      const r = await proveGatekeeper(body, decision, { timeoutMs: config.proofTimeoutMs, salt: config.proofSalt });
      if (r.proof) {
        response.proof = r.proof;
        response.public_signals = r.publicSignals;
        log(`[gatekeeper ${taskId}] proof attached (verified locally)`);
      } else {
        log(`[gatekeeper ${taskId}] proof unavailable: ${r.error} — answering decision-only`);
      }
    }
    log(`[gatekeeper ${taskId}] ${decision} ${reason_code} in ${Date.now() - startedAt}ms`);
    return { status: 200, body: response };
  }

  async function handleSteal(body, startedAt) {
    const parsed = parseTurnEnvelope(body);
    if (!parsed.matchId || parsed.turn === null) {
      return { status: 400, body: { error: "malformed_turn_envelope", detail: "matchId and turn are required" } };
    }
    const prev = matchState.get(parsed.matchId);
    const oppLast = parsed.opponentLastAction ?? prev?.lastOpponentAction ?? null;
    const action = decideSteal(parsed, oppLast);
    const idempotencyKey = parsed.idempotencyKey ?? `${parsed.matchId}:${parsed.turn}`;
    let proof = null;
    if (config.proofsEnabled) {
      const r = await proveSteal(parsed, action, { timeoutMs: config.proofTimeoutMs });
      if (r.proof) {
        proof = { ...r, circuitVersion: config.circuitVersionVfy ?? parsed.circuitVersion ?? undefined };
      } else {
        log(`[steal ${parsed.matchId} turn ${parsed.turn}] proof unavailable: ${r.error} — action degrades to HOLD`);
      }
    } else if (!config.circuitVersionVfy && !parsed.circuitVersion) {
      log(`[steal ${parsed.matchId} turn ${parsed.turn}] no circuitVersion configured (AGENT_GAMES_CIRCUIT_VERSION_VFY) — action will degrade to HOLD without a proof`);
    }
    const response = buildStealResponse(parsed, action, idempotencyKey, proof);
    // Track the opponent's last action for the next turn (best effort: the
    // envelope's history wins; otherwise remember what the resolver will show
    // next turn — we cannot know it yet, so keep the previous value).
    matchState.set(parsed.matchId, { lastOpponentAction: oppLast, lastTurn: parsed.turn });
    log(`[steal ${parsed.matchId} turn ${parsed.turn}] ${action.type}${action.amount !== undefined ? ` ${action.amount}` : ""} in ${Date.now() - startedAt}ms`);
    return { status: 200, body: response };
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  return async function handleRequest(req, res) {
    const startedAt = Date.now();
    try {
      if (req.method === "GET") {
        return send(res, 200, {
          status: "ok", agent: config.agentName,
          tracks: ["proof-gatekeeper", "steal-the-vfy"],
          policy: POLICY_ID, proofs_enabled: config.proofsEnabled,
          time: new Date().toISOString(),
        });
      }
      if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });

      const rawBody = await readBody(req);
      const sig = req.headers["x-agent-games-signature"];
      const { ok, form } = verifySignature(SECRET, rawBody, sig);
      if (!ok) {
        log(`[auth] rejected: bad/missing x-agent-games-signature`);
        return send(res, 401, { error: "invalid_signature" });
      }
      let body;
      try {
        body = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return send(res, 400, { error: "invalid_json" });
      }

      // Idempotency: gatekeeper task_id, Steal envelope key, else matchId:turn.
      let key = null;
      if (isGatekeeper(body)) key = String(body.task_id ?? "");
      else if (isSteal(body)) {
        const p = parseTurnEnvelope(body);
        key = String(body.idempotencyKey ?? body.idempotency_key ?? (p.matchId && p.turn !== null ? `${p.matchId}:${p.turn}` : ""));
      }
      if (key) {
        const cached = store.getResponse(key);
        if (cached) {
          log(`[idempotent] replay ${key} -> stored response`);
          return send(res, cached.status, cached.body);
        }
      }

      let result;
      if (isPreflight(body)) {
        result = { status: 200, body: { status: "ok", agent: config.agentName, tracks: ["proof-gatekeeper", "steal-the-vfy"], time: new Date().toISOString() } };
      } else if (isGatekeeper(body)) {
        result = await handleGatekeeper(body, startedAt);
      } else if (isSteal(body)) {
        result = await handleSteal(body, startedAt);
      } else {
        log(`[router] unknown task type: ${JSON.stringify(body?.type ?? null)}`);
        result = { status: 400, body: { error: "unknown_task_type", type: body?.type ?? null } };
      }
      if (key && result.status === 200) store.putResponse(key, result.status, result.body);
      return send(res, result.status, result.body);
    } catch (e) {
      console.error(`[error] ${e?.stack ?? e}`);
      try { return send(res, 500, { error: "internal_error" }); } catch { /* socket gone */ }
    }
  };
}
