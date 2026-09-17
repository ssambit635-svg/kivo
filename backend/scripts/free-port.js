#!/usr/bin/env node
/**
 * Frees the port used by the backend (PORT env var, default 8080) by
 * terminating whatever process is listening on it. Use this when
 * `npm start` fails with EADDRINUSE.
 *
 * Cross-platform:
 *   - Linux:   `lsof -iTCP` (falls back to `ss -tlnp`)
 *   - macOS:   `lsof -iTCP`
 *   - Windows: `netstat -ano` + `taskkill`
 *
 * Usage:
 *   npm run kill-port
 *   PORT=9000 npm run kill-port
 */
import { execFileSync, execSync } from 'node:child_process';

const port = Number(process.env.PORT || 8080);
const isWindows = process.platform === 'win32';

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid PORT: ${process.env.PORT} — expected a number between 1 and 65535.`);
  process.exit(1);
}

function pidsFromLsof() {
  try {
    const out = execFileSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().split(/\s+/).map(Number).filter(Boolean);
  } catch {
    return []; // lsof not installed, or nothing listening
  }
}

function pidsFromSs() {
  try {
    const out = execFileSync('ss', ['-tlnp'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pids = new Set();
    for (const line of out.split('\n')) {
      const cols = line.trim().split(/\s+/);
      // LISTEN rows: State Recv-Q Send-Q Local:Port Peer:Port Process
      const local = cols[3];
      if (!local || !local.endsWith(`:${port}`)) continue;
      for (const m of line.matchAll(/pid=(\d+)/g)) pids.add(Number(m[1]));
    }
    return [...pids];
  } catch {
    return []; // ss not installed
  }
}

function pidsFromNetstat() {
  let out = '';
  try {
    out = execSync('netstat -ano', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return [];
  }
  const pids = new Set();
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+:\d+\s+LISTENING\s+(\d+)\s*$/i);
    if (m && Number(m[1]) === port) pids.add(Number(m[2]));
  }
  return [...pids].filter((pid) => pid > 0);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 = existence check, nothing is sent
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function killPid(pid) {
  if (isWindows) {
    execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return; // already gone
  }
  // give it up to ~2s to exit, then force-kill
  for (let i = 0; i < 20 && isAlive(pid); i += 1) await sleep(100);
  if (isAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

async function main() {
  const pids = (isWindows ? pidsFromNetstat() : pidsFromLsof().concat(pidsFromSs()))
    .filter((pid) => pid !== process.pid);

  if (pids.length === 0) {
    console.log(`Nothing is listening on port ${port} — you can run \`npm start\` now.`);
    return;
  }

  console.log(`Port ${port} is held by PID ${pids.join(', ')} — terminating…`);
  for (const pid of pids) await killPid(pid);
  await sleep(300);

  const stillAlive = pids.filter(isAlive);
  if (stillAlive.length > 0) {
    console.error(
      `Could not terminate PID ${stillAlive.join(', ')} automatically.\n` +
        `Kill it manually: ${isWindows ? `taskkill /PID ${stillAlive[0]} /F` : `kill -9 ${stillAlive.join(' ')}`}`,
    );
    process.exit(1);
  }
  console.log(`Port ${port} is free — run \`npm start\` again.`);
}

main().catch((err) => {
  console.error('kill-port failed:', err.message);
  process.exit(1);
});
