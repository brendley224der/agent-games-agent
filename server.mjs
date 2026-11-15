// axvenoir — Agent Games (zkVerify) Season 01 agent server (long-running).
//
// Tracks: Proof Gatekeeper + Steal the VFY. Node.js 22 stdlib only (http +
// crypto). Deterministic rule-based decisions; no model calls, no paid
// services, no secrets in code.
//
// All request handling lives in src/handler.mjs (shared with the Vercel
// entrypoint api/index.mjs). This file only owns the process: it refuses to
// start without the HMAC secret, then listens.
//
// Run:
//   AGENT_GAMES_HMAC_SECRET=<secret from registration> node server.mjs
//   PORT=8080 AGENT_GAMES_HMAC_SECRET=... node server.mjs
//
// Env vars: see README.md (AGENT_GAMES_HMAC_SECRET is REQUIRED).
import http from "node:http";

import { loadConfig, createHandler } from "./src/handler.mjs";

const CONFIG = loadConfig();

if (!process.env.AGENT_GAMES_HMAC_SECRET) {
  console.error("FATAL: AGENT_GAMES_HMAC_SECRET is not set. The secret is issued once at agent registration — it is never stored in code or in this repo.");
  process.exit(1);
}

const handler = createHandler(CONFIG);
const server = http.createServer(handler);

server.listen(CONFIG.port, () => {
  console.log(`[${new Date().toISOString()}] axvenoir agent listening on :${CONFIG.port} (proofs ${CONFIG.proofsEnabled ? "ENABLED" : "disabled"}, state: ${CONFIG.stateFile})`);
  if (!CONFIG.circuitVersionVfy) {
    console.log(`[${new Date().toISOString()}] NOTE: AGENT_GAMES_CIRCUIT_VERSION_VFY is not set — Steal-the-VFY turns cannot carry a valid policy proof until it is configured.`);
  }
});
