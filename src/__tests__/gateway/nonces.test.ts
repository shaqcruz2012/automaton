import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import {
  initNonceSchema,
  checkNonce,
  reserveNonce,
  markNonceExecuted,
  markNonceFailed,
} from "../../gateway/nonces.js";

function createTestDb(): Database.Database {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nonce-test-"));
  const db = new Database(path.join(tmpDir, "test.db"));
  db.pragma("journal_mode = WAL");
  initNonceSchema(db);
  return db;
}

describe("nonce tracking", () => {
  let db: Database.Database;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it("allows a fresh nonce", () => {
    expect(checkNonce(db, "0xabc123")).toBe(true);
  });

  it("rejects a previously reserved nonce", () => {
    reserveNonce(db, {
      nonce: "0xabc123",
      fromAddr: "0x1111111111111111111111111111111111111111",
      amountAtomic: "250000",
      tier: "summarize-basic",
    });
    expect(checkNonce(db, "0xabc123")).toBe(false);
  });

  it("marks nonce as executed with tx hash", () => {
    reserveNonce(db, {
      nonce: "0xabc123",
      fromAddr: "0x1111111111111111111111111111111111111111",
      amountAtomic: "250000",
      tier: "summarize-basic",
    });
    markNonceExecuted(db, "0xabc123", "0xtxhash999");
    const row = db.prepare("SELECT status, tx_hash FROM x402_nonces WHERE nonce = ?")
      .get("0xabc123") as any;
    expect(row.status).toBe("executed");
    expect(row.tx_hash).toBe("0xtxhash999");
  });

  it("marks nonce as failed with error", () => {
    reserveNonce(db, {
      nonce: "0xabc123",
      fromAddr: "0x1111111111111111111111111111111111111111",
      amountAtomic: "250000",
      tier: "summarize-basic",
    });
    markNonceFailed(db, "0xabc123", "insufficient gas");
    const row = db.prepare("SELECT status, error FROM x402_nonces WHERE nonce = ?")
      .get("0xabc123") as any;
    expect(row.status).toBe("failed");
    expect(row.error).toBe("insufficient gas");
  });
});
