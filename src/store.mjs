// Durable per-agent state: idempotency cache + seen proof references.
//
// Why durable: Proof Gatekeeper trap PROOF_REUSED is detected by comparing the
// task's proof reference against every reference this agent has ever seen. If
// the seen-set lived only in memory, a restart would make a reused proof look
// fresh and the agent would wrongly APPROVE it (-6). Likewise the idempotency
// cache must survive restarts so a platform retry after a crash returns the
// exact same response instead of re-deciding (and double-counting a proof).
//
// Format (data/state.json): { seenProofTx: [hex...], responses: { key: responseObj } }
// Volume is tiny (8 gatekeeper tasks/day + 20 turns/match), so the whole file
// is rewritten on each mutation. No secrets are ever stored here.
import fs from "node:fs";
import path from "node:path";

export class StateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.seenProofTx = new Set();
    this.responses = new Map(); // idempotency key -> { status, body }
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const data = JSON.parse(raw);
      if (Array.isArray(data.seenProofTx)) for (const x of data.seenProofTx) this.seenProofTx.add(String(x).toLowerCase());
      if (data.responses && typeof data.responses === "object") {
        for (const [k, v] of Object.entries(data.responses)) this.responses.set(k, v);
      }
    } catch (e) {
      if (e.code !== "ENOENT") console.error(`[store] could not load ${this.filePath}: ${e.message}`);
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({
        seenProofTx: [...this.seenProofTx],
        responses: Object.fromEntries(this.responses),
      }));
      fs.renameSync(tmp, this.filePath);
    } catch (e) {
      console.error(`[store] could not save ${this.filePath}: ${e.message}`);
    }
  }

  hasSeenProofTx(proofTx) {
    return this.seenProofTx.has(String(proofTx).toLowerCase());
  }

  markProofTxSeen(proofTx) {
    this.seenProofTx.add(String(proofTx).toLowerCase());
    this._save();
  }

  getResponse(key) {
    return this.responses.get(key) ?? null;
  }

  putResponse(key, status, body) {
    this.responses.set(key, { status, body });
    // Bound the cache: keep the newest 2000 entries (far above any season volume).
    if (this.responses.size > 2000) {
      const first = this.responses.keys().next().value;
      this.responses.delete(first);
    }
    this._save();
  }
}
