/**
 * Local Identity Provider
 *
 * Phase 3: Replaces legacy SIWE provisioning with local wallet-based identity.
 * The automaton's identity IS its wallet — no external auth needed.
 *
 * Reads wallet from ~/.automaton/wallet.json (created by identity/wallet.ts)
 * and config from ~/.automaton/automaton.json.
 */

import type { AutomatonIdentity } from "../types.js";
import type { Address } from "viem";
import { getWallet, getAutomatonDir, walletExists } from "../identity/wallet.js";
import { loadConfig } from "../config.js";
import fs from "fs";
import path from "path";

/**
 * Get the automaton's full identity from local wallet + config.
 * No network calls — everything is read from disk.
 */
export async function getIdentity(): Promise<AutomatonIdentity> {
  const { account } = await getWallet();

  const config = loadConfig();
  if (!config) {
    // Minimal identity when no config exists yet (pre-setup)
    return {
      name: "automaton",
      address: account.address,
      account,
      creatorAddress: "0x0000000000000000000000000000000000000000" as Address,
      sandboxId: "local",
      apiKey: "",
      createdAt: new Date().toISOString(),
    };
  }

  return {
    name: config.name,
    address: account.address,
    account,
    creatorAddress: config.creatorAddress,
    sandboxId: config.sandboxId || "local",
    apiKey: config.conwayApiKey || "",
    createdAt: getCreatedAt(),
  };
}

/**
 * Check if the automaton has a usable identity (wallet exists).
 */
export function hasIdentity(): boolean {
  return walletExists();
}

/**
 * Get the creation timestamp from config or wallet file.
 */
function getCreatedAt(): string {
  const configPath = path.join(getAutomatonDir(), "config.json");
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (config.provisionedAt) return config.provisionedAt;
    } catch {
      // fall through
    }
  }

  const walletPath = path.join(getAutomatonDir(), "wallet.json");
  if (fs.existsSync(walletPath)) {
    try {
      const wallet = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
      if (wallet.createdAt) return wallet.createdAt;
    } catch {
      // fall through
    }
  }

  return new Date().toISOString();
}
