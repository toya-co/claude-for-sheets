/**
 * Static checks on the sidebar script.
 *
 * The sidebar cannot be unit tested — it needs a browser, google.script.run, and
 * a live daemon. But its worst failure mode is mechanical and catchable: calling
 * a function that no longer exists. JavaScript resolves calls at call time, so a
 * deleted helper stays silent until a user walks that exact path.
 *
 * That happened. Removing the dead sheetop path in M9 took verb() and undo()
 * with it while submitToolOp still called both, and broken auth hid it for a
 * day — no write ever succeeded, so the success handler never ran. Once auth was
 * fixed, every successful write threw ReferenceError inside that handler,
 * /op-result was never posted, and the turn hung until the daemon's five-minute
 * timeout with the composer stuck disabled.
 *
 * The analysis is crude on purpose: a name pool, not a scope analysis. Enough to
 * make that class of mistake loud, cheap enough to never need maintenance.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'Sidebar.html'), 'utf8');
const raw = (() => {
  const m = /<script>([\s\S]*)<\/script>/.exec(html);
  assert.ok(m, 'Sidebar.html has a <script> block');
  return m[1];
})();

/**
 * Comments are prose about the code and must not be read as code — a comment
 * mentioning `await` or CSS `var(--bad)` in a string is not a call site. Strings
 * go too for identifier scanning, but are kept for ordering checks that look for
 * real statements like $('send').
 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(?<!:)\/\/.*$/gm, '');

/**
 * All three quote styles in ONE alternation, so whichever opens first wins.
 *
 * Stripping them in separate passes is subtly wrong and was: an apostrophe
 * inside a double-quoted string ("the user's sheet") opens a phantom
 * single-quoted string in the first pass, which then swallows real code up to
 * the next apostrophe — including call sites this check exists to find.
 */
const stripCommentsAndStrings = (src) => stripComments(src)
  .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');

const code = stripComments(raw);
const bare = stripCommentsAndStrings(raw);

/** Language constructs that look like calls but are not. */
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function',
  'new', 'delete', 'void', 'in', 'of', 'do', 'else', 'await', 'yield', 'throw',
  'async', 'get', 'set',
]);

/** Ambient things the browser and Apps Script provide. */
const AMBIENT = new Set([
  'Object', 'Array', 'JSON', 'String', 'Number', 'Boolean', 'Math', 'Date',
  'Promise', 'Set', 'Map', 'Error', 'RegExp', 'Symbol', 'BigInt',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'setTimeout', 'setInterval', 'clearTimeout',
  'clearInterval', 'fetch', 'alert', 'confirm', 'prompt',
  'TextDecoder', 'TextEncoder', 'AbortController', 'requestAnimationFrame',
]);

function definedNames(src) {
  const names = new Set();
  const declarations = [
    /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
  ];
  for (const re of declarations) {
    let m;
    while ((m = re.exec(src)) !== null) names.add(m[1]);
  }
  // Parameters are callable too — `new Promise((resolve) => resolve(x))`.
  const params = [/\bfunction\s*[\w$]*\s*\(([^)]*)\)/g, /\(([^)]*)\)\s*=>/g];
  for (const re of params) {
    let m;
    while ((m = re.exec(src)) !== null) {
      for (const p of m[1].split(',')) {
        // Leading "(" survives nested calls like `new Promise((resolve) => …)`,
        // where the match starts at the outer paren.
        const name = p.trim()
          .replace(/^[\s(]+/, '')
          .replace(/^\.\.\./, '')
          .split(/[=\s)]/)[0];
        if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
      }
    }
  }
  // Single-parameter arrows without parentheses: `x => …`
  let m;
  const bareArrow = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>/g;
  while ((m = bareArrow.exec(src)) !== null) names.add(m[1]);
  return names;
}

function calledNames(src) {
  const names = new Set();
  // A bare identifier followed by "(", not preceded by "." (a method) or by a
  // word character (part of a longer name).
  //
  // Lookbehind, not a consuming group: matching the preceding character eats it,
  // so in `esc(verb(x))` the "(" is consumed by the `esc(` match and `verb(` can
  // never match. Nested calls were invisible, which is exactly where the bug
  // this file exists to catch was hiding.
  const re = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (!KEYWORDS.has(m[1])) names.add(m[1]);
  }
  return names;
}

test('every function the sidebar calls is actually defined', () => {
  const defined = definedNames(bare);
  const missing = [...calledNames(bare)]
    .filter((n) => !defined.has(n) && !AMBIENT.has(n))
    .sort();

  assert.deepStrictEqual(missing, [],
    'called but never defined — a deleted helper, or a typo: ' + missing.join(', '));
});

test('the tool-call executor answers on every path', () => {
  // Claude's turn is blocked until /op-result arrives, so each terminal branch
  // must answer or the turn hangs until the daemon times out.
  const body = code.slice(code.indexOf('function submitToolOp'));
  const fn = body.slice(0, body.indexOf('\n      function '));

  assert.ok(/catch\s*\(/.test(fn), 'the success handler is wrapped, so a render bug still answers');
  // needsConfirmation defers to the user, so: skip, error, ok, catch.
  const answers = (fn.match(/postOpResult\(/g) || []).length;
  assert.ok(answers >= 4, 'every terminal branch posts a result, got ' + answers);
  assert.ok(fn.slice(fn.indexOf('.withFailureHandler')).includes('postOpResult'),
    'an Apps Script failure still answers Claude');
});

test('New chat recovers the composer before anything that can fail', () => {
  // It is the escape hatch from a wedged turn, so the UI reset must precede any
  // early return and any await. The ordering is the whole point.
  const handler = code.slice(code.indexOf("$('newChat').onclick"));
  const fn = handler.slice(0, handler.indexOf("\n      $('toggleHist')"));

  const reEnable = fn.indexOf("$('send').disabled = false");
  const earlyReturn = fn.indexOf('return;');
  const firstAwait = fn.indexOf('await');

  assert.ok(reEnable !== -1, 'New chat re-enables Send');
  assert.ok(earlyReturn === -1 || reEnable < earlyReturn,
    'Send is re-enabled before any early return');
  assert.ok(firstAwait === -1 || reEnable < firstAwait,
    'Send is re-enabled before any await that could throw');
  assert.ok(fn.includes('turnAbort'), 'New chat abandons a turn still in flight');
});

test('a turn in flight can be aborted', () => {
  assert.ok(code.includes('new AbortController()'), 'the turn carries an abort controller');
  assert.ok(code.includes('signal: turnAbort.signal'), 'the fetch honours it');
  assert.ok(/AbortError/.test(code), 'an abort is not reported as a daemon failure');
  assert.ok(/finally\s*\{[\s\S]{0,120}?\$\('send'\)\.disabled = false/.test(code),
    'the composer is re-enabled in a finally, whatever happened');
});

test('Enter sends and Shift+Enter makes a newline', () => {
  const handler = code.slice(code.indexOf("$('prompt').addEventListener"));
  const fn = handler.slice(0, handler.indexOf('});') + 3);

  assert.ok(/e\.key !== 'Enter' \|\| e\.shiftKey/.test(fn), 'Shift+Enter falls through to the textarea');
  assert.ok(fn.includes('e.preventDefault()'),
    'the newline is suppressed, or the textarea grows before send() runs');
  assert.ok(fn.indexOf('e.preventDefault()') < fn.indexOf('send()'),
    'suppress first, then send');
  assert.ok(/isComposing/.test(fn), 'Enter during IME composition commits a candidate, not a message');
});

test('the sidebar never hardcodes a sheet or spreadsheet id', () => {
  // Everything is scoped to the container the add-on is installed in.
  assert.ok(!/openById\(['"][A-Za-z0-9_-]{20,}/.test(raw));
  assert.ok(!/spreadsheets\/d\/[A-Za-z0-9_-]{20,}/.test(raw));
});
