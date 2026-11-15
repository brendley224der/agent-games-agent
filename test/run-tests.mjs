// Local test harness for the axvenoir Agent Games agent server.
// Starts the real server on a test port with a TEST secret, then drives it
// with signed requests covering both tracks, bad signatures, idempotent
// replays, and the missing-secret startup guard. No network, no platform,
// no money. Run: npm test   (or: node test/run-tests.mjs)
import * as snarkjs from "snarkjs";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const PORT = 18099;
const TEST_SECRET_HEX = "11".repeat(32); // 32 bytes of 0x11 — TEST ONLY, never a real secret.
const SECRET = Buffer.from(TEST_SECRET_HEX, "hex");
const STATE_FILE = path.join(os.tmpdir(), `agentgames-test-state-${process.pid}.json`);

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; results.push(`PASS ${name}`); }
  else { fail++; results.push(`FAIL ${name} ${detail}`); }
}

function sign(body) {
  return crypto.createHmac("sha256", SECRET).update(body).digest("hex");
}
function verifySig(body, sig) {
  if (!sig) return false;
  const expected = crypto.createHmac("sha256", SECRET).update(body).digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(sig, "utf8"), Buffer.from(expected, "utf8")); }
  catch { return false; }
}

function request(method, pathName, bodyObj = null, { rawBody = null, signature = null, signIt = true, port = PORT } = {}) {
  return new Promise((resolve, reject) => {
    const body = rawBody ?? (bodyObj === null ? "" : JSON.stringify(bodyObj));
    const headers = { "content-type": "application/json", "content-length": Buffer.byteLength(body) };
    if (signIt) headers["x-agent-games-signature"] = signature ?? sign(body);
    const req = http.request({ host: "127.0.0.1", port, path: pathName, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null; try { json = JSON.parse(text); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json, sigOk: verifySig(text, res.headers["x-agent-games-signature"]) });
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(tries = 30, port = PORT) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await request("GET", "/health", null, { signIt: false, port });
      if (r.status === 200) return true;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  return false;
}

const VK = "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";
const VK2 = "0xa4c1c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";
const ADDR = "0xDe42000000000000000000000000000000009f01";
const ADDR2 = "0xDe43000000000000000000000000000000009f02";
const TX = (n) => `0x${String(n).padStart(64, "a")}`;

function gkTask(taskId, overrides = {}) {
  return {
    type: "agent-games.proof-gatekeeper.v1",
    task_id: taskId,
    mode: "competition",
    issued_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 60000).toISOString(),
    input: {
      registered_vk: VK, proof_vk: VK, minimum: "1000", public_balance: "1460",
      expiry_block: 19842201, current_block: 19832000,
      recipient: ADDR, condition_recipient: ADDR,
      amount: "500", max_transfer: "1000", proof_tx: TX(1),
      ...overrides,
    },
  };
}

async function main() {
  // 0. Server must refuse to start without a secret.
  {
    const p = spawn("node", ["server.mjs"], { cwd: ROOT, env: { ...process.env, PORT: String(PORT + 1) } });
    let out = "";
    p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { out += d; });
    const code = await new Promise((r) => p.on("exit", r));
    check("server refuses to start without AGENT_GAMES_HMAC_SECRET", code !== 0 && out.includes("AGENT_GAMES_HMAC_SECRET"), `exit=${code}`);
  }

  const server = spawn("node", ["server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), AGENT_GAMES_HMAC_SECRET: TEST_SECRET_HEX, AGENT_GAMES_STATE_FILE: STATE_FILE },
  });
  server.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
  server.stderr.on("data", (d) => process.stderr.write(`[srv:err] ${d}`));
  try {
    check("server becomes healthy", await waitHealthy(), "GET /health never 200");

    // 1. Health endpoint.
    {
      const r = await request("GET", "/health", null, { signIt: false });
      check("GET /health 200 + agent axvenoir", r.status === 200 && r.json?.agent === "axvenoir", JSON.stringify(r.json));
      check("GET /health response is HMAC-signed", r.sigOk === true);
    }

    // 2. Gatekeeper: all 7 trap varieties + malformed.
    {
      const cases = [
        ["valid -> APPROVE/VALID_CONDITION", gkTask("gk_t1", { proof_tx: TX(1) }), "APPROVE", "VALID_CONDITION"],
        ["VK_SUBSTITUTION", gkTask("gk_t2", { proof_vk: VK2, proof_tx: TX(2) }), "REJECT", "VK_SUBSTITUTION"],
        ["THRESHOLD_MISMATCH", gkTask("gk_t3", { public_balance: "500", proof_tx: TX(3) }), "REJECT", "THRESHOLD_MISMATCH"],
        ["PROOF_REUSED (same proof_tx as t1)", gkTask("gk_t4", { proof_tx: TX(1) }), "REJECT", "PROOF_REUSED"],
        ["EXPIRED_CONDITION", gkTask("gk_t5", { current_block: 19842201, proof_tx: TX(5) }), "REJECT", "EXPIRED_CONDITION"],
        ["RECIPIENT_MISMATCH", gkTask("gk_t6", { recipient: ADDR2, proof_tx: TX(6) }), "REJECT", "RECIPIENT_MISMATCH"],
        ["AMOUNT_OVERFLOW", gkTask("gk_t7", { amount: "1500", proof_tx: TX(7) }), "REJECT", "AMOUNT_OVERFLOW"],
        ["MALFORMED (missing fields)", { type: "agent-games.proof-gatekeeper.v1", task_id: "gk_t8", input: { minimum: "1000" } }, "REJECT", "MALFORMED"],
      ];
      for (const [name, task, wantDecision, wantReason] of cases) {
        const r = await request("POST", "/", task);
        check(`gatekeeper ${name}`, r.status === 200 && r.json?.decision === wantDecision && r.json?.reason_code === wantReason,
          `got ${r.status} ${JSON.stringify(r.json)}`);
        check(`gatekeeper ${name} response signed`, r.sigOk === true);
      }
    }

    // 3. Bad signature -> 401, no work done.
    {
      const r = await request("POST", "/", gkTask("gk_bad1", { proof_tx: TX(9) }), { signature: "00".repeat(32) });
      check("bad HMAC -> 401", r.status === 401 && r.json?.error === "invalid_signature", `got ${r.status}`);
      const r2 = await request("POST", "/", gkTask("gk_bad2", { proof_tx: TX(10) }), { signIt: false });
      check("missing HMAC -> 401", r2.status === 401, `got ${r2.status}`);
    }

    // 4. Idempotent replay: same task_id returns the identical stored body.
    {
      const task = gkTask("gk_replay", { proof_tx: TX(11) });
      const r1 = await request("POST", "/", task);
      const r2 = await request("POST", "/", task);
      check("idempotent replay returns identical body", r1.status === 200 && r2.status === 200 && r1.text === r2.text, `${r1.text} vs ${r2.text}`);
      // And the replay must NOT double-count the proof: a new task reusing
      // the same proof_tx is still PROOF_REUSED (recorded once is enough).
      const r3 = await request("POST", "/", gkTask("gk_reuse_after_replay", { proof_tx: TX(11) }));
      check("proof recorded once despite replay", r3.json?.reason_code === "PROOF_REUSED", JSON.stringify(r3.json));
    }

    // 5. Steal the VFY turns.
    {
      const turn1 = { type: "agent-games.steal-the-vfy.v1", matchId: "m1", turn: 1, myBalance: 100, opponentBalance: 100, deadline: new Date(Date.now() + 300000).toISOString() };
      const r1 = await request("POST", "/", turn1);
      check("steal turn 1 (equal) -> EXTRACT with amount", r1.status === 200 && r1.json?.action?.type === "EXTRACT" && typeof r1.json?.action?.amount === "number" && r1.json?.matchId === "m1" && r1.json?.turn === 1, JSON.stringify(r1.json));
      check("steal turn 1 response signed", r1.sigOk === true);
      check("steal turn 1 idempotencyKey = matchId:turn", r1.json?.idempotencyKey === "m1:1", JSON.stringify(r1.json));

      const turn2 = { type: "agent-games.steal-the-vfy.v1", matchId: "m1", turn: 2, myBalance: 120, opponentBalance: 90, opponentLastAction: "EXTRACT" };
      const r2 = await request("POST", "/", turn2);
      check("steal ahead + opponent extracted -> FORTIFY, no amount field", r2.status === 200 && r2.json?.action?.type === "FORTIFY" && !("amount" in (r2.json?.action ?? {})), JSON.stringify(r2.json));

      const turn3 = { type: "agent-games.steal-the-vfy.v1", matchId: "m2", turn: 2, myBalance: 90, opponentBalance: 120, opponentLastAction: "HOLD" };
      const r3 = await request("POST", "/", turn3);
      check("steal behind -> EXTRACT", r3.status === 200 && r3.json?.action?.type === "EXTRACT", JSON.stringify(r3.json));

      const r4 = await request("POST", "/", { type: "agent-games.steal-the-vfy.v1", turn: 1 });
      check("steal malformed (no matchId) -> 400", r4.status === 400, `got ${r4.status}`);

      const r5 = await request("POST", "/", turn1);
      check("steal replay returns identical body", r5.status === 200 && r5.text === r1.text, "replay differed");

      const r6 = await request("POST", "/", turn1, { signature: "00".repeat(32) });
      check("steal bad HMAC -> 401", r6.status === 401, `got ${r6.status}`);
    }

    // 6. Unknown type + preflight.
    {
      const r1 = await request("POST", "/", { type: "agent-games.something-else.v1" });
      check("unknown task type -> 400", r1.status === 400 && r1.json?.error === "unknown_task_type", `got ${r1.status}`);
      const r2 = await request("POST", "/", { type: "agent-games.preflight.v1" });
      check("preflight -> 200 ok", r2.status === 200 && r2.json?.status === "ok", `got ${r2.status} ${r2.text}`);
    }

    // 8. Proofs enabled: gatekeeper tasks return proofs that verify locally.
    // (Separate server instance on PORT+2 with AGENT_GAMES_ENABLE_PROOFS=1.)
    {
      const PROOF_PORT = PORT + 2;
      const PROOF_STATE = path.join(os.tmpdir(), `agentgames-test-proof-state-${process.pid}.json`);
      const proofServer = spawn("node", ["server.mjs"], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(PROOF_PORT), AGENT_GAMES_HMAC_SECRET: TEST_SECRET_HEX, AGENT_GAMES_STATE_FILE: PROOF_STATE, AGENT_GAMES_ENABLE_PROOFS: "1" },
      });
      proofServer.stdout.on("data", (d) => process.stdout.write(`[srv-proof] ${d}`));
      proofServer.stderr.on("data", (d) => process.stderr.write(`[srv-proof:err] ${d}`));
      try {
        check("proof server becomes healthy", await waitHealthy(30, PROOF_PORT), "proof instance never came up");
        const vk = JSON.parse(fs.readFileSync(path.join(ROOT, "circuits", "gatekeeper-vk.json"), "utf8"));
        // Known commitment for salt 987654321, taskId 24 (Poseidon([salt, taskId])).
        const EXPECTED_COMMITMENT = "4538591768452999874275481926009620849813943225939850916630922448132760538048";
        const valid = gkTask("gk_24_9d1", { proof_tx: TX(21) });
        const r1 = await request("POST", "/", valid, { port: PROOF_PORT });
        check("proofs-enabled: valid task APPROVE with proof + public_signals",
          r1.status === 200 && r1.json?.decision === "APPROVE" && r1.json?.proof && Array.isArray(r1.json?.public_signals) && r1.json.public_signals.length === 13,
          JSON.stringify(r1.json)?.slice(0, 200));
        check("proofs-enabled: commitment == Poseidon(salt, taskId)",
          r1.json?.public_signals?.[0] === EXPECTED_COMMITMENT, String(r1.json?.public_signals?.[0]));
        check("proofs-enabled: public signals match task (decision 1, taskId 24, minimum 1000)",
          r1.json?.public_signals?.[11] === "1" && r1.json?.public_signals?.[12] === "24" && r1.json?.public_signals?.[3] === "1000",
          JSON.stringify(r1.json?.public_signals));
        check("proofs-enabled: proof verifies locally against exported VK",
          r1.json?.proof ? await snarkjs.groth16.verify(vk, r1.json.public_signals, r1.json.proof) : false);
        const trap = gkTask("gk_24_9d2", { proof_vk: VK2, proof_tx: TX(22) });
        const r2 = await request("POST", "/", trap, { port: PROOF_PORT });
        check("proofs-enabled: trap task REJECT with proof that verifies locally",
          r2.status === 200 && r2.json?.decision === "REJECT" && r2.json?.reason_code === "VK_SUBSTITUTION" && r2.json?.proof &&
          await snarkjs.groth16.verify(vk, r2.json.public_signals, r2.json.proof),
          JSON.stringify(r2.json)?.slice(0, 200));
        const st = await request("POST", "/", { type: "agent-games.steal-the-vfy.v1", matchId: "mp", turn: 1, myBalance: 100, opponentBalance: 100 }, { port: PROOF_PORT });
        check("proofs-enabled: steal turn answered without proof (vfy commitment recipe unknown)",
          st.status === 200 && st.json?.action?.type === "EXTRACT" && st.json?.proof === undefined, JSON.stringify(st.json));
      } finally {
        proofServer.kill("SIGTERM");
        await sleep(300);
        try { fs.unlinkSync(PROOF_STATE); } catch { /* already gone */ }
      }
    }

    // 7. State persisted to disk (seen proof refs survive).
    {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      check("state file persists seen proof_tx", Array.isArray(saved.seenProofTx) && saved.seenProofTx.includes(TX(1).toLowerCase()), JSON.stringify(saved.seenProofTx)?.slice(0, 120));
      check("state file persists idempotent responses", saved.responses && Object.keys(saved.responses).length >= 10, `keys=${Object.keys(saved.responses ?? {}).length}`);
    }
  } finally {
    server.kill("SIGTERM");
    await sleep(300);
    try { fs.unlinkSync(STATE_FILE); } catch { /* already gone */ }
  }

  console.log(`\n==== RESULTS: ${pass} passed, ${fail} failed ====`);
  for (const line of results) console.log(line);
  const report = `# AgentGames agent server — local test results\n\nRun: ${new Date().toISOString()}\n\n- Passed: ${pass}\n- Failed: ${fail}\n\n${results.map((l) => `- ${l}`).join("\n")}\n\nNotes:\n- Tests run against the real server on 127.0.0.1:${PORT} with a throwaway test HMAC secret.\n- Section 8 runs a second server instance with AGENT_GAMES_ENABLE_PROOFS=1 and verifies gatekeeper proofs locally against the exported VK (vfy-policy proofs remain unknown — see PROOF_STATUS.md).\n`;
  fs.writeFileSync(path.join(HERE, "TEST_RESULTS.md"), report);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
