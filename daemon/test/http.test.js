/**
 * The HTTP surface, against a real daemon on a real socket.
 *
 * Everything else in this suite tests a module in isolation. This starts the
 * actual process and talks to it over TLS, because the things that break here
 * are wiring rather than logic: a route that never got added to the switch, a
 * CORS header the sidebar needs and does not get, an SSE frame the browser
 * cannot parse.
 *
 * Runs on its own port with its own HOME, so it never touches a daemon you are
 * using or the real state file.
 */

const test = require('node:test');
const assert = require('node:assert');
const https = require('https');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 8477;
const BASE = { host: '127.0.0.1', port: PORT, rejectUnauthorized: false };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-http-'));

let daemon;

function req(method, pathname, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = https.request({
      ...BASE, path: pathname, method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json',
                     'Content-Length': Buffer.byteLength(data) } : {}),
        ...(headers || {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (d) => { raw += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/**
 * Open an SSE stream and expose frames as they arrive.
 *
 * `onFrame` fires per frame so a test can react mid-stream — which is the
 * only way to test pairing without waiting out its three-minute timeout, and
 * is also how the real sidebar behaves.
 */
function stream(pathname, body, onFrame) {
  const frames = [];
  const done = new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = https.request({
      ...BASE, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json',
                 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        const parts = buf.split(String.fromCharCode(10,10));
        buf = parts.pop();
        for (const p of parts) {
          if (!p.trim()) continue;
          frames.push(p);
          if (onFrame) onFrame(p, JSON.parse(p.replace(/^data: /, '')));
        }
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, frames }));
    });
    r.on('error', reject);
    r.write(data);
    r.end();
  });
  return done;
}

/** The dashboard token, which only GET / hands out. */
async function dashToken() {
  const page = await req('GET', '/');
  const m = /DASH_TOKEN = "([a-f0-9]+)"/.exec(page.raw);
  assert.ok(m, 'could not read the dashboard token from the page');
  return m[1];
}

test.before(async () => {
  daemon = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), HOME: TMP, USERPROFILE: TMP },
    stdio: 'ignore',
  });
  // Wait for the socket rather than sleeping a guessed interval.
  const deadline = Date.now() + 20000;
  for (;;) {
    try { await req('GET', '/ping'); return; } catch {
      if (Date.now() > deadline) throw new Error('daemon never came up');
      await new Promise((r) => setTimeout(r, 250));
    }
  }
});

test.after(() => {
  if (daemon) daemon.kill();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

// ------------------------------------------------------------------ routes

test('/ping answers without touching any state', async () => {
  const r = await req('GET', '/ping');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
  assert.match(r.json.version, /^\d+\.\d+\.\d+$/);
  assert.strictEqual(typeof r.json.credentialReady, 'boolean');
});

test('/status carries everything the dashboard renders from', async () => {
  const r = await req('GET', '/status');
  assert.strictEqual(r.status, 200);
  for (const key of ['version', 'origin', 'cli', 'pending', 'paired', 'activity',
                     'settings', 'autostart']) {
    assert.ok(key in r.json, '/status is missing ' + key);
  }
  assert.ok(Array.isArray(r.json.paired));
  assert.ok(Array.isArray(r.json.activity));
});

test('an unknown route is a clean 404, not a crash', async () => {
  const r = await req('GET', '/nope');
  assert.strictEqual(r.status, 404);
  assert.ok(r.json, 'and still JSON, so the caller can read it');
});

test('malformed JSON is refused without taking the process down', async () => {
  const bad = await new Promise((resolve, reject) => {
    const r = https.request({ ...BASE, path: '/turn', method: 'POST',
      headers: { 'Content-Type': 'application/json' } }, (res) => {
      let raw = ''; res.on('data', (d) => { raw += d; });
      res.on('end', () => resolve({ status: res.statusCode, raw }));
    });
    r.on('error', reject);
    r.write('{not json');
    r.end();
  });
  assert.strictEqual(bad.status, 400);
  // Still alive afterwards, which is the actual assertion.
  assert.strictEqual((await req('GET', '/ping')).status, 200);
});

// -------------------------------------------------------------------- CORS

test('the sidebar can reach us from its rotating origin', async () => {
  // The sidebar's host carries a hash that changes, so no allowlist is
  // possible and the wildcard is the only workable answer. Pairing is the
  // auth boundary instead — see the dashboard-token tests.
  const r = await req('GET', '/ping', undefined,
    { Origin: 'https://n-abc123def456-0lu-script.googleusercontent.com' });
  assert.strictEqual(r.headers['access-control-allow-origin'], '*');
});

test('preflight is answered, or every POST from the sidebar fails', async () => {
  const r = await req('OPTIONS', '/op-result');
  assert.strictEqual(r.status, 204);
  assert.strictEqual(r.headers['access-control-allow-origin'], '*');
  assert.match(r.headers['access-control-allow-methods'] || '', /POST/);
  assert.match(r.headers['access-control-allow-headers'] || '', /Content-Type/i);
});

test('GET / sends no CORS headers, because it carries the token', async () => {
  const r = await req('GET', '/');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['access-control-allow-origin'], undefined,
    'a cross-origin page must not be able to read the dashboard token');
  assert.match(r.raw, /<!DOCTYPE html>/);
});

// ----------------------------------------------------- the dashboard boundary

test('dashboard routes refuse a request without the token', async () => {
  for (const route of ['/pair', '/settings', '/instructions', '/reset', '/unpair', '/quit']) {
    const r = await req('POST', route, { spreadsheetId: 'x', allow: true });
    assert.strictEqual(r.status, 403, route + ' must refuse an untokened caller');
  }
  assert.strictEqual((await req('GET', '/ping')).status, 200, 'and stays up');
});

test('a wrong token is refused as firmly as no token', async () => {
  const r = await req('POST', '/settings', { model: 'x' },
    { 'X-Dashboard-Token': 'not-the-token' });
  assert.strictEqual(r.status, 403);
});

// ------------------------------------------------------------- the tool loop

test('the bridge refuses a call from an unknown turn', async () => {
  // The per-turn token is minted per turn and known only to the bridge this
  // process spawned. Without it there is no way to drive the sidebar.
  const r = await req('POST', '/bridge/call',
    { token: 'made-up', name: 'read_range', arguments: {} });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.json.ok, false);
});

test('the web gate refuses a call from an unknown turn', async () => {
  const r = await req('POST', '/gate',
    { token: 'made-up', tool: 'WebFetch', detail: { url: 'https://example.com' } });
  assert.strictEqual(r.status, 403);
});

test('answering a call id that was never issued settles nothing', async () => {
  // The call id IS the credential here — a hostile page cannot guess a live
  // one, and guessing wrong must be inert rather than an error.
  const r = await req('POST', '/op-result', { callId: 'deadbeef', result: { ok: true } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.settled, false);

  const g = await req('POST', '/gate-result', { gateId: 'deadbeef', allow: true });
  assert.strictEqual(g.json.settled, false);
});

// ---------------------------------------------------------------- /turn SSE

test('/turn requires a spreadsheet and a prompt', async () => {
  const r = await req('POST', '/turn', { prompt: 'hi' });
  assert.strictEqual(r.status, 400);
});

test('the pairing lifecycle runs: hold, decide, release', async () => {
  // A turn from an unrecognized spreadsheet blocks until a human answers in
  // the dashboard. Deny rather than approve: approving would go on to invoke
  // Claude for real, which is neither free nor deterministic.
  const token = await dashToken();

  const finished = stream('/turn', {
    spreadsheetId: 'http-test-sheet', spreadsheetName: 'HTTP Test', prompt: 'hello',
  }, (_raw, ev) => {
    // Answer the moment it asks, which is what makes this fast.
    if (ev.type === 'pairing_required') {
      req('POST', '/pair', { spreadsheetId: 'http-test-sheet', allow: false },
        { 'X-Dashboard-Token': token });
    }
  });

  const r = await finished;
  assert.strictEqual(r.status, 200);
  assert.match(r.headers['content-type'], /text\/event-stream/);
  assert.match(r.headers['cache-control'], /no-cache/);

  // SSE framing is a data: line then a blank line. Anything else and
  // EventSource sees nothing at all.
  for (const f of r.frames) {
    assert.match(f, /^data: /, 'every frame is a data: line');
    JSON.parse(f.replace(/^data: /, ''));   // throws if the payload is not JSON
  }

  const types = r.frames.map((f) => JSON.parse(f.replace(/^data: /, '')).type);
  assert.strictEqual(types[0], 'pairing_required', 'it asks before doing anything');
  assert.ok(types.includes('error'), 'and reports the refusal rather than hanging');

  const denied = JSON.parse(r.frames[r.frames.length - 1].replace(/^data: /, ''));
  assert.strictEqual(denied.code, 'PAIRING_DENIED');
});

test('a denied spreadsheet is not left paired', async () => {
  const r = await req('GET', '/status');
  assert.ok(!r.json.paired.some((p) => p.spreadsheetId === 'http-test-sheet'),
    'denying must not store the pairing');
});
