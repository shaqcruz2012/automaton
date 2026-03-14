#!/usr/bin/env node
/**
 * Datchi Landing Page — Bootstrap Script
 *
 * Launches the landing page server as a child process.
 * Run directly: node services/landing-page/start.js
 * Or deploy to ~/.automaton/services/landing-page.js
 */

import { spawn } from 'child_process';

const child = spawn('node', ['server.js'], {
  cwd: import.meta.dirname,
  stdio: 'inherit',
});

child.on('exit', (code) => process.exit(code ?? 1));
