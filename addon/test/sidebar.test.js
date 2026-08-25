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

  const reEnable = fn.indexOf('setSending(false)');
  const earlyReturn = fn.indexOf('return;');
  const firstAwait = fn.indexOf('await');

  assert.ok(reEnable !== -1, 'New chat puts the button back to Send');
  assert.ok(earlyReturn === -1 || reEnable < earlyReturn,
    'Send is re-enabled before any early return');
  assert.ok(firstAwait === -1 || reEnable < firstAwait,
    'Send is re-enabled before any await that could throw');
  assert.ok(fn.includes('stopTurn()'), 'New chat abandons a turn still in flight');
  assert.ok(fn.indexOf('stopTurn()') < reEnable,
    'the turn is stopped before the button is put back, not after');
});

test('a turn in flight can be aborted', () => {
  assert.ok(code.includes('new AbortController()'), 'the turn carries an abort controller');
  assert.ok(code.includes('signal: ac.signal'), 'the fetch honours it');
  assert.ok(/AbortError/.test(code), 'an abort is not reported as a daemon failure');
  assert.ok(/finally\s*\{[\s\S]{0,120}?setSending\(false\)/.test(code),
    'the composer is restored in a finally, whatever happened');
});

test('Send becomes Stop while a turn is running', () => {
  // One button, two jobs, and `turnAbort` decides which — so there is no second
  // piece of state to fall out of step with the turn.
  assert.ok(/\$\('send'\)\.onclick\s*=\s*\(\)\s*=>\s*\(turnAbort \? stopTurn\(\) : send\(\)\)/.test(code),
    'the button stops a running turn and sends otherwise');
  assert.ok(/function setSending\([\s\S]{0,200}?'Stop' : 'Send'/.test(code),
    'the label follows the state');

  const fn = code.slice(code.indexOf('function stopTurn'));
  assert.ok(/turnAbort\.abort\(\)/.test(fn.slice(0, 300)),
    'stopping aborts the fetch, which is what the daemon reads as the end of the turn');

  // Re-entry is the failure that matters: a second send() over a live turn would
  // orphan the first stream and leave two turns writing to one sheet.
  const send = code.slice(code.indexOf('async function send()'));
  assert.ok(/async function send\(\)\s*\{\s*if \(turnAbort\) return/.test(send),
    'send() refuses while a turn is in flight');

  // Armed before the first await, or Stop does nothing during refreshContext.
  const body = send.slice(0, send.indexOf('try {'));
  assert.ok(body.indexOf('turnAbort = ac') < body.indexOf('await'),
    'the controller exists before the first await');
});

test('standing web permission covers search but never fetch', () => {
  // The two are different risks: a search sends a query to a search engine, a
  // fetch sends whatever Claude puts in a URL to whatever host it names. If this
  // ever stops distinguishing them, the gate has quietly become optional.
  const fn = code.slice(code.indexOf('function handleGate'));
  const body = fn.slice(0, fn.indexOf('function handleToolCall'));

  const auto = /if \(ev\.tool === 'WebSearch' && autoAllowSearch\)/.exec(body);
  assert.ok(auto, 'the auto-allow shortcut is reached only for WebSearch');
  assert.ok(body.indexOf('postGateResult(ev.gateId, true)') > auto.index,
    'nothing is allowed before the tool is checked');
  assert.ok(/if \(ev\.tool === 'WebSearch'\)\s*\{[\s\S]{0,400}?setAutoWeb\(true\)/.test(body),
    "the card's Always button is offered for search only");
});

test('an auto-allowed search still leaves a card behind', () => {
  // Silent permission is the failure mode: a request the user never saw is
  // exactly what the gate exists to prevent, allowed or not.
  const fn = code.slice(code.indexOf('function handleGate'));
  const branch = fn.slice(fn.indexOf('autoAllowSearch)'), fn.indexOf('const what'));
  assert.ok(/node\.innerHTML =/.test(branch), 'the transcript records the search');
  assert.ok(/Allowed automatically/.test(branch), 'and says why it was not asked about');
});

test('standing permission is per sidebar, not stored anywhere', () => {
  // It must not become daemon state: the sidebar is the injectable half, so a
  // rule it can set is a rule a hostile page can aim at (ARCHITECTURE 11.6).
  assert.ok(/let autoAllowSearch = false/.test(code), 'it starts off every load');
  assert.ok(!/POST[\s\S]{0,80}autoAllowSearch/.test(code) &&
            !/autoAllowSearch[\s\S]{0,80}\/settings/.test(code),
    'it is never sent to the daemon');
  assert.ok(!/localStorage|sessionStorage/.test(code), 'and never persisted in the page');

  const newChat = code.slice(code.indexOf("$('newChat').onclick"));
  assert.ok(newChat.slice(0, newChat.indexOf('guardState')).includes('setAutoWeb(false)'),
    'a new conversation does not inherit the last one\'s permissions');
});

test('the toggle cannot grant what the daemon has turned off', () => {
  assert.ok(/autoAllowSearch = on && webAvailable/.test(code),
    'arming it requires web access to actually be on');
  assert.ok(/webAvailable = ev\.webAccess !== false/.test(code),
    'availability comes from the turn, not from a guess');
});

test('Escape stops a turn but never sends one', () => {
  const handler = code.slice(code.indexOf("$('prompt').addEventListener('keydown'"));
  const fn = handler.slice(0, handler.indexOf('});') + 3);
  assert.ok(/e\.key === 'Escape' && turnAbort/.test(fn),
    'Escape only acts when there is a turn to stop');
  assert.ok(fn.indexOf('Escape') < fn.indexOf("e.key !== 'Enter'"),
    'Escape is handled before the Enter path can claim the event');
});

test('Enter sends and Shift+Enter makes a newline', () => {
  const handler = code.slice(code.indexOf("$('prompt').addEventListener('keydown'"));
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

// ------------------------------------------------------- the design pass

const markup = html.replace(/<script>[\s\S]*?<\/script>/g, '');

test('every element the script drives exists in the markup', () => {
  // A renamed id makes $() return null and the handler dies mid-render,
  // usually leaving a panel that looks fine but has quietly stopped updating.
  const ids = new Set();
  let m;
  const re = /\$\('([A-Za-z0-9_-]+)'\)/g;
  while ((m = re.exec(code)) !== null) ids.add(m[1]);

  // Not every element is in the static markup: the settings panel builds its
  // model picker at render time, so an id can be minted by the script itself.
  // Both are looked for the same way — the failure this catches is a rename in
  // one place and not the other, whichever place that is.
  const emitted = new Set();
  const idRe = /id="([A-Za-z0-9_-]+)"/g;
  while ((m = idRe.exec(html)) !== null) emitted.add(m[1]);

  const missing = [...ids].filter((id) => !emitted.has(id)).sort();
  assert.deepStrictEqual(missing, [],
    'referenced but never given to any element: ' + missing.join(', '));
});

test('exactly one function decides which panel is visible', () => {
  // Three panels and three independent toggles would guarantee a state with
  // two open at once, and an empty state disagreeing with both. showView owns
  // it; nothing else may set any panel's display.
  const outside = code.replace(/function showView[\s\S]*?\n      }/, '');
  for (const id of ['banner', 'log', 'hist', 'settings']) {
    const re = new RegExp("\\$\\('" + id + "'\\)\\.style\\.display\\s*=");
    assert.ok(!re.test(outside),
      '#' + id + " is shown or hidden outside showView");
  }
  assert.ok(/function showView/.test(code), 'showView exists');
  assert.ok(/showView\(/.test(code.replace(/function showView/g, '')),
    'and something calls it');
});

test('every panel the header can reach actually exists', () => {
  // A toggle pointing at a missing element throws inside the click handler,
  // which in a sidebar looks like a dead button rather than an error.
  const markup = html.replace(/<script>[\s\S]*?<\/script>/g, '');
  for (const id of ['banner', 'log', 'hist', 'settings']) {
    assert.ok(markup.includes('id="' + id + '"'), '#' + id + ' is in the markup');
  }
  for (const id of ['newChat', 'toggleHist', 'toggleSettings']) {
    assert.ok(markup.includes('id="' + id + '"'), '#' + id + ' control exists');
    assert.ok(code.includes("'" + id + "'"), '#' + id + ' is wired');
  }
});

test('the icon controls are reachable without a mouse', () => {
  // They are spans, not buttons, so the keyboard handling a button would have
  // given for free has to be explicit.
  const markup = html.replace(/<script>[\s\S]*?<\/script>/g, '');
  const roles = (markup.match(/role="button" tabindex="0"/g) || []).length;
  assert.ok(roles >= 3, 'each icon control is focusable, got ' + roles);
  assert.ok(/e\.key === 'Enter' \|\| e\.key === ' '/.test(code),
    'and Enter or Space activates them');
  assert.ok(/title="/.test(markup), 'and they have accessible names');
});

test('the sidebar edits the preference and never the protections', () => {
  // Model is a preference. askBefore and webAccess are protections: POST
  // /settings requires the dashboard token, which the sidebar does not have and
  // must not get — CORS cannot be an auth boundary, so any page knowing a
  // paired spreadsheet id could otherwise disable the gate (ARCHITECTURE 11.6).
  const fn = code.slice(code.indexOf('async function loadSettings'));
  const body = fn.slice(0, fn.indexOf('\n      function addMsg'));

  assert.ok(/'\/prefs'|\/prefs/.test(body), 'it reads through the pair-gated door');
  assert.ok(!/\/status/.test(body), '/status is the dashboard\'s, and is token-guarded');
  assert.ok(!/\/settings['"]/.test(body), 'it never posts to the token-guarded settings route');

  // The only key it may send is the model.
  const writes = body.match(/JSON\.stringify\(\{[^}]*\}/g) || [];
  for (const w of writes) {
    assert.ok(!/askBefore|webAccess/.test(w),
      'a protection must never be written from the sidebar: ' + w);
  }
  assert.ok(writes.some((w) => /model/.test(w)), 'the model picker does write');
  assert.ok(/Change the rest in the local app/.test(body),
    'and the rest still points at the dashboard');
});

test('the starter chips are wired to something that reads them', () => {
  const chips = (markup.match(/data-ask=/g) || []).length;
  assert.ok(chips >= 3, 'the empty state offers starters, got ' + chips);
  assert.ok(/dataset\.ask/.test(code), 'and something reads them');
  assert.ok(/closest\('li\[data-ask\]'\)/.test(code),
    'delegated via the list, so a click on the inner text still counts');
});

test('the composer re-fits itself after sending', () => {
  // Otherwise the box keeps the height of the message just sent and sits
  // several lines tall around an empty value.
  const fn = code.slice(code.indexOf('async function send()'));
  const head = fn.slice(0, fn.indexOf('await refreshContext'));
  assert.ok(/autoGrow\(\)/.test(head), 'send() re-fits the box after clearing it');
  assert.ok(/addEventListener\('input', autoGrow\)/.test(code), 'and it grows while typing');
});

test('waiting on the model shows something', () => {
  // Between Send and the first token the panel would otherwise sit blank for
  // a second or two, which reads as broken rather than busy.
  assert.ok(/class="thinking"/.test(code), 'a pending indicator is rendered');
  assert.ok(/@keyframes pulse/.test(html), 'and it is animated');
  assert.ok(/prefers-reduced-motion/.test(html), 'but not for people who asked it not to be');
});

test('both themes are defined at token level', () => {
  // A colour whose only definition sits inside the dark block renders
  // unstyled in light mode, which is the classic unreadable-panel bug.
  assert.ok(/@media \(prefers-color-scheme: dark\)/.test(html), 'a dark palette exists');

  const at = html.indexOf('prefers-color-scheme: dark');
  const darkBlock = html.slice(at, html.indexOf('* { box-sizing', at));
  const darkTokens = darkBlock.match(/--[a-z0-9-]+:/g) || [];
  assert.ok(darkTokens.length >= 10,
    'the dark block redefines the palette, got ' + darkTokens.length);

  assert.ok(/background:var\(--paper\)/.test(html),
    'body paints its own ground rather than inheriting the host page');
});

test('no colour is hardcoded outside the palette', () => {
  // Every rule must go through a token, or one theme gets the other theme's
  // colours on it.
  const styles = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const body = styles.slice(styles.indexOf('* { box-sizing'));
  const literals = body.match(/#[0-9a-fA-F]{3,6}\b/g) || [];
  assert.deepStrictEqual(literals, [],
    'hardcoded colours outside :root: ' + literals.join(', '));
});

test('an older local app is named as such, not called unresponsive', () => {
  // The failure that produced this: start-at-login was still running the
  // previous build, so /prefs 404'd while /ping answered and the status dot
  // stayed green. "Not answering" sends you looking for a stopped app that is
  // plainly running.
  const fn = code.slice(code.indexOf('async function loadSettings'));
  const body = fn.slice(0, fn.indexOf('\n      function addMsg'));

  assert.ok(/res\.status === 404/.test(body), 'a missing route is distinguished');
  assert.ok(/older build/.test(body), 'and reported as an old build');
  assert.ok(body.indexOf('res.status === 404') < body.indexOf('not answering'),
    'the specific case is checked before the catch-all');
});
