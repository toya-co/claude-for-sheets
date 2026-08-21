/**
 * The dashboard: docs and control panel in one page (ARCHITECTURE.md §6).
 *
 * This is the app's front door. Pairing approval happens here and cannot move
 * — CORS cannot be an auth boundary, so approval is confirmed out-of-band in a
 * UI the web cannot drive — which makes this page mandatory rather than
 * optional. So it carries everything else with no home: settings, per-sheet
 * instructions, activity, and the reference docs a user needs but would
 * otherwise only find in the repo.
 *
 * Assembled from three parts, split because they change for different reasons:
 *   style.js     the stylesheet
 *   sections.js  the static reference pages (capability list generated from
 *                the live tool definitions, so it cannot drift)
 *   client.js    everything that renders live state from /status
 *
 * The `dashToken` argument is the boundary: it is embedded here and required
 * by every state-changing route. `GET /` deliberately sends no CORS headers,
 * so a cross-origin page cannot read this HTML and therefore cannot learn it.
 */

const { CSS } = require('./style');
const { CLIENT } = require('./client');
const { canDo, undoDocs, webDocs, howDocs, setupDocs } = require('./sections');

const VERSION = require('../../package.json').version;

const NAV = [
  ['Live', [['dashboard', 'Dashboard', true], ['activity', 'Activity']]],
  ['Configure', [['setup', 'Setup'], ['settings', 'Settings'], ['app', 'The app itself']]],
  ['Reference', [['can', 'What Claude can do'], ['undo', 'Undo &amp; history'],
                 ['web', 'Web access'], ['how', 'How it works']]],
  ['Support', [['diag', 'Diagnostics']]],
];

function nav() {
  return NAV.map(([label, items]) => `
    <div class="navgroup"><div class="label">${label}</div><nav>
      ${items.map(([id, text, badge]) => `<a data-go="${id}"${
        id === 'dashboard' ? ' class="on"' : ''}>${text}${
        badge ? '<span class="badge" id="navBadge" style="display:none">0</span>' : ''}</a>`).join('')}
    </nav></div>`).join('');
}

/** A two-button either/or. Cheaper to read at a glance than a checkbox. */
function seg(attr, options) {
  return `<div class="seg">${options.map(([val, label, id]) =>
    `<button id="${id}" data-${attr}="${val}">${label}</button>`).join('')}</div>`;
}

function page(dashToken) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude for Sheets</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Serif:wght@0,400;0,600&display=swap">
<style>${CSS}</style>
</head>
<body>
<div class="app">

<aside class="rail">
  <div class="brand">
    <span class="dot"></span>
    <span class="name">Claude for Sheets</span>
    <span class="ver">v${VERSION}</span>
  </div>
  ${nav()}
</aside>

<main>

<section class="page on" id="dashboard">
  <p class="eyebrow">Live</p>
  <h1>Dashboard</h1>
  <p class="lede">Everything happening right now, in the order it needs attention.</p>

  <div class="statusbar" id="statusbar"></div>

  <div id="pendingWrap" style="display:none">
    <div class="blockhead"><h2>Waiting for approval</h2>
      <span class="count">a turn is blocked until you answer</span></div>
    <div id="pending"></div>
  </div>

  <div class="blockhead"><h2>Spreadsheets</h2><span class="count" id="sheetCount"></span></div>
  <div id="sheets"></div>

  <div class="blockhead"><h2>Recent</h2><span class="count">last 3 turns</span></div>
  <div id="recent"></div>
</section>

<section class="page" id="activity">
  <p class="eyebrow">Live</p>
  <h1>Activity</h1>
  <p class="lede">Every turn this app has served, newest first, across all spreadsheets.</p>
  <div class="statusbar" id="actSummary"></div>
  <div id="activity"></div>
  <div class="note">
    <strong>The number worth watching is &ldquo;resumed&rdquo;.</strong> A resumed turn
    reads its conversation from cache instead of rebuilding it, which is several times
    cheaper. If resumed turns stop appearing, something has broken and every turn is
    quietly costing more than it should.
  </div>
</section>

<section class="page" id="setup">
  <p class="eyebrow">Configure &middot; one time</p>
  <h1>Setup</h1>
  <p class="lede">Two of these are already proven by the fact that you are reading
  this page. Only what is left needs you.</p>
  <div id="setupSteps"></div>
  ${setupDocs()}
</section>

<section class="page" id="settings">
  <p class="eyebrow">Configure</p>
  <h1>Settings</h1>
  <p class="lede">Applies to every spreadsheet. Per-sheet instructions layer on top of
  these rather than replacing them.</p>

  <div class="card"><div class="row">
    <span class="grow"><span class="t">Model</span>
    <span class="m">Every turn carries a fixed overhead, so the model dominates cost
    more than message length does</span></span>
    <select id="model">
      <option value="claude-sonnet-5">Sonnet 5</option>
      <option value="claude-opus-5">Opus 5</option>
      <option value="claude-fable-5">Fable 5</option>
      <option value="claude-haiku-4-5-20251001">Haiku 4.5</option>
    </select>
    <span class="saved" id="savedModel">Saved</span>
  </div></div>

  <div class="card"><div class="row">
    <span class="grow"><span class="t">Web search and fetch</span>
    <span class="m">Each request asks first &middot; local and private addresses are
    refused outright</span></span>
    ${seg('web', [['1', 'On', 'webOn'], ['0', 'Off', 'webOff']])}
  </div></div>

  <div class="card"><div class="row">
    <span class="grow"><span class="t">Ask before changes</span>
    <span class="m">Everything Claude edits can be undone &mdash; except the two
    exceptions below</span></span>
    ${seg('ask', [['destructive', 'Anything destructive', 'askAll'],
                  ['unrecoverable', "Only what I can't undo", 'askLess']])}
  </div>
  <div class="drawer">
    <p class="m" style="margin:0">
      <strong style="font-family:var(--sans);color:var(--fg)">Anything destructive</strong>
      asks before overwriting formulas, replacing more than ten filled cells, clearing,
      merging over data, sorting formulas, or deleting filled rows.<br>
      <strong style="font-family:var(--sans);color:var(--fg)">Only what I can't undo</strong>
      applies all of that silently and leaves the edit history to protect you.<br>
      Deleting a tab and every web request always ask, whichever you pick.
    </p>
  </div></div>

  <div class="card">
    <span class="t">Instructions for every spreadsheet</span>
    <textarea id="globalIns" placeholder="Prefer formulas over pasted values."></textarea>
    <div class="row" style="margin-top:10px">
      <button class="pri" id="saveGlobal">Save</button>
      <span class="saved" id="savedGlobal">Saved</span>
    </div>
  </div>
</section>

<section class="page" id="app">
  <p class="eyebrow">Configure</p>
  <h1>The app itself</h1>
  <p class="lede">A background process holding the path to your Claude credential should
  never be something you cannot find or turn off.</p>

  <div class="card"><div class="row">
    <span class="grow"><span class="t">Start at login</span>
    <span class="m">Registers a per-user scheduled task &middot; no tray icon, no
    background installer</span></span>
    ${seg('auto', [['1', 'On', 'autoOn'], ['0', 'Off', 'autoOff']])}
  </div></div>

  <div class="card"><div class="row">
    <span class="grow"><span class="t">Quit</span>
    <span class="m">Sidebars will show &ldquo;local app not running&rdquo; until it
    starts again</span></span>
    <button class="danger" id="quitApp">Quit</button>
  </div></div>

  <div class="note">
    <strong>The page that grants access is the page that revokes it.</strong> Quitting
    and start-at-login sit next to the pairing controls deliberately, rather than in a
    separate admin corner.
  </div>
</section>

<section class="page" id="can">${canDo()}</section>
<section class="page" id="undo">${undoDocs()}</section>
<section class="page" id="web">${webDocs()}</section>
<section class="page" id="how">${howDocs()}</section>

<section class="page" id="diag">
  <p class="eyebrow">Support</p>
  <h1>Diagnostics</h1>
  <p class="lede">For when something is not working and you need to know which half.</p>
  <div class="scroll"><table><tbody id="diagTable"></tbody></table></div>
  <div class="row" style="gap:8px">
    <button id="copyDiag">Copy diagnostics</button>
    <button id="rawStatus">Open raw status</button>
    <span class="saved" id="copiedDiag">Copied</span>
  </div>

  <h2>Common failures</h2>
  <h3>The sidebar says &ldquo;local app not running&rdquo;</h3>
  <p>This app is not started, or the certificate has not been accepted in that browser
  profile. Open this page there once.</p>
  <h3>Turns fail with AUTH_FAILED</h3>
  <p>Run <code>claude</code> once in a terminal and sign in, then retry.</p>
  <h3>A turn hangs</h3>
  <p>Claude waits up to five minutes for the sidebar to answer. Use New chat in the
  sidebar to abandon it.</p>
</section>

</main>
</div>

<script>
const DASH_TOKEN = ${JSON.stringify(String(dashToken || ''))};
${CLIENT}
</script>
</body>
</html>`;
}

module.exports = { page };
