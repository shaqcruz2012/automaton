/**
 * x402 Gateway Entry Point
 *
 * Starts the gateway server on port 7402 (or GATEWAY_PORT env var).
 * Loads the wallet from ~/.automaton/wallet.json for on-chain execution.
 *
 * Usage: npx tsx src/gateway/index.ts
 */
import fs from "fs";
import path from "path";
import os from "os";
import Database from "better-sqlite3";
import { privateKeyToAccount } from "viem/accounts";
import { createGatewayServer } from "./server.js";
import { initNonceSchema } from "./nonces.js";
import { initAccountingSchema } from "../local/accounting.js";

const PORT = parseInt(process.env.GATEWAY_PORT ?? "7402", 10);
const DB_PATH = process.env.GATEWAY_DB_PATH ??
  path.join(os.homedir(), ".automaton", "gateway.db");
const WALLET_PATH = process.env.WALLET_PATH ??
  path.join(os.homedir(), ".automaton", "wallet.json");

function main() {
  // Load wallet
  let account;
  try {
    const walletRaw = fs.readFileSync(WALLET_PATH, "utf-8");
    const wallet = JSON.parse(walletRaw);
    account = privateKeyToAccount(wallet.privateKey as `0x${string}`);
    console.log(`[gateway] Wallet loaded: ${account.address}`);
  } catch (err: any) {
    console.error(`[gateway] Failed to load wallet from ${WALLET_PATH}: ${err.message}`);
    console.error("[gateway] On-chain execution will be disabled.");
  }

  // Open database
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Initialize schemas
  initNonceSchema(db);
  initAccountingSchema(db);

  // Create and start server
  const { server, pricing } = createGatewayServer({
    db,
    port: PORT,
    account,
    executeOnChain: !!account,
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[gateway] x402 gateway running on http://0.0.0.0:${PORT}`);
    console.log(`[gateway] Wallet: ${pricing.walletAddress}`);
    console.log(`[gateway] Endpoints:`);
    for (const [name, tier] of Object.entries(pricing.tiers)) {
      console.log(`  ${tier.route} → $${tier.priceUsd} (${name})`);
    }
    console.log(`[gateway] On-chain execution: ${account ? "ENABLED" : "DISABLED"}`);
  });

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n[gateway] Shutting down...");
    server.close();
    db.close();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    server.close();
    db.close();
    process.exit(0);
  });
}

main();
