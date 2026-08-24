/**
 * Start at login.
 *
 * The command construction is tested against an injected runner rather than a
 * real `schtasks`: creating a scheduled task is a persistent change to the
 * developer's machine, and a test suite has no business making one. What can
 * be checked without touching the OS is everything that has actually gone
 * wrong in this codebase before — argv shape, shell avoidance, and a status
 * that reports reality rather than a cached wish.
 *
 * The one thing no unit test can prove is that the task fires at logon. That
 * is a reboot, and it is recorded as a manual step.
 */

const test = require('node:test');
const assert = require('node:assert');
const autostart = require('../src/autostart');

/** Records what would have been run, and answers with whatever is scripted. */
function fakeExec(reply) {
  const calls = [];
  const fn = async (exe, args) => {
    calls.push({ exe, args });
    return typeof reply === 'function' ? reply(exe, args) : (reply || { ok: true, out: '', err: '' });
  };
  fn.calls = calls;
  return fn;
}

const XML_HERE = () => ({
  ok: true,
  out: '<Task><Actions><Exec><Command>node.exe</Command>' +
       '<Arguments>' + autostart.taskCommand() + '</Arguments></Exec></Actions></Task>',
  err: '',
});
const XML_ELSEWHERE = {
  ok: true,
  out: '<Task><Actions><Exec><Command>wscript.exe</Command>' +
       '<Arguments>"C:\\Old\\Checkout\\start-hidden.vbs"</Arguments></Exec></Actions></Task>',
  err: '',
};
const NOT_FOUND = { ok: false, code: 1, out: '', err: 'ERROR: The system cannot find the file specified.' };

const onWindows = process.platform === 'win32';

// ----------------------------------------------------- no script shim, ever

test('the task runs node directly, with no script interpreter', () => {
  // Measured, not assumed: launching node through a generated .vbs with a
  // hidden window got the command line flagged by Windows Defender as
  // Trojan:Win32/Commando.A!ml and blocked. "Scheduled task at logon runs a
  // hidden script via wscript" is what a dropper looks like, and a setup step
  // that raises a malware alert is worse than not having the feature.
  const cmd = autostart.taskCommand();
  assert.ok(cmd.includes(process.execPath), 'it launches this exact node');
  assert.ok(cmd.includes(autostart.ENTRY), 'and this exact entry point');
  for (const shim of ['wscript', 'cscript', '.vbs', 'powershell', 'mshta', 'rundll32']) {
    assert.ok(!cmd.toLowerCase().includes(shim), 'no ' + shim + ' in the command');
  }
});

test('the source carries no script-shim machinery at all', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'autostart.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '');   // comments explain it; code must not do it
  assert.ok(!/\.vbs|WScript\.Shell|wscript/i.test(code),
    'a shim must not creep back in — it is an antivirus detection, not a style choice');
});

test('both paths are quoted, since Program Files has a space', () => {
  const cmd = autostart.taskCommand();
  assert.match(cmd, /^"[^"]+node\.exe" "[^"]+index\.js"$/,
    'unquoted, the space in the node path would split the command');
});

// --------------------------------------------------------------- registering

test('register creates a per-user logon task at the user\'s own rights', { skip: !onWindows }, async () => {
  const exec = fakeExec({ ok: true });
  const res = await autostart.register(exec);
  assert.strictEqual(res.ok, true);

  const { exe, args } = exec.calls[0];
  assert.strictEqual(exe, 'schtasks');
  assert.strictEqual(args[args.indexOf('/SC') + 1], 'ONLOGON', 'fires at logon');
  assert.strictEqual(args[args.indexOf('/TN') + 1], autostart.TASK_NAME);
  assert.strictEqual(args[args.indexOf('/RL') + 1], 'LIMITED',
    'no elevation — this process needs none, and asking would misstate its scope');
  assert.ok(args.includes('/F'), '/F replaces a stale task, which is how repointing works');
  assert.strictEqual(args[args.indexOf('/TR') + 1], autostart.taskCommand(),
    'it runs node directly');
});

test('every argument is its own argv element, never a command line', { skip: !onWindows }, async () => {
  // Paths here come from the filesystem rather than a user, but the rule holds
  // everywhere in this codebase: nothing is handed to a shell to re-parse.
  const exec = fakeExec({ ok: true });
  await autostart.register(exec);
  const { args } = exec.calls[0];
  assert.ok(Array.isArray(args));
  assert.ok(args.every((a) => typeof a === 'string'));
  assert.ok(!args.some((a) => a.includes('&&') || a.includes('|')),
    'nothing that would mean something to a shell');
});

test('it tries the windowless task first, then falls back', { skip: !onWindows }, async () => {
  // /NP registers without a stored password, which runs with a
  // non-interactive token and therefore shows no console window. Not every
  // machine allows it, so a refusal falls back to the plain interactive task
  // -- which works everywhere and does show a window. The caller is told
  // which one it got.
  let first = true;
  const exec = fakeExec(() => {
    if (first) { first = false; return { ok: false, err: 'ERROR: cannot use /NP' }; }
    return { ok: true };
  });
  const res = await autostart.register(exec);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.windowless, false, 'and it says the window will appear');
  assert.ok(exec.calls[0].args.includes('/NP'), 'windowless was attempted first');
  assert.ok(!exec.calls[1].args.includes('/NP'), 'the fallback drops it');
});

test('a windowless registration reports itself as such', { skip: !onWindows }, async () => {
  const res = await autostart.register(fakeExec({ ok: true }));
  assert.strictEqual(res.windowless, true);
});

test('a refused registration is reported, not swallowed', { skip: !onWindows }, async () => {
  // Both attempts refused — the real reason must reach the dashboard.
  const exec = fakeExec({ ok: false, code: 1, out: '', err: 'ERROR: Access is denied.' });
  const res = await autostart.register(exec);
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /Access is denied/,
    'the real reason must survive to the dashboard');
});

// ------------------------------------------------------------- unregistering

test('unregister deletes without prompting', { skip: !onWindows }, async () => {
  const exec = fakeExec({ ok: true });
  const res = await autostart.unregister(exec);
  assert.strictEqual(res.ok, true);
  const { args } = exec.calls[0];
  assert.ok(args.includes('/Delete') && args.includes('/F'));
  assert.strictEqual(args[args.indexOf('/TN') + 1], autostart.TASK_NAME);
});

test('deleting a task that is already gone is success, not failure', { skip: !onWindows }, async () => {
  const res = await autostart.unregister(fakeExec(NOT_FOUND));
  assert.strictEqual(res.ok, true,
    'the desired end state is "no task", and there is no task');
});

// -------------------------------------------------------------- reading state

test('status asks the OS, and says nothing when there is no task', { skip: !onWindows }, async () => {
  const exec = fakeExec(NOT_FOUND);
  const s = await autostart.status(exec);
  assert.deepStrictEqual(
    { registered: s.registered, stale: s.stale },
    { registered: false, stale: false });
  assert.ok(exec.calls[0].args.includes('/Query'), 'it actually queried');
});

test('a task pointing at this install reads as on', { skip: !onWindows }, async () => {
  const s = await autostart.status(fakeExec(XML_HERE()));
  assert.strictEqual(s.registered, true);
  assert.strictEqual(s.stale, false);
});

test('a task left behind by a different copy reads as stale, not as on', { skip: !onWindows }, async () => {
  // "A task with our name exists" is not "autostart works". Moving the folder
  // leaves a task launching a path that no longer exists, and reporting that
  // as On would be the dashboard lying about something it can check.
  const s = await autostart.status(fakeExec(XML_ELSEWHERE));
  assert.strictEqual(s.registered, true);
  assert.strictEqual(s.stale, true, 'points somewhere else');
});

test('status survives the UTF-16 NULs schtasks emits', { skip: !onWindows }, async () => {
  const noisy = XML_HERE();
  noisy.out = '\ufeff' + noisy.out.split('').join('\0');
  const s = await autostart.status(fakeExec(noisy));
  assert.strictEqual(s.stale, false, 'a BOM and interleaved NULs must not read as stale');
});

// ------------------------------------------------------------- other platforms

test('an unsupported platform says so instead of pretending', () => {
  if (onWindows) {
    assert.strictEqual(autostart.why(), null, 'supported here');
    return;
  }
  assert.strictEqual(autostart.supported(), false);
  assert.match(autostart.why(), /npm start/,
    'and tells the user what to do meanwhile');
});

test('an unsupported platform never claims to have registered anything', async () => {
  if (onWindows) return;
  assert.strictEqual((await autostart.register()).ok, false);
  assert.strictEqual((await autostart.status()).registered, false);
});
