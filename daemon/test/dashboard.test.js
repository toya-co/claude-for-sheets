/**
 * Static checks on the dashboard.
 *
 * Like the sidebar, this page cannot be unit tested — it needs a browser and a
 * live daemon. But its worst failure modes are mechanical and catchable
 * without one: calling a function that no longer exists, referencing an
 * element id that was renamed, or leaking the dashboard token into a response
 * any web page can read.
 *
 * The analysis is crude on purpose — a name pool, not a scope analysis. Enough
 * to make that class of mistake loud, cheap enough never to need maintenance.
 */

const test = require('node:test');
const assert = require('node:assert');
const dashboard = require('../src/dashboard');
const { CLIENT } = require('../src/dashboard/client');
const { TOOLS } = require('../src/mcp-bridge');

const HTML = dashboard.page('test-token-value');

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(?<!:)\/\/.*$/gm, '');

/** All three quote styles in ONE alternation, so whichever opens first wins. */
const bare = stripComments(CLIENT)
  .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof',
  'function', 'new', 'delete', 'void', 'in', 'of', 'do', 'else', 'await', 'yield',
  'throw', 'async', 'get', 'set']);

const AMBIENT = new Set(['Object', 'Array', 'JSON', 'String', 'Number', 'Boolean', 'Math',
  'Date', 'Promise', 'Set', 'Map', 'Error', 'RegExp', 'parseInt', 'parseFloat', 'isNaN',
  'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'setTimeout', 'setInterval',
  'clearTimeout', 'clearInterval', 'fetch', 'alert', 'confirm', 'prompt',
  // provided by the page, not by this script
  'DASH_TOKEN']);

function definedNames(src) {
  const names = new Set();
  for (const re of [/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g,
                    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g]) {
    let m;
    while ((m = re.exec(src)) !== null) names.add(m[1]);
  }
  for (const re of [/\bfunction\s*[\w$]*\s*\(([^)]*)\)/g, /\(([^)]*)\)\s*=>/g]) {
    let m;
    while ((m = re.exec(src)) !== null) {
      for (const p of m[1].split(',')) {
        const name = p.trim().replace(/^[\s(]+/, '').replace(/^\.\.\./, '').split(/[=\s)]/)[0];
        if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
      }
    }
  }
  let m;
  const arrow = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>/g;
  while ((m = arrow.exec(src)) !== null) names.add(m[1]);
  return names;
}

function calledNames(src) {
  const names = new Set();
  // Lookbehind, not a consuming group: matching the preceding character eats
  // it, so in `esc(money(x))` the inner call would never match.
  const re = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) if (!KEYWORDS.has(m[1])) names.add(m[1]);
  return names;
}

test('every function the dashboard calls is actually defined', () => {
  const defined = definedNames(bare);
  const missing = [...calledNames(bare)]
    .filter((n) => !defined.has(n) && !AMBIENT.has(n)).sort();
  assert.deepStrictEqual(missing, [],
    'called but never defined — a deleted helper, or a typo: ' + missing.join(', '));
});

test('every element the script reaches for exists in the markup', () => {
  // $('foo') against a renamed id fails silently at runtime — the render just
  // stops, usually leaving a blank panel with no error anyone will see.
  const ids = new Set();
  let m;
  const re = /\$\('([A-Za-z0-9_-]+)'\)/g;
  while ((m = re.exec(CLIENT)) !== null) ids.add(m[1]);

  const missing = [...ids].filter((id) => !HTML.includes('id="' + id + '"')).sort();
  assert.deepStrictEqual(missing, [], 'referenced but not in the page: ' + missing.join(', '));
});

test('every data-action button the script handles is rendered somewhere', () => {
  // The click handler dispatches on dataset keys; a renamed attribute makes the
  // button inert with no error.
  for (const key of ['web', 'ask', 'auto']) {
    assert.ok(new RegExp('data-' + key + '=').test(HTML),
      'no button renders data-' + key);
    assert.ok(new RegExp('dataset\\.' + key).test(CLIENT),
      'nothing handles data-' + key);
  }
  for (const id of ['saveGlobal', 'quitApp', 'copyDiag', 'rawStatus']) {
    assert.ok(HTML.includes('id="' + id + '"'), id + ' is rendered');
    assert.ok(CLIENT.includes("'" + id + "'"), id + ' is handled');
  }
});

test('every nav target has a matching section', () => {
  const targets = [];
  let m;
  const re = /data-go="([a-z]+)"/g;
  while ((m = re.exec(HTML)) !== null) targets.push(m[1]);
  assert.ok(targets.length >= 10, 'got ' + targets.length + ' nav entries');
  for (const id of targets) {
    assert.ok(new RegExp('<section class="page[^"]*" id="' + id + '"').test(HTML),
      'nav points at #' + id + ' but no section has it');
  }
});

// ------------------------------------------------------------- the token

test('the dashboard token is embedded, and only as a JSON string', () => {
  assert.ok(HTML.includes('"test-token-value"'), 'the token reaches the page');
  // Injected via JSON.stringify so a token containing a quote could never
  // break out of the script context.
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'dashboard', 'index.js'), 'utf8');
  assert.ok(/DASH_TOKEN = \$\{JSON\.stringify\(/.test(src),
    'the token must be JSON-encoded, never interpolated raw');
});

test('every mutating call from the page carries the token', () => {
  // A missed header is a 403 the user sees as "the button does nothing".
  assert.ok(/'X-Dashboard-Token': DASH_TOKEN/.test(CLIENT), 'post() sends it');
  // And nothing bypasses post() with a bare mutating fetch.
  const bareFetch = CLIENT.match(/fetch\((?!'\/status')/g) || [];
  assert.strictEqual(bareFetch.length, 1,
    'exactly one direct fetch (inside post itself); everything else goes through it');
});

// -------------------------------------------------- generated capability list

test('the capability list is generated from the live tools, not hand-written', () => {
  // It changed three times in one week; a hand-maintained copy would already
  // be lying. Every tool must appear, spelled for humans.
  for (const t of TOOLS) {
    assert.ok(HTML.includes('<code>' + t.name.replace(/_/g, ' ') + '</code>'),
      t.name + ' is missing from the capability page');
  }
});

test('the docs do not promise anything the tools cannot do', () => {
  const at = HTML.indexOf('id="can"');
  const section = HTML.slice(at, HTML.indexOf('</section>', at));
  for (const absent of ['chart', 'pivot', 'filter view']) {
    const claimed = new RegExp('<code>[^<]*' + absent + '[^<]*</code>', 'i').test(section);
    assert.ok(!claimed, absent + ' is listed as a tool but none exists');
  }
  assert.ok(/Not yet/.test(section), 'the page says what is missing');
});

// ------------------------------------------------------------------ shape

test('the page renders without a token and without state', () => {
  // A first paint happens before /status returns; nothing may assume state.
  const empty = dashboard.page('');
  assert.ok(empty.length > 10000);
  assert.ok(empty.includes('<section class="page on" id="dashboard"'));
});

test('a live re-render never runs under the cursor', () => {
  // The poll rebuilds innerHTML every two seconds. Any block holding an input
  // must bail while it has focus, or it eats what the user is typing — which
  // it did, in the per-sheet instructions box.
  assert.ok(/if \(\$\('sheets'\)\.contains\(document\.activeElement\)\) return;/.test(CLIENT),
    'renderSheets must not rebuild while focus is inside it');
  assert.ok(/document\.activeElement !== \$\('globalIns'\)/.test(CLIENT),
    'the global instructions box needs the same guard');
});

test('a whole spreadsheet row opens its drawer, by mouse and by keyboard', () => {
  assert.ok(/data-card="/.test(CLIENT), 'the header row carries the target');
  assert.ok(/role="button" tabindex="0"/.test(CLIENT), 'and is reachable without a mouse');
  assert.ok(/closest\('\[data-card\]'\)/.test(CLIENT), 'clicks are routed from the row');
  assert.ok(/aria-expanded/.test(CLIENT), 'its state is announced');
  // Clicks inside the drawer must not collapse it out from under its own
  // controls, so button handling has to run before row handling.
  assert.ok(CLIENT.indexOf("closest('button')") < CLIENT.indexOf("closest('[data-card]')"),
    'buttons are handled before the row');
});

test('polling backs off when the tab is hidden', () => {
  assert.ok(/document\.hidden \? 10000 : 2000/.test(CLIENT),
    'a hidden tab should not poll at the same rate');
});
