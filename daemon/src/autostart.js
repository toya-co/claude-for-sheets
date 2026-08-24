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
 *
 * NO SCRIPT SHIM, deliberately, and this was measured rather than assumed.
 * The first version launched node through a generated .vbs with a hidden
 * window, which is the usual trick for suppressing the console. Windows
 * Defender flagged the resulting command line as Trojan:Win32/Commando.A!ml
 * and blocked it — correctly, because "scheduled task at logon runs a hidden
 * script via wscript" is exactly what a dropper looks like. A setup step that
 * raises a malware alert is worse than no feature, so the task launches
 * node.exe directly and the console window is handled by the task's own logon
 * type instead.
 */

'use strict';

const { execFile } = require('child_process');
const os = require('os');
const path = require('path');

const TASK_NAME = 'ClaudeForSheets';
const DIR = path.join(os.homedir(), '.claude-sheets');
const ENTRY = path.join(__dirname, 'index.js');

/**
 * What the task runs: this node, this entry point, each quoted because
 * "C:\Program Files\nodejs" contains a space.
 */
function taskCommand() {
  return '"' + process.execPath + '" "' + ENTRY + '"';
}

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
 * Turn schtasks' terse refusals into something a person can act on.
 * "ERROR: Access is denied." on its own sends nobody anywhere useful.
 */
function explain(raw) {
  if (/access is denied/i.test(raw)) {
    return 'Windows refused to create the task (access denied). This usually means ' +
           'the app is running under a restricted shell, or your organization blocks ' +
           'scheduled tasks by policy. Try starting the app from a normal terminal, ' +
           'or leave this off and run npm start after a restart.';
  }
  if (/cannot find|does not exist/i.test(raw)) {
    return 'Windows could not find the Task Scheduler service. Leave this off and ' +
           'run npm start after a restart.';
  }
  return raw;
}

/** Promise-wrapped execFile. Never a shell — see the note above. */
function run(exe, args) {
  return new Promise((resolve) => {
    // stdin is closed and a hard timeout applies: schtasks can prompt (for a
    // password, for a confirmation), and a prompt with nobody to answer it
    // would hang the daemon rather than fail.
    execFile(exe, args, { windowsHide: true, timeout: 15000,
                          stdio: ['ignore', 'pipe', 'pipe'] }, (err, stdout, stderr) => {
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
  // Stale means "runs a different copy of this app". Compare on the entry
  // point, which is what actually identifies the install.
  const pointsHere = xml.toLowerCase().includes(ENTRY.toLowerCase());
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

  // /F replaces any existing task, which is what makes re-registering the fix
  // for a stale one. /RL LIMITED keeps it at the user's own rights: this
  // process needs no elevation and asking for it would misstate its scope.
  //
  // No /NP. It looked like the way to get a windowless task — it registers
  // without a stored password, so the task runs non-interactively — but its
  // own help says it "must be combined with either /RU or /XML", and with
  // /RU schtasks can PROMPT for a password on stdin. A prompt would hang this
  // process forever, which is a far worse failure than a visible console
  // window. The windowless route, if it is ever wanted, is an XML task with
  // <LogonType>S4U</LogonType>, which never prompts.
  const res = await exec('schtasks', [
    '/Create', '/TN', TASK_NAME, '/SC', 'ONLOGON',
    '/TR', taskCommand(), '/RL', 'LIMITED', '/F',
  ]);
  if (!res.ok) {
    return { ok: false, error: explain((res.err || res.out || 'schtasks failed').trim()) };
  }
  // An interactive logon task shows a console window when it fires. Say so
  // rather than let the page claim otherwise.
  return { ok: true, windowless: false };
}

async function unregister(exec) {
  exec = exec || run;
  if (!supported()) return { ok: false, error: why() };

  const res = await exec('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']);
  // Deleting something already gone is the desired end state, not a failure.
  if (!res.ok && !/cannot find|does not exist/i.test(res.err + res.out)) {
    return { ok: false, error: (res.err || res.out || 'schtasks failed').trim() };
  }
  return { ok: true };
}

module.exports = {
  TASK_NAME, ENTRY,
  supported, why, status, register, unregister,
  taskCommand,
};
