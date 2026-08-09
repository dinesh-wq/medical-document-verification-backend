import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, '..');

async function waitForServer(port, child) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (child.exitCode !== null) throw new Error(`Server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Server did not become ready in time.');
}

function startServer(port) {
  return spawn(process.execPath, ['src/server.js'], {
    cwd: backendDir,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: '',
      DB_HOST: '',
      DB_PASSWORD: '',
      JWT_SECRET: 'test-secret',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('does not allow login without a configured database', async () => {
  const child = startServer(4101);
  try {
    await waitForServer(4101, child);
    const response = await fetch('http://127.0.0.1:4101/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'sofia@arbormedical.com', password: 'reviewer123' }),
    });

    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error.code, 'DATABASE_UNAVAILABLE');
  } finally {
    child.kill('SIGTERM');
  }
});

test('protects dashboard summary behind authentication', async () => {
  const child = startServer(4102);
  try {
    await waitForServer(4102, child);
    const response = await fetch('http://127.0.0.1:4102/api/v1/dashboard/summary');

    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error.code, 'UNAUTHENTICATED');
  } finally {
    child.kill('SIGTERM');
  }
});
