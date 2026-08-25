#!/usr/bin/env node
/**
 * Release preflight — Tier 2 and Tier 3 of the regression suite
 * (`experiments/README.md`).
 *
 * The suite splits in two and the split is not a shortcoming to engineer away:
 * some of this product rests on behavior only observable in a browser signed
 * into a Google account, and one check needs a literal Ctrl+Z keystroke inside
 * the Sheets UI. No harness reaches those.
 *
 * So this script does everything around the observation and nothing else. It
 * runs what can run unattended, records the environment a future regression
 * will need to be correlated against, and prints a checklist where every step
 * states the output you should actually see — because "check it works" is not
 * a test, and a checklist without expected output silently becomes one.
 *
 *   npm run check              environment, automated checks, checklist
 *   npm run check -- --record  append the outcome to the release log
 *
 * Zero dependencies, like everything else here.
 */

'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LOG = path.join(ROOT, 'experiments', 'release-log.md');
const PORT = Number(process.env.PORT || 8443);

const bold = (s) => '[1m' + s + '[0m';
const dim = (s) => '[2m' + s + '[0m';
const green = (s) => '[32m' + s + '[0m';
const red = (s) => '[31m' + s + '[0m';
const yellow = (s) => '[33m' + s + '[0m';

const results = [];
function record(ok, label, detail) {
  results.push({ ok, label, detail });
  const mark = ok === true ? green('  ok  ') : ok === false ? red(' FAIL ') : yellow(' warn ');
  console.log(mark + label + (detail ? dim('  ' + detail) : ''));
}

function tryExec(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- environment

/**
 * What a future regression will need to be correlated against. When something
 * that worked stops working, the answer is almost always that one of these
 * moved — and without the record you cannot tell which.
 */
function environment() {
  const claude = tryExec(process.platform === 'win32' ? 'where' : 'which', ['claude']);
  const claudeVersion = claude ? tryExec(claude.split(/\r?\n/)[0], ['--version']) : null;
  let cert = null;
  try {
    const pem = path.join(ROOT, 'daemon', 'certs', 'cert.pem');
    const out = tryExec('openssl', ['x509', '-enddate', '-noout', '-in', pem]);
    if (out) cert = out.replace('notAfter=', '').trim();
  } catch { /* openssl may be absent */ }

  return {
    date: new Date().toISOString().slice(0, 10),
    os: os.platform() + ' ' + os.release(),
    node: process.version,
    claudeCode: claudeVersion || 'NOT FOUND',
    app: require(path.join(ROOT, 'daemon', 'package.json')).version,
    clasp: tryExec('npx', ['clasp', '--version']) || 'not installed',
    certExpires: cert || 'unknown',
    // Filled in by hand — no reliable way to read the browser from here, and
    // the sidebar is a browser surface, so it matters.
    chrome: process.env.CHROME_VERSION || '(fill in)',
  };
}

// -------------------------------------------------------------- automated

function daemonStatus() {
  return new Promise((resolve) => {
    const req = https.request({
      host: '127.0.0.1', port: PORT, path: '/status', method: 'GET',
      rejectUnauthorized: false, timeout: 4000,
    }, (res) => {
      let raw = '';
      res.on('data', (d) => { raw += d; });
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function automated() {
  console.log('\n' + bold('Automated') + dim('  — everything that needs no browser'));

  // Node refuses to spawn .cmd files on Windows (EINVAL, the batch-argument
  // injection fix), so npm is never invoked here. Run the test files directly
  // and build the bundle in-process -- fewer moving parts, and faster.
  const testFiles = [];
  for (const dir of [path.join(ROOT, 'daemon', 'test'), path.join(ROOT, 'addon', 'test')]) {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.test.js')) testFiles.push(path.join(dir, f));
    }
  }
  const tests = spawnSync(process.execPath, ['--test'].concat(testFiles),
    { cwd: ROOT, encoding: 'utf8' });
  const out = (tests.stdout || '') + (tests.stderr || '');
  const pass = /pass ([0-9]+)/.exec(out);
  const fail = /fail ([0-9]+)/.exec(out);
  const failing = fail && fail[1] !== '0';
  record(tests.status === 0 && !failing, 'test suite',
    pass ? pass[1] + ' passing' + (failing ? ', ' + fail[1] + ' FAILING' : '') : 'could not run');

  // The committed bundle is what people paste; if it drifted they install an
  // older add-on than the repo describes, and nothing says so.
  let bundleOk = true;
  try { require(path.join(ROOT, 'addon', 'bundle')).build(); }
  catch (e) { bundleOk = false; }
  const dirty = tryExec('git', ['status', '--porcelain', 'addon/dist/Claude.gs']);
  record(bundleOk && !dirty, 'paste bundle up to date',
    dirty ? 'run npm run bundle and commit' : 'addon/dist/Claude.gs');

  const status = await daemonStatus();
  record(Boolean(status), 'local app answering', status ? 'port ' + PORT : 'start it with npm start');

  if (status) {
    record(status.cli.available, 'Claude Code credential',
      status.cli.available ? status.cli.version : 'run `claude` once and sign in');
    record(status.autostart.supported ? status.autostart.registered : null,
      'start at login',
      status.autostart.registered
        ? (status.autostart.stale ? 'STALE — points at another copy' : 'registered')
        : 'off');
    record(status.settings.askBefore === 'destructive', 'confirmation gate at default',
      status.settings.askBefore);
  }
  return status;
}

// ----------------------------------------------------------------- manual

/**
 * Each step names what to do and what you should SEE. A checklist whose steps
 * say "verify it works" degrades into clicking through and ticking boxes; one
 * that states the expected output makes a wrong result impossible to miss.
 */
const MANUAL = [
  ['Sidebar opens',
   'In a paired sheet: Claude ▸ Open sidebar',
   'The panel opens and the status dot is green with "local app connected".'],

  ['The loopback hop still works',
   'Watch the status line when the sidebar loads',
   'Green, not "local app not running". If red, the browser has not accepted the certificate — open https://localhost:' + PORT + '/ once in THAT browser profile.'],

  ['A real turn edits the sheet',
   'Ask: "put the sum of B2:B5 in B6"',
   'A "reading" card, then "set formulas in Sheet1!B6", then the cell holds =SUM(B2:B5) — a formula, not a number.'],

  ['Conversation carries',
   'Follow up with: "now make it bold"',
   'It bolds B6 without asking which cell. If it asks, session reuse broke.'],

  ['The confirmation gate stops a destructive edit',
   'Ask it to clear a range holding data',
   'A yellow card: "Claude wants to clear N cells that hold content", with Do it / Skip. Nothing changes until you click.'],

  ['Skip is respected',
   'Click Skip',
   'The card reads "skipped", the cells are untouched, and Claude moves on rather than retrying.'],

  ['Undo restores exactly',
   'Click Undo on a completed edit card',
   'The prior values, formulas AND formatting come back — not just values.'],

  ['Claude\'s edits stay out of your Ctrl+Z',
   'After a Claude edit, press Ctrl+Z in the Sheets UI',
   'It undoes YOUR last edit, never Claude\'s. This is the openById guarantee and the reason the broad scope is taken; if it fails, the undo model is broken.'],

  ['A human edit mid-turn aborts the write',
   'Ask for an edit, then type in a nearby cell before it lands',
   '"Paused — the sheet changed." Nothing is overwritten, and Claude re-reads and completes.'],

  ['The web gate asks before anything leaves',
   'Ask it to fetch a page (web access must be on)',
   'A card showing the FULL url including query string, with Allow / Skip. Nothing is fetched until you click.'],

  ['A local address is refused without asking',
   'Ask it to fetch https://127.0.0.1:' + PORT + '/status',
   'No approval card at all — it is refused outright and Claude reports it. If a card appears for this, the SSRF check regressed.'],

  ['The dashboard reflects reality',
   'Open https://localhost:' + PORT + '/ and check Activity',
   'The turns above appear, newest first, and most say "resumed".'],
];

function manual() {
  console.log('\n' + bold('Manual') + dim('  — needs a browser signed into Google, ~3 minutes'));
  MANUAL.forEach(([title, action, expect], i) => {
    console.log('\n' + bold(String(i + 1).padStart(2) + '. ' + title));
    console.log('    do    ' + action);
    console.log('    see   ' + dim(expect));
  });
}

// ------------------------------------------------------------------ record

function appendLog(env, outcome, note) {
  const rows = Object.entries(env).map(([k, v]) => '| ' + k + ' | `' + v + '` |').join('\n');
  const entry = [
    '## ' + env.date + ' — ' + outcome,
    '',
    note ? note + '\n' : '',
    '| | |',
    '|---|---|',
    rows,
    '',
    '---',
    '',
  ].join('\n');

  let body;
  try {
    body = fs.readFileSync(LOG, 'utf8');
  } catch {
    body = ['# Release log', '',
      'Every tagged release runs `npm run check` and records the outcome here,',
      '**newest first**, with the environment it ran against. When something that',
      'worked stops working, the cause is usually that one of these moved — and',
      'without the record there is no way to tell which.', '', '---', '', ''].join('\n');
  }
  // Newest first, per the project convention for dated logs.
  const at = body.indexOf('---\n\n') + 5;
  fs.writeFileSync(LOG, body.slice(0, at) + entry + body.slice(at), 'utf8');
  return LOG;
}

// -------------------------------------------------------------------- main

(async () => {
  const env = environment();

  console.log('\n' + bold('Environment'));
  for (const [k, v] of Object.entries(env)) {
    console.log('  ' + k.padEnd(12) + dim(String(v)));
  }
  if (env.chrome === '(fill in)') {
    console.log(dim('  (set CHROME_VERSION to record the browser — it is a browser surface)'));
  }

  await automated();

  const failed = results.filter((r) => r.ok === false);
  console.log('\n' + (failed.length
    ? red(bold(failed.length + ' automated check(s) failed')) + ' — fix before the manual pass'
    : green(bold('automated checks pass'))));

  manual();

  if (process.argv.includes('--record')) {
    const i = process.argv.indexOf('--record');
    const outcome = failed.length ? 'FAILED' : (process.argv[i + 1] || 'passed');
    const file = appendLog(env, outcome, process.argv[i + 2]);
    console.log('\n' + bold('recorded') + ' ' + path.relative(process.cwd(), file));
  } else {
    console.log('\n' + dim('run again with --record "passed" once the manual pass is done'));
  }
  console.log('');
  process.exit(failed.length ? 1 : 0);
})();
