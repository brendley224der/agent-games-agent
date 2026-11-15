// Vercel Serverless Function entrypoint (Node.js runtime) for the axvenoir
// Agent Games agent.
//
// Vercel calls this default export with Node http IncomingMessage /
// ServerResponse objects — the same shapes node:http uses — so it delegates
// straight to the shared handler in ../src/handler.mjs. No body parsing by
// Vercel is assumed: the handler reads the raw stream itself (it must, the
// HMAC is verified over the raw body before anything is parsed).
//
// Differences from the long-running server (server.mjs):
// - No listen() and no process.exit: a missing AGENT_GAMES_HMAC_SECRET is
//   answered as 500 server_misconfigured on every request instead of
//   crashing the function, so the misconfiguration is visible in logs.
// - The handler is created lazily on the first invocation and cached for the
//   lifetime of a warm instance, so env vars are read at first use.
// - State lives in /tmp (AGENT_GAMES_STATE_FILE=/tmp/state.json, set in the
//   Vercel dashboard). /tmp is writable but does NOT survive cold starts or
//   scale-out: the idempotency cache and seen-proof set reset per instance.
//   Decisions are deterministic so a re-delivered task is re-decided the
//   same way, but cross-invocation PROOF_REUSED detection is weakened — see
//   README.md ("Deploying on Vercel") for the full caveat.
//
// Config: vercel.json sets maxDuration 300 (Hobby maximum under Fluid
// compute, the default for new projects) and includeFiles "circuits/**"
// (the Groth16 artifacts are loaded via fs at runtime, which Vercel's file
// tracer cannot see — without includeFiles they would be missing from the
// bundle and proofs would fail with "VK not exported").
import { loadConfig, createHandler } from "../src/handler.mjs";

let cachedHandler = null;
let cachedError = null;

function getHandler() {
  if (cachedHandler) return cachedHandler;
  if (cachedError) throw cachedError;
  try {
    cachedHandler = createHandler(loadConfig());
    return cachedHandler;
  } catch (e) {
    cachedError = e;
    throw e;
  }
}

export default async function handler(req, res) {
  try {
    const h = getHandler();
    await h(req, res);
  } catch (e) {
    console.error(`[vercel] handler unavailable: ${e?.message ?? e}`);
    try {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "server_misconfigured" }));
    } catch { /* socket gone */ }
  }
}
