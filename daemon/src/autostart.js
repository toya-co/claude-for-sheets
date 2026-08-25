/**
 * Start at login.
 *
 * A single .cmd file in the user's Startup folder. That is the whole
 * mechanism, and the alternatives were each rejected on evidence rather than
 * taste:
 *
 * **A scheduled task needs admin.** `schtasks /Create /SC ONLOGON` writes to
 * the root task folder, which a UAC-filtered token cannot do — it fails with
 * "Access is denied" from a normal shell even though the same user can create
 * the same task through the Task Scheduler GUI, because the GUI elevates.
 * This app must never ask for admin, so scheduled tasks are out.
 *
 * **A hidden script shim is malware-shaped.** The first attempt launched node
 * through a generated .vbs with a hidden window. Windows Defender flagged the
 * command line as Trojan:Win32/Commando.A!ml and blocked it, correctly:
 * "runs a hidden script at logon" is what a dropper does. A setup step that
 * raises a malware alert is worse than not having the feature.
 *
 * **A registry Run key is invisible.** It needs no admin, but a user who wants
 * it gone has to know to open regedit. The Startup folder is somewhere people
 * already know how to look, and deleting the file is a complete uninstall.
 *
 * So: a plain file, in a documented place, starting node minimized. The window
 * is deliberate. It is visible proof the app is running and closing it stops
 * the app — most of what a tray icon would have given, without a GUI framework.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ENTRY = path.join(__dirname, 'index.js');
const FILE_NAME = 'Claude for Sheets.cmd';

/** Only Windows for now; macOS and Linux land with the packaged builds. */
function supported() {
  return process.platform === 'win32';
}

function why() {
  if (supported()) return null;
  return process.platform === 'darwin'
    ? 'Start at login needs the packaged macOS build (a LaunchAgent). Until then, run npm start.'
    : 'Start at login needs the packaged build for this platform. Until then, run npm start.';
}

/**
 * The per-user Startup folder.
 *
 * From APPDATA rather than a hardcoded path: it moves under a roaming profile,
 * and the folder names are localized on a non-English Windows. The literal
 * path is only a fallback for a missing variable.
 */
function startupDir() {
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function scriptPath() {
  return path.join(startupDir(), FILE_NAME);
}

/**
 * `start "<title>" /min` launches node in its own minimized window and lets
 * the cmd shell exit immediately, so nothing lingers but the app.
 *
 * The title argument is not optional decoration: `start` treats a leading
 * quoted string as the window title, so `start "C:\path\node.exe"` opens an
 * empty console titled with the path and never runs anything. Giving it a real
 * title is what makes the command work at all.
 */
function scriptSource() {
  return '@echo off\r\n' +
         'rem Claude for Sheets — starts the local app at login.\r\n' +
         'rem Delete this file to stop it starting automatically.\r\n' +
         'start "Claude for Sheets" /min "' + process.execPath + '" "' + ENTRY + '"\r\n';
}

/**
 * What is actually on disk — never the stored preference.
 *
 * Deleting the file in Explorer is the documented way to turn this off, so a
 * cached `true` would go on claiming autostart is on after the user had
 * already removed it. `stale` means a file exists but launches a different
 * copy of the app; it is reported separately from off because the fix differs.
 */
async function status() {
  if (!supported()) {
    return { supported: false, registered: false, stale: false, reason: why() };
  }
  const file = scriptPath();
  let body;
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch {
    return { supported: true, registered: false, stale: false, path: file };
  }
  return { supported: true, registered: true, stale: !body.includes(ENTRY), path: file };
}

async function register() {
  if (!supported()) return { ok: false, error: why() };
  try {
    fs.mkdirSync(startupDir(), { recursive: true });
    fs.writeFileSync(scriptPath(), scriptSource(), 'utf8');
  } catch (e) {
    return { ok: false, error: explain(e) };
  }
  // Minimized, not hidden — the page should say so rather than claim silence.
  return { ok: true, windowless: false };
}

async function unregister() {
  if (!supported()) return { ok: false, error: why() };
  try {
    fs.unlinkSync(scriptPath());
  } catch (e) {
    // Already gone is the desired end state, not a failure.
    if (e.code !== 'ENOENT') return { ok: false, error: explain(e) };
  }
  return { ok: true };
}

/** Turn a filesystem error into something a person can act on. */
function explain(e) {
  if (e && e.code === 'EACCES') {
    return 'Windows refused to write to your Startup folder — your organization may ' +
           'block it by policy. Leave this off and run npm start after a restart.';
  }
  if (e && e.code === 'ENOENT') {
    return 'Could not find your Startup folder. Leave this off and run npm start ' +
           'after a restart.';
  }
  return 'Could not write the startup file: ' + ((e && e.message) || String(e));
}

module.exports = {
  ENTRY, FILE_NAME,
  supported, why, status, register, unregister,
  startupDir, scriptPath, scriptSource,
};
