// Run the sealed suite locally: start the kit's env server, start this entry, wait for the
// export, and print the score. Usage:
//   node grade-local.mjs [state-dir]
// The env runs on 127.0.0.1:8080; the token is a fixed test token, shared by both processes.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const kitDir = '/home/hatch/workspace/makefun/github-core-kit/github-core-clone-01-kit';
const workDir = '/home/hatch/workspace/makefun/work-github-core';
const stateDir = process.argv[2] ?? '/tmp/grade-github-core';
const TOKEN = 'test-shop-token-0123456789abcdef';

rmSync(stateDir, { recursive: true, force: true });
mkdirSync(stateDir, { recursive: true });

const envLog = [];
const entryLog = [];

const env = spawn('node', ['program/env/server.mjs'], {
  cwd: kitDir,
  env: {
    ...process.env,
    MAKEFUN_STATE_DIR: stateDir,
    MAKEFUN_ENV_HOST: '127.0.0.1',
    MAKEFUN_ENV_PORT: '8080',
    MAKEFUN_SHOP_TOKEN: TOKEN,
    MAKEFUN_TRIAL_WALL_BUDGET_SEC: '900',
  },
});
env.stdout.on('data', (chunk) => envLog.push(chunk.toString()));
env.stderr.on('data', (chunk) => envLog.push(chunk.toString()));

function waitForFile(path, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (existsSync(path)) return resolve(true);
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${path}`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

try {
  console.log('waiting for env ready...');
  await waitForFile(join(stateDir, 'ready'), 30_000);
  console.log('env ready:', readFileSync(join(stateDir, 'ready'), 'utf8').trim());

  const entry = spawn('node', ['--experimental-strip-types', 'main.ts'], {
    cwd: workDir,
    env: {
      ...process.env,
      MAKEFUN_ENV_URL: 'http://127.0.0.1:8080',
      MAKEFUN_SHOP_TOKEN: TOKEN,
    },
  });
  entry.stdout.on('data', (chunk) => entryLog.push(chunk.toString()));
  entry.stderr.on('data', (chunk) => entryLog.push(chunk.toString()));

  console.log('entry started, waiting for the suite to finish (up to 15 min)...');
  const code = await waitForExit(env, 15 * 60_000);
  console.log('env exited with code', code);

  try { entry.kill('SIGTERM'); } catch { /* already gone */ }
  try { env.kill('SIGTERM'); } catch { /* already gone */ }

  const statePath = join(stateDir, 'export', 'state.json');
  const perfPath = join(stateDir, 'export', 'perf.json');
  if (existsSync(statePath)) {
    console.log('\n===== export/state.json =====');
    console.log(readFileSync(statePath, 'utf8'));
  } else {
    console.log('\nNO export/state.json — the suite did not finish.');
  }
  if (existsSync(perfPath)) {
    console.log('\n===== export/perf.json =====');
    console.log(readFileSync(perfPath, 'utf8'));
  }
} catch (err) {
  console.error('grade run failed:', err.message);
  try { env.kill('SIGKILL'); } catch { /* already gone */ }
}

console.log('\n===== env log (tail) =====');
console.log(envLog.join('').split('\n').slice(-40).join('\n'));
console.log('\n===== entry log (tail) =====');
console.log(entryLog.join('').split('\n').slice(-40).join('\n'));
