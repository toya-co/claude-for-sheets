/**
 * Start at login.
 *
 * Three mechanisms were tried before this one, and each failure is pinned by a
 * test here so it cannot be reintroduced by someone who does not know the
 * history:
 *
 *   1. A scheduled task — needs elevation for a logon trigger, and this app
 *      must never ask for admin.
 *   2. A hidden .vbs shim — Windows Defender flagged the command line as
 *      Trojan:Win32/Commando.A!ml and blocked it. Correctly.
 *   3. A registry Run key — works, but invisible to a user who wants it gone.
 *
 * What remains is a file in the Startup folder, which needs no privilege, no
 * interpreter, and no explanation beyond "delete it".
 *
 * Real files are written, into a temp HOME rather than the developer's own
 * Startup folder, so the suite never leaves something that runs at login.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-autostart-'));
process.env.APPDATA = TMP;

const autostart = require('../src/autostart');
const onWindows = process.platform === 'win32';

test.beforeEach(() => { try { fs.unlinkSync(autostart.scriptPath()); } catch {} });
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

// ------------------------------------------------------- never again, part 1

test('it needs no elevation: no scheduled task, no schtasks', () => {
  // schtasks /Create /SC ONLOGON writes to the root task folder, which a
  // UAC-filtered token cannot do. It fails with "Access is denied" from a
  // normal shell even for a user who can create the same task through the
  // Task Scheduler GUI, because the GUI elevates.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'autostart.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/schtasks/i.test(code), 'scheduled tasks require admin — never go back');
  assert.ok(!/execFile|spawn|exec\(/.test(code),
    'this writes a file; it should not be running processes at all');
});

test('it runs no script interpreter, because Defender flags that', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'autostart.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const shim of ['wscript', 'cscript', '.vbs', 'mshta', 'rundll32']) {
    assert.ok(!new RegExp(shim, 'i').test(code), 'no ' + shim + ' — it is an AV detection');
  }
});

test('it stays out of the registry, where a user cannot find it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'autostart.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/HKCU|HKEY|reg add|winreg/i.test(code),
    'a Run key is invisible; the Startup folder is somewhere people look');
});

// ------------------------------------------------------------- the script

test('the launcher is quoted and minimized, and start gets a real title',
  { skip: !onWindows }, () => {
  const cmd = autostart.scriptSource();
  // `start` reads a leading quoted string as the WINDOW TITLE, so
  // start "C:\path\node.exe" opens an empty console named after the path and
  // runs nothing. The title argument is what makes the command work at all.
  assert.match(cmd, /start "[^"]+" \/min "/,
    'title first, then /min, then the quoted executable');
  assert.ok(cmd.includes(process.execPath), 'launches this exact node');
  assert.ok(cmd.includes(autostart.ENTRY), 'and this exact entry point');
  assert.match(cmd, /\r\n/, 'CRLF — it is a batch file');
  assert.match(cmd, /Delete this file/i, 'and it says how to undo itself');
});

test('the file lives where Windows actually looks', { skip: !onWindows }, () => {
  // From APPDATA rather than a hardcoded path: it moves under a roaming
  // profile and the folder names are localized on non-English Windows.
  assert.ok(autostart.startupDir().startsWith(TMP),
    'honours APPDATA: ' + autostart.startupDir());
  assert.match(autostart.scriptPath(), /Startup[\\/][^\\/]+\.cmd$/);
});

// ------------------------------------------------------- register / status

test('register writes the file, and status reads it back', { skip: !onWindows }, async () => {
  assert.strictEqual((await autostart.status()).registered, false, 'nothing yet');

  const res = await autostart.register();
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.windowless, false,
    'minimized, not hidden — the page must not claim silence');
  assert.ok(fs.existsSync(autostart.scriptPath()), 'the file is really there');

  const after = await autostart.status();
  assert.strictEqual(after.registered, true);
  assert.strictEqual(after.stale, false);
});

test('status reports the file on disk, not a remembered preference',
  { skip: !onWindows }, async () => {
  // Deleting the file in Explorer is the documented way to turn this off, so
  // a cached true would keep claiming autostart is on after the user removed it.
  await autostart.register();
  fs.unlinkSync(autostart.scriptPath());
  assert.strictEqual((await autostart.status()).registered, false,
    'the filesystem is the source of truth');
});

test('a file left by a different copy reads as stale, not as on',
  { skip: !onWindows }, async () => {
  fs.mkdirSync(autostart.startupDir(), { recursive: true });
  fs.writeFileSync(autostart.scriptPath(),
    '@echo off\r\nstart "x" /min "node.exe" "C:\\Old\\Checkout\\index.js"\r\n');
  const s = await autostart.status();
  assert.strictEqual(s.registered, true);
  assert.strictEqual(s.stale, true, 'it launches something else entirely');
});

test('re-registering repoints a stale file', { skip: !onWindows }, async () => {
  fs.mkdirSync(autostart.startupDir(), { recursive: true });
  fs.writeFileSync(autostart.scriptPath(), 'old junk');
  await autostart.register();
  assert.strictEqual((await autostart.status()).stale, false);
});

// -------------------------------------------------------------- unregister

test('unregister removes the file', { skip: !onWindows }, async () => {
  await autostart.register();
  assert.strictEqual((await autostart.unregister()).ok, true);
  assert.ok(!fs.existsSync(autostart.scriptPath()));
});

test('unregistering something already gone is success', { skip: !onWindows }, async () => {
  const res = await autostart.unregister();
  assert.strictEqual(res.ok, true, 'the desired end state is "no file", and there is none');
});

// ------------------------------------------------------------ other platforms

test('an unsupported platform says so instead of pretending', () => {
  if (onWindows) {
    assert.strictEqual(autostart.why(), null);
    return;
  }
  assert.strictEqual(autostart.supported(), false);
  assert.match(autostart.why(), /npm start/, 'and says what to do meanwhile');
});

test('an unsupported platform never claims to have registered anything', async () => {
  if (onWindows) return;
  assert.strictEqual((await autostart.register()).ok, false);
  assert.strictEqual((await autostart.status()).registered, false);
});
