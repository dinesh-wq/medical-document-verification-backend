import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, '..');

async function waitForServer(port) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Server did not become ready in time.');
}

test('falls back to demo auth when the database is unavailable', async () => {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: backendDir,
    env: {
      ...process.env,
      PORT: '4101',
      DATABASE_URL: '',
      DEMO_AUTH_ENABLED: 'false',
      JWT_SECRET: 'test-secret',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });

  try {
    await waitForServer(4101);

    const response = await fetch('http://127.0.0.1:4101/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'sofia@arbormedical.com', password: 'reviewer123' }),
    });

    assert.equal(response.status, 200, `Expected 200, got ${response.status}. ${stdout}\n${stderr}`);
    const body = await response.json();
    assert.equal(body.user.email, 'sofia@arbormedical.com');
  } finally {
    child.kill('SIGTERM');
  }
});

test('returns a dashboard summary payload for the intake hub', async () => {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: backendDir,
    env: {
      ...process.env,
      PORT: '4102',
      DATABASE_URL: '',
      DEMO_AUTH_ENABLED: 'false',
      JWT_SECRET: 'test-secret',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });

  try {
    await waitForServer(4102);
    const response = await fetch('http://127.0.0.1:4102/api/v1/dashboard/summary');

    assert.equal(response.status, 200, `Expected 200, got ${response.status}. ${stdout}\n${stderr}`);
    const body = await response.json();
    assert.ok(body.data);
    assert.ok(body.data.metrics);
    assert.ok(Array.isArray(body.data.recentCases));
  } finally {
    child.kill('SIGTERM');
  }
});
