/**
 * Automaton Auth Provisioning — Migration Wrapper
 *
 * MIGRATION NOTE (Phase 3): SIWE provisioning is kept as a legacy fallback
 * but is no longer required. The primary auth path is now local: wallet
 * identity + provider API keys from env/keys.json/config.
 *
 * loadApiKeyFromConfig() now delegates to src/local/auth.ts which checks
 * env vars, keys.json, and config files.
 */

import fs from "fs";
import path from "path";
import { SiweMessage } from "siwe";
import { getWallet, getAutomatonDir } from "./wallet.js";
import type { ProvisionResult } from "../types.js";
import { ResilientHttpClient } from "../conway/http-client.js";
import { loadApiKey, saveProviderKeys } from "../local/auth.js";

const httpClient = new ResilientHttpClient();

const DEFAULT_API_URL = "";

/**
 * Load API key from local sources (env, keys.json, config.json).
 * Phase 3: Delegates to src/local/auth.ts instead of only checking config.json.
 */
export function loadApiKeyFromConfig(): string | null {
  return loadApiKey();
}

/**
 * Save API key and wallet address to ~/.automaton/config.json
 * Also saves to keys.json for the new local auth system.
 */
function saveConfig(apiKey: string, walletAddress: string): void {
  const dir = getAutomatonDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const configPath = path.join(dir, "config.json");
  const config = {
    apiKey,
    walletAddress,
    provisionedAt: new Date().toISOString(),
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), {
    mode: 0o600,
  });

  // Also persist to keys.json for the local auth system
  saveProviderKeys({ conwayApiKey: apiKey });
}

/**
 * Run the full SIWE provisioning flow (legacy).
 *
 * Phase 3 note: This is now OPTIONAL. The automaton can run without
 * an API key as long as provider keys (OpenAI/Anthropic) are set.
 * This function is kept for backward compatibility.
 */
export async function provision(
  apiUrl?: string,
): Promise<ProvisionResult> {
  const url = apiUrl || process.env.CONWAY_API_URL || DEFAULT_API_URL;

  // 1. Load wallet
  const { account } = await getWallet();
  const address = account.address;

  // 2. Get nonce
  const nonceResp = await httpClient.request(`${url}/v1/auth/nonce`, {
    method: "POST",
  });
  if (!nonceResp.ok) {
    throw new Error(
      `Failed to get nonce: ${nonceResp.status} ${await nonceResp.text()}`,
    );
  }
  const { nonce } = (await nonceResp.json()) as { nonce: string };

  // 3. Construct and sign SIWE message
  const siweMessage = new SiweMessage({
    domain: "datchi.app",
    address,
    statement:
      "Sign in as an Automaton to provision an API key.",
    uri: `${url}/v1/auth/verify`,
    version: "1",
    chainId: 8453, // Base
    nonce,
    issuedAt: new Date().toISOString(),
  });

  const messageString = siweMessage.prepareMessage();
  const signature = await account.signMessage({ message: messageString });

  // 4. Verify signature -> get JWT
  const verifyResp = await httpClient.request(`${url}/v1/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: messageString, signature }),
  });

  if (!verifyResp.ok) {
    throw new Error(
      `SIWE verification failed: ${verifyResp.status} ${await verifyResp.text()}`,
    );
  }

  const { access_token } = (await verifyResp.json()) as {
    access_token: string;
  };

  // 5. Create API key
  const keyResp = await httpClient.request(`${url}/v1/auth/api-keys`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${access_token}`,
    },
    body: JSON.stringify({ name: "datchi-automaton" }),
  });

  if (!keyResp.ok) {
    throw new Error(
      `Failed to create API key: ${keyResp.status} ${await keyResp.text()}`,
    );
  }

  const { key, key_prefix } = (await keyResp.json()) as {
    key: string;
    key_prefix: string;
  };

  // 6. Save to config
  saveConfig(key, address);

  return { apiKey: key, walletAddress: address, keyPrefix: key_prefix };
}

/**
 * Register the automaton's creator as its parent (legacy).
 * Phase 3 note: This is optional — only needed for cloud features.
 */
export async function registerParent(
  creatorAddress: string,
  apiUrl?: string,
): Promise<void> {
  const url = apiUrl || process.env.CONWAY_API_URL || DEFAULT_API_URL;
  const apiKey = loadApiKeyFromConfig();
  if (!apiKey) {
    // No API key — skip silently in local mode
    return;
  }

  const resp = await httpClient.request(`${url}/v1/automaton/register-parent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ creatorAddress }),
  });

  // Endpoint may not exist yet -- fail gracefully
  if (!resp.ok && resp.status !== 404) {
    throw new Error(
      `Failed to register parent: ${resp.status} ${await resp.text()}`,
    );
  }
}
