/**
 * Cross-platform launcher for FxLeboncoin.
 * Spawns Google Chrome with remote debugging on port 9222,
 * waits for it to be ready, and then starts the Hono server.
 * Handles graceful exit by killing Chrome when stopped.
 */

import { spawn } from 'bun';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import os from 'os';
import path from 'path';

function findChromePath(): string {
  const platform = os.platform();

  if (platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }

  if (platform === 'win32') {
    const paths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
    ];
    for (const p of paths) {
      if (existsSync(p)) return p;
    }
    throw new Error('Google Chrome not found. Please install Chrome to run the scraper.');
  }

  // Linux
  const commands = ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium'];
  for (const cmd of commands) {
    try {
      execSync(`which ${cmd}`, { stdio: 'ignore' });
      return cmd;
    } catch {}
  }
  throw new Error('Chrome/Chromium executable not found on Linux. Please install it.');
}

const chromePath = findChromePath();
const tempDir = path.join(os.tmpdir(), 'chrome_dev');

console.log(`[fxlbc] Chrome path: "${chromePath}"`);
console.log(`[fxlbc] User data dir: "${tempDir}"`);

// Check if Chrome is already listening on port 9222
let isChromeRunning = false;
try {
  const res = await fetch('http://127.0.0.1:9222/json/version');
  if (res.ok) {
    isChromeRunning = true;
    console.log('[fxlbc] Chrome debugging port 9222 is already active. Reusing instance.');
  }
} catch {}

let chromeProcess: any = null;
if (!isChromeRunning) {
  console.log('[fxlbc] Starting Chrome with debugging port 9222...');
  chromeProcess = spawn([
    chromePath,
    '--remote-debugging-port=9222',
    `--user-data-dir=${tempDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ], {
    stdout: 'ignore',
    stderr: 'ignore',
  });

  // Wait for Chrome to warm up
  await new Promise(resolve => setTimeout(resolve, 2000));
}

// Graceful cleanup on exit
const cleanup = () => {
  console.log('\n[fxlbc] Stopping server and shutting down Chrome...');
  if (chromeProcess) {
    try {
      chromeProcess.kill();
    } catch {}
  }
  process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Import and start the Hono worker
import worker from './src/worker';

// Start server
Bun.serve({
  port: worker.port,
  fetch: worker.fetch,
  idleTimeout: 30
});
