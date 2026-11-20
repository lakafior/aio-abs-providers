const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ENTRY = path.resolve(__dirname, '..', '..', 'src', 'backbone', 'server.js');

// Starts the real entry point the way an embedding app does: its own working directory, a config path
// outside the code, a free loopback port. Resolves once the server says where it listens.
function launch(t, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backbone-proc-'));
  const child = spawn(process.execPath, [ENTRY], {
    cwd: os.tmpdir(),
    env: { PATH: process.env.PATH, PORT: '0', HOST: '127.0.0.1', CONFIG_PATH: path.join(dir, 'config.json'), ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); });
  const ready = new Promise((resolve, reject) => {
    const onData = (chunk) => {
      output += chunk;
      const found = output.match(/listening on (http:\/\/[^\s]+)/);
      if (found) resolve(found[1]);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => { output += chunk; });
    exited.then(() => reject(new Error(`server exited early:\n${output}`)));
    setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 10000).unref();
  });
  return { child, dir, ready, exited, output: () => output };
}

test('server: starts with outside config on loopback, answers /healthz, exits cleanly on SIGTERM', async (t) => {
  const proc = launch(t, { DISABLE_ADMIN: '1', DISABLE_SEARCH_UI: '1' });
  const base = await proc.ready;
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(fs.existsSync(path.join(proc.dir, 'config.json')), 'default config created');

  const health = await (await fetch(`${base}/healthz`)).json();
  assert.equal(health.status, 'ok');
  assert.equal((await fetch(`${base}/admin`)).status, 404);
  assert.equal((await fetch(`${base}/search`)).status, 400);

  proc.child.kill('SIGTERM');
  assert.deepEqual(await proc.exited, { code: 0, signal: null });
  await assert.rejects(() => fetch(`${base}/healthz`));
});

test('server: exits when the parent closes stdin, if asked to', async (t) => {
  const proc = launch(t, { EXIT_ON_STDIN_CLOSE: '1' });
  await proc.ready;
  proc.child.stdin.end();
  assert.deepEqual(await proc.exited, { code: 0, signal: null });
  assert.match(proc.output(), /stdin closed/);
});

test('server: a closed stdin is ignored by default (Docker without -i)', async (t) => {
  const proc = launch(t);
  const base = await proc.ready;
  proc.child.stdin.end();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  proc.child.kill('SIGINT');
  assert.deepEqual(await proc.exited, { code: 0, signal: null });
});

test('server: an unusable config stops the start with a message', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backbone-proc-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{"providers": {"audioteka": {"enabled": "tak"}}}');
  const proc = launch(t, { CONFIG_PATH: file });
  proc.ready.catch(() => {});
  assert.deepEqual(await proc.exited, { code: 1, signal: null });
  assert.match(proc.output(), /Failed to load config/);
  fs.rmSync(dir, { recursive: true, force: true });
});
