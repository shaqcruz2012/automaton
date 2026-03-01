/**
 * State Versioning
 *
 * Version control the automaton's own state files (~/.automaton/).
 * Every self-modification triggers a git commit with a descriptive message.
 * The automaton's entire identity history is version-controlled and replayable.
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { ConwayClient, AutomatonDatabase } from "../types.js";
import { gitInit, gitCommit, gitStatus, gitLog } from "./tools.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("state-versioning");

const AUTOMATON_DIR = "~/.automaton";

function resolveHome(p: string): string {
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(2)); // slice "~/" or "~\\"
  }
  return path.resolve(p);
}

/**
 * Initialize git repo for the automaton's state directory.
 * Creates .gitignore to exclude sensitive files.
 *
 * Non-essential for the PoC — failures are logged but do not block startup.
 */
export async function initStateRepo(
  conway: ConwayClient,
): Promise<void> {
  const dir = resolveHome(AUTOMATON_DIR);

  // Check if already initialized using fs (cross-platform, no shell dependency)
  const gitDir = path.join(dir, ".git");
  try {
    if (fs.existsSync(gitDir) && fs.statSync(gitDir).isDirectory()) {
      return;
    }
  } catch {
    // If we can't stat, try to initialize anyway
  }

  // Ensure the directory exists
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err: any) {
    logger.warn(`Cannot create automaton dir ${dir}: ${err.message}`);
    return; // Non-blocking: skip git init if dir can't be created
  }

  // Initialize
  try {
    await gitInit(conway, dir);
  } catch (err: any) {
    logger.warn(`git init failed for ${dir}: ${err.message}`);
    return; // Non-blocking: skip remaining git setup
  }

  // Create .gitignore for sensitive files
  const gitignore = `# Sensitive files - never commit
wallet.json
config.json
state.db
state.db-wal
state.db-shm
logs/
*.log
*.err
`;

  try {
    await conway.writeFile(`${dir}/.gitignore`, gitignore);
  } catch {
    // Non-blocking: .gitignore is nice-to-have
  }

  // Configure git user
  try {
    await conway.exec(
      `cd "${dir}" && git config user.name "Automaton" && git config user.email "automaton@datchi.app"`,
      5000,
    );
  } catch {
    // Non-blocking: git config is nice-to-have
  }

  // Initial commit
  try {
    await gitCommit(conway, dir, "genesis: automaton state repository initialized");
  } catch {
    // Non-blocking: initial commit is nice-to-have
  }
}

/**
 * Commit a state change with a descriptive message.
 * Called after any self-modification.
 */
export async function commitStateChange(
  conway: ConwayClient,
  description: string,
  category: string = "state",
): Promise<string> {
  const dir = resolveHome(AUTOMATON_DIR);

  // Check if there are changes
  const status = await gitStatus(conway, dir);
  if (status.clean) {
    return "No changes to commit";
  }

  const message = `${category}: ${description}`;
  const result = await gitCommit(conway, dir, message);
  return result;
}

/**
 * Commit after a SOUL.md update.
 */
export async function commitSoulUpdate(
  conway: ConwayClient,
  description: string,
): Promise<string> {
  return commitStateChange(conway, description, "soul");
}

/**
 * Commit after a skill installation or removal.
 */
export async function commitSkillChange(
  conway: ConwayClient,
  skillName: string,
  action: "install" | "remove" | "update",
): Promise<string> {
  return commitStateChange(
    conway,
    `${action} skill: ${skillName}`,
    "skill",
  );
}

/**
 * Commit after heartbeat config change.
 */
export async function commitHeartbeatChange(
  conway: ConwayClient,
  description: string,
): Promise<string> {
  return commitStateChange(conway, description, "heartbeat");
}

/**
 * Commit after config change.
 */
export async function commitConfigChange(
  conway: ConwayClient,
  description: string,
): Promise<string> {
  return commitStateChange(conway, description, "config");
}

/**
 * Get the state repo history.
 */
export async function getStateHistory(
  conway: ConwayClient,
  limit: number = 20,
) {
  const dir = resolveHome(AUTOMATON_DIR);
  return gitLog(conway, dir, limit);
}
