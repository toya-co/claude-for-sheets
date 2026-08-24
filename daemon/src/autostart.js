/**
 * Start at login (ARCHITECTURE.md §6, Lifecycle).
 *
 * A per-user scheduled task on Windows. No admin rights, no installer service,
 * no tray app, no bundled runtime — which keeps the "two halves, both open
 * source, nothing hosted" shape intact.
 *
 * Two things this module refuses to do, both learned from how the rest of this
 * project fails:
 *
 * 1. **It never trusts the stored setting.** Whether the task exists is a
 *    question about the operating system, so it asks the operating system.
 *    Someone can delete the task in Task Scheduler and a cached `true` would
 *    keep insisting autostart is on. The store's value is a preference; this
 *    module reports reality.
 *
 * 2. **It checks the task still points HERE.** A task registered from one
 *    checkout keeps running that path after the folder moves or is deleted, so
 *    "a task with our name exists" is not the same as "autostart works". The
 *    task is read back and compared against this install.
 *
 * Every command goes through execFile with shell:false. Paths reach it from the
 * filesystem rather than from a user, but the rule holds everywhere in this
 * codebase and a path with a space or an ampersand should never be a bug.
 */

'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TASK_NAME = 'ClaudeForSheets';
const DIR = path.join(os.homedir(), '.claude-sheets');
const LAUNCHER = path.join(DIR, 'start-hidden.vbs');
const ENTRY = path.join(__dirname, 'index.js');

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

/** Promise-wrapped execFile. Never a shell — see the note above. */
function run(exe, args) {
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (err.code === undefined ? 1 : err.code) : 0,
        out: String(stdout || ''),
        err: String(stderr || (err && err.message) || ''),
      });
    });
  });
}

/**
 * A VBScript shim, because a scheduled task running node.exe directly pops a
 * console window at every login — which nobody would tolerate and which would
 * make the whole feature worse than doing nothing. WScript.Shell.Run with a
 * window style of 0 starts it genuinely hidden.
 *
 * Regenerated on every register so the baked paths always match this install.
 */
function launcherSource() {
  const q = (s) => '""' + String(s).replace(/"/g, '') + '""';
  return 'Set s = CreateObject("WScript.Shell")\r\n' +
         's.Run "' + q(process.execPath) + ' ' + q(ENTRY) + '", 0, False\r\n';
}

function writeLauncher() {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(LAUNCHER, launcherSource(), 'utf8');
}

/**
 * What the OS actually has.
 *
 * `stale` is the interesting state: a task exists under our name but runs a
 * different path — an old checkout, usually. Reported separately from "off"
 * because the fix differs: off needs turning on, stale needs re-registering.
 */
async function status(exec) {
  exec = exec || run;
  if (!supported()) {
    return { supported: false, registered: false, stale: false, reason: why() };
  }

  const res = await exec('schtasks', ['/Query', '/TN', TASK_NAME, '/XML', 'ONE']);
  if (!res.ok) {
    return { supported: true, registered: false, stale: false, taskName: TASK_NAME };
  }

  // The XML is UTF-16 from schtasks; Node has already decoded it to a string,
  // but a stray BOM or NULs can survive. Compare on a normalized copy.
  const xml = res.out.replace(/\0/g, '');
  const pointsHere = xml.toLowerCase().includes(LAUNCHER.toLowerCase());
  return {
    supported: true,
    registered: true,
    stale: !pointsHere,
    taskName: TASK_NAME,
    command: (/<Command>([^<]*)<\/Command>/i.exec(xml) || [])[1] || null,
  };
}

async function register(exec) {
  exec = exec || run;
  if (!supported()) return { ok: false, error: why() };

  try {
    writeLauncher();
  } catch (e) {
    return { ok: false, error: 'Could not write the launcher: ' + e.message };
  }

  // /F replaces any existing task, which is what makes re-registering the fix
  // for a stale one. /RL LIMITED keeps it at the user's own rights: this
  // process needs no elevation and asking for it would be a lie about scope.
  const res = await exec('schtasks', [
    '/Create', '/TN', TASK_NAME, '/SC', 'ONLOGON',
    '/TR', 'wscript.exe "' + LAUNCHER + '"',
    '/RL', 'LIMITED', '/F',
  ]);
  if (!res.ok) {
    return { ok: false, error: (res.err || res.out || 'schtasks failed').trim() };
  }
  return { ok: true };
}

async function unregister(exec) {
  exec = exec || run;
  if (!supported()) return { ok: false, error: why() };

  const res = await exec('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']);
  // Deleting something already gone is the desired end state, not a failure.
  if (!res.ok && !/cannot find|does not exist/i.test(res.err + res.out)) {
    return { ok: false, error: (res.err || res.out || 'schtasks failed').trim() };
  }
  try { fs.unlinkSync(LAUNCHER); } catch { /* already gone */ }
  return { ok: true };
}

module.exports = {
  TASK_NAME, LAUNCHER, ENTRY,
  supported, why, status, register, unregister,
  launcherSource,
};
