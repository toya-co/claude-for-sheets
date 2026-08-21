/**
 * Settings validation, and the boundary that decides who may change them.
 *
 * Two things here are security, not preference. `askBefore` governs how much
 * the confirmation gate asks about, and `webAccess` decides whether Claude has
 * an outbound network path at all — so an unrecognized value must land on the
 * STRICT side, and a stray web page must not be able to set either.
 *
 * The store is read-through against a real file, so these run against a temp
 * HOME rather than the developer's own state.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point HOME at a scratch dir BEFORE store.js resolves its path.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sheets-test-'));
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;

const store = require('../src/store');

test.beforeEach(() => {
  try { fs.unlinkSync(store.FILE); } catch { /* first run */ }
});

test('the store writes into the scratch home, not the real one', () => {
  assert.ok(store.FILE.startsWith(TMP), 'guard: ' + store.FILE);
});

// ------------------------------------------------------------- askBefore

test('an unrecognized ask level is clamped to the strictest, not stored', () => {
  for (const bad of ['none', 'never', 'off', 'UNRECOVERABLE', 'unrecoverable ',
                     '', 0, 1, true, null, [], {}]) {
    const saved = store.setSettings({ askBefore: bad });
    assert.strictEqual(saved.askBefore, 'destructive',
      JSON.stringify(bad) + ' must clamp to the strict end');
    assert.strictEqual(store.getSettings().askBefore, 'destructive',
      'and it must be the clamped value that persists');
  }
});

test('both recognized levels round-trip exactly', () => {
  for (const level of store.ASK_LEVELS) {
    assert.strictEqual(store.setSettings({ askBefore: level }).askBefore, level);
    assert.strictEqual(store.getSettings().askBefore, level);
  }
});

test('a relaxed level does not survive a nonsense overwrite', () => {
  store.setSettings({ askBefore: 'unrecoverable' });
  // A later bad write must not leave the relaxed value in place — it resets to
  // strict rather than silently keeping the looser setting.
  assert.strictEqual(store.setSettings({ askBefore: 'whatever' }).askBefore, 'destructive');
});

// -------------------------------------------------------------- the rest

test('webAccess is coerced to a real boolean', () => {
  assert.strictEqual(store.setSettings({ webAccess: false }).webAccess, false);
  assert.strictEqual(store.setSettings({ webAccess: 0 }).webAccess, false);
  assert.strictEqual(store.setSettings({ webAccess: 'yes' }).webAccess, true);
  assert.strictEqual(store.setSettings({ webAccess: true }).webAccess, true);
});

test('an empty or non-string model is ignored rather than stored', () => {
  const before = store.getSettings().model;
  for (const bad of ['', '   ', null, 42, {}]) {
    assert.strictEqual(store.setSettings({ model: bad }).model, before,
      'a blank model would break every turn');
  }
  assert.strictEqual(store.setSettings({ model: '  claude-opus-5  ' }).model,
    'claude-opus-5', 'and a real one is trimmed');
});

test('a patch touches only the keys it names', () => {
  store.setSettings({ model: 'claude-opus-5', webAccess: false, askBefore: 'unrecoverable' });
  const after = store.setSettings({ autostart: true });
  assert.strictEqual(after.model, 'claude-opus-5');
  assert.strictEqual(after.webAccess, false);
  assert.strictEqual(after.askBefore, 'unrecoverable');
  assert.strictEqual(after.autostart, true);
});

test('defaults are strict and web-enabled', () => {
  const s = store.getSettings();
  assert.strictEqual(s.askBefore, 'destructive', 'ask about everything until told otherwise');
  assert.strictEqual(s.webAccess, true, 'on, because the gate is always in front of it');
  assert.strictEqual(s.autostart, false);
});

// ------------------------------------------------- the dashboard boundary

test('every state-changing dashboard route is token-guarded', () => {
  // CORS is `*` and cannot be otherwise, so without this any web page could
  // approve its own pairing, enable web access, or relax the gate. Asserted
  // structurally: each route must consult fromDashboard before it acts.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  const guarded = ['POST /pair', 'POST /settings', 'POST /instructions',
                   'POST /reset', 'POST /unpair', 'POST /quit'];
  for (const route of guarded) {
    const at = src.indexOf("case '" + route + "'");
    assert.ok(at !== -1, route + ' exists');
    const body = src.slice(at, src.indexOf('case ', at + 10));
    assert.ok(/fromDashboard\(req, body\)/.test(body), route + ' checks the token');
  }
});

test('the dashboard token is never handed out over a CORS-readable route', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  // GET / carries the token; it must not also send CORS headers, or a hostile
  // page could simply read it and then drive every guarded route above.
  const at = src.indexOf("case 'GET /':");
  const body = src.slice(at, src.indexOf('case ', at + 10));
  assert.ok(/dashboard\.page\(DASH_TOKEN\)/.test(body), 'the token rides in the page');
  assert.ok(!/cors\(res\)/.test(body), 'and that route must not be CORS-readable');

  // It must never appear in /status either, which IS readable by any page.
  const st = src.indexOf("case 'GET /status'");
  const stBody = src.slice(st, src.indexOf('case ', st + 10));
  assert.ok(!/DASH_TOKEN/.test(stBody), '/status must not leak the token');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });
