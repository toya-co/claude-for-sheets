/**
 * Stopping a turn.
 *
 * The sidebar's Stop button aborts its fetch; the daemon reads the closed
 * stream as the end of the turn and kills the CLI. These tests cover the half
 * that owns the process — that a stop actually ends it, that it is reported as
 * a stop rather than a failure, and that it never turns into a second run.
 *
 * They spawn `fixtures/fake-cli.js` through the `opts.cli` seam: the behaviour
 * under test only exists while a real child process is alive, which no recorded
 * transcript can provide.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const claude = require('../src/claude');

const FAKE = [process.execPath, path.join(__dirname, 'fixtures', 'fake-cli.js')];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-stop-'));

/** Start a turn and hand back its promise plus the control handle. */
function startTurn(opts = {}) {
  const events = [];
  const control = {};
  const done = claude.runTurn('hello', (ev) => events.push(ev),
    { cli: FAKE, cwd: TMP, control, ...opts });
  return { done, control, events };
}

/** control.stop is assigned at spawn, which is a tick or two away. */
async function whenReady(control) {
  for (let i = 0; i < 100; i++) {
    if (control.stop) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('the turn never spawned');
}

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

test('stopping a running turn ends it, and says so', async () => {
  const { done, control } = startTurn();
  await whenReady(control);

  control.stop();
  const result = await done;

  assert.equal(result.stopped, true);
  assert.equal(result.ok, false, 'a stopped turn did not succeed');
});

test('a stopped turn resolves rather than hanging on its child', async () => {
  const { done, control } = startTurn();
  await whenReady(control);
  control.stop();

  // The fake CLI never exits on its own, so a promise that settles at all is
  // proof the process was killed rather than merely abandoned.
  const settled = await Promise.race([
    done.then(() => 'settled'),
    new Promise((r) => setTimeout(() => r('hung'), 5000)),
  ]);
  assert.equal(settled, 'settled');
});

test('stopping emits no error to the sidebar', async () => {
  const { done, control, events } = startTurn();
  await whenReady(control);
  control.stop();
  await done;

  assert.equal(events.filter((e) => e.type === 'error').length, 0,
    'a deliberate stop must not look like a failure');
  assert.equal(events.filter((e) => e.type === 'done').length, 0,
    'the turn did not finish, so nothing should claim it did');
});

test('the session that opened survives a stop, so the chat can continue', async () => {
  const { done, control } = startTurn({ sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' });
  await whenReady(control);
  control.stop();
  const result = await done;

  assert.ok(result.sessionId, 'a stopped turn still reports its session');
});

test('stopping a resume does not start a second session', async () => {
  // The trap this pins out: killing a resumed turn before its session opens is
  // indistinguishable from the stored session being gone, and runTurn answers a
  // lost session by starting a fresh one. Stop would spawn what it was ending.
  const log = path.join(TMP, 'spawns.log');
  fs.writeFileSync(log, '');

  const { done, control } = startTurn({
    sessionId: 'bbbbbbbb-0000-4000-8000-000000000002',
    resume: true,
    env: { FAKE_CLI_LOG: log, FAKE_CLI_SILENT: '1' },   // alive, but never opens
  });
  await whenReady(control);
  // A silent CLI gives no output to wait on, so wait for its own log line —
  // otherwise the kill can land before the process is up, and a retry that
  // never happened looks the same as one that did.
  for (let i = 0; i < 200 && !fs.readFileSync(log, 'utf8').trim(); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  control.stop();
  const result = await done;

  assert.equal(result.stopped, true);
  assert.equal(result.sessionLost, undefined, 'a stop is not a lost session');

  const spawns = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  assert.equal(spawns.length, 1, `stop spawned ${spawns.length} processes, expected 1`);
});

test('stop is idempotent, and safe after the turn is already over', async () => {
  const { done, control } = startTurn();
  await whenReady(control);

  control.stop();
  await done;
  assert.doesNotThrow(() => { control.stop(); control.stop(); });
});
