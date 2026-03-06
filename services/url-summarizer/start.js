#!/usr/bin/env node
/**
 * URL Summarizer Pro - Bootstrap Script
 *
 * This file is the deployable entrypoint for the service watchdog.
 * It launches the TypeScript server via tsx.
 *
 * Deploy to ~/.automaton/services/url-summarizer.js
 * or run directly: node services/url-summarizer/start.js
 */

import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { execFileSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const serverPath = join(__dirname, "src", "server.ts");

// Try tsx first, fall back to ts-node
try {
  execFileSync("npx", ["tsx", serverPath], {
    cwd: __dirname,
    stdio: "inherit",
    env: { ...process.env, PATH: process.env.PATH },
  });
} catch {
  // If tsx fails, try direct node (assumes pre-compiled)
  const distPath = join(__dirname, "dist", "server.js");
  execFileSync(process.execPath, [distPath], {
    cwd: __dirname,
    stdio: "inherit",
  });
}
