/**
 * The dashboard's browser-side script, as a string.
 *
 * Everything here renders live state from /status. The static reference pages
 * are baked into the HTML by sections.js and never touched from here.
 *
 * Polling rather than SSE, deliberately: only a pending approval is
 * time-critical, and two seconds is imperceptible to someone already waiting
 * on a human. A second long-lived stream in the process that must never wedge
 * would buy nothing visible. It backs off to ten seconds when the tab is
 * hidden, because nobody is reading it then.
 */

const CLIENT = `
/**
 * Element by id, but LOUD when it is missing.
 *
 * A bare getElementById returns null and the failure surfaces later as
 * "cannot set properties of null", which names neither the element nor the
 * function that wanted it. Naming the id turns a hunt into a read.
 */
const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error('missing element #' + id);
  return el;
};
/** Same, but for things that legitimately may not be on the page yet. */
const $maybe = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s)
  .replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/**
 * Every state-changing call carries the dashboard token. Without it the daemon
 * refuses — which is what stops any other web page driving this app, since
 * CORS cannot be an auth boundary here.
 */
function post(path, body) {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': DASH_TOKEN },
    body: JSON.stringify(body || {}),
  }).then((r) => r.json().catch(() => ({})));
}

let state = null;
let openSheet = null;   // spreadsheetId whose drawer is expanded

// ---------------------------------------------------------------- helpers

const money = (n) => '$' + (Number(n) || 0).toFixed(Number(n) < 1 ? 3 : 2);
const shortDate = (iso) => {
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  } catch (e) { return String(iso || '').slice(0, 10); }
};
function ago(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' h ago';
  return Math.floor(h / 24) + ' d ago';
}

/** Per-sheet totals, summed from the activity log rather than stored twice. */
function rollup(spreadsheetId) {
  const rows = (state.activity || []).filter((a) => a.spreadsheetId === spreadsheetId);
  return {
    turns: rows.length,
    cost: rows.reduce((sum, a) => sum + (a.costUsd || 0), 0),
    last: rows.length ? rows[0].at : null,
  };
}

function turnLine(a) {
  // Three states, not two: a turn the user stopped is neither a success nor a
  // failure, and colouring it red would say the app broke when it obeyed.
  const bad = !a.ok && !a.stopped;
  const how = a.ok ? (a.resumed ? 'resumed' : 'new session')
            : a.stopped ? 'stopped' : 'turn failed';
  const secs = a.elapsedMs ? ' \\u00b7 ' + (a.elapsedMs / 1000).toFixed(1) + ' s' : '';
  return '<div class="card row' + (bad ? ' fail' : '') + '">' +
    '<span class="grow"><span class="t"' + (bad ? ' style="color:var(--bad)"' : '') + '>' +
      esc(a.spreadsheetName) + '</span>' +
    '<span class="m">' + esc(a.summary) + ' \\u00b7 ' + how + secs + '</span></span>' +
    '<span class="m" style="margin:0">' + (bad ? '\\u2014' : money(a.costUsd)) + '</span></div>';
}

// ------------------------------------------------------------- dashboard

function renderStatus() {
  const cli = state.cli || {};
  const totals = (state.activity || []).reduce((s, a) => s + (a.costUsd || 0), 0);
  const sheets = (state.paired || []).length;
  $('statusbar').innerHTML =
    '<span class="dot' + (cli.available ? '' : ' off') + '"></span>' +
    '<strong style="font-family:var(--sans);font-weight:600">' +
      (cli.available ? 'Running' : 'Claude Code not found') + '</strong>' +
    '<span class="sep">\\u00b7</span>' +
    '<span>' + (cli.available ? 'Claude Code ' + esc(cli.version || '') :
      'install it, or configure an API key') + '</span>' +
    '<span class="sep">\\u00b7</span><span class="m">' + esc(state.origin || '') + '</span>' +
    '<span class="grow" style="flex:1"></span>' +
    '<span class="m">' + sheets + ' sheet' + (sheets === 1 ? '' : 's') +
      ' \\u00b7 ' + money(totals) + ' total</span>';
}

function renderPending() {
  const list = state.pending || [];
  $('pendingWrap').style.display = list.length ? '' : 'none';
  $('navBadge').style.display = list.length ? '' : 'none';
  $('navBadge').textContent = list.length;
  if (!list.length) return;
  $('pending').innerHTML = list.map((p) =>
    '<div class="card pend row">' +
      '<span class="grow"><span class="t">' + esc(p.spreadsheetName || '(unnamed)') + '</span>' +
      '<span class="m">' + esc(p.spreadsheetId) + ' \\u00b7 asked ' + ago(p.requestedAt) + '</span></span>' +
      '<button class="pri" data-pair="' + esc(p.spreadsheetId) + '" data-allow="1">Allow</button>' +
      '<button data-pair="' + esc(p.spreadsheetId) + '" data-allow="">Deny</button>' +
    '</div>').join('');
}

function renderSheets() {
  // The poll fires every two seconds and this rebuilds innerHTML, which
  // destroys whatever the user is typing in and takes focus with it. So bail
  // while a text field in here has focus; the next refresh catches up.
  //
  // Narrow to text fields deliberately. Guarding on ANY focus also blocked the
  // re-render triggered by clicking a row — the click focuses the row itself,
  // which is inside this block, so opening a drawer set the state and then
  // refused to draw it.
  const focused = document.activeElement;
  if (focused && $('sheets').contains(focused) &&
      (focused.tagName === 'TEXTAREA' || focused.tagName === 'INPUT')) return;

  const list = state.paired || [];
  $('sheetCount').textContent = list.length + ' paired';
  if (!list.length) {
    $('sheets').innerHTML = '<div class="empty">None yet. Connect one from Setup.</div>';
    return;
  }
  $('sheets').innerHTML = list.map((p) => {
    const r = rollup(p.spreadsheetId);
    const open = openSheet === p.spreadsheetId;
    const meta = 'paired ' + shortDate(p.pairedAt) +
      (p.sessionId ? ' \\u00b7 conversation active' : ' \\u00b7 no conversation yet') +
      (r.turns ? ' \\u00b7 ' + r.turns + ' turn' + (r.turns === 1 ? '' : 's') +
                 ' \\u00b7 ' + money(r.cost) : '');
    let html = '<div class="card' + (open ? ' open' : '') + '">' +
      '<div class="row head" data-card="' + esc(p.spreadsheetId) + '" ' +
        'role="button" tabindex="0" aria-expanded="' + (open ? 'true' : 'false') + '">' +
      '<span class="chev">' + (open ? '▾' : '▸') + '</span>' +
      '<span class="grow"><span class="t">' + esc(p.name) + '</span>' +
      '<span class="m">' + meta + '</span></span>' +
      '</div>';
    if (open) {
      html += '<div class="drawer">' +
        '<p class="w-h">Instructions for this spreadsheet</p>' +
        '<textarea id="sheetIns" placeholder="Dates as ISO. Keep totals bold. Never edit column A.">' +
          esc(p.instructions || '') + '</textarea>' +
        '<div class="row" style="margin-top:11px;gap:8px">' +
          '<button class="pri" data-saveins="' + esc(p.spreadsheetId) + '">Save</button>' +
          '<button data-reset="' + esc(p.spreadsheetId) + '">New conversation</button>' +
          '<button class="danger" data-unpair="' + esc(p.spreadsheetId) + '">Unpair</button>' +
          '<span class="grow"></span>' +
          '<span class="m" style="margin:0">' +
            (r.last ? 'last turn ' + ago(r.last) : '') + '</span>' +
        '</div></div>';
    }
    return html + '</div>';
  }).join('');
}

function renderRecent() {
  const rows = (state.activity || []).slice(0, 3);
  $('recent').innerHTML = rows.length
    ? rows.map(turnLine).join('')
    : '<div class="empty">No turns yet.</div>';
}

// -------------------------------------------------------------- activity

function renderActivity() {
  const rows = state.activity || [];
  const resumed = rows.filter((a) => a.resumed).length;
  const cost = rows.reduce((s, a) => s + (a.costUsd || 0), 0);
  const sheets = {};
  rows.forEach((a) => { sheets[a.spreadsheetId] = true; });

  $('actSummary').innerHTML =
    '<span>' + rows.length + ' turn' + (rows.length === 1 ? '' : 's') + '</span>' +
    '<span class="sep">\\u00b7</span><span>' + Object.keys(sheets).length + ' spreadsheet' +
      (Object.keys(sheets).length === 1 ? '' : 's') + '</span>' +
    '<span class="sep">\\u00b7</span><span>' + money(cost) + '</span>' +
    '<span class="sep">\\u00b7</span><span class="m">' +
      (rows.length ? Math.round(resumed / rows.length * 100) : 0) + '% resumed</span>';

  $('actList').innerHTML = rows.length
    ? rows.map(turnLine).join('')
    : '<div class="empty">No turns yet.</div>';
}

// -------------------------------------------------------------- settings

function renderSettings() {
  const s = state.settings || {};
  $('model').value = s.model || 'claude-sonnet-5';
  $('webOn').classList.toggle('on', s.webAccess !== false);
  $('webOff').classList.toggle('on', s.webAccess === false);
  const relaxed = s.askBefore === 'unrecoverable';
  $('askAll').classList.toggle('on', !relaxed);
  $('askLess').classList.toggle('on', relaxed);
  if (document.activeElement !== $('globalIns')) $('globalIns').value = s.globalInstructions || '';
  // Autostart shows what the OS actually has, never the stored preference —
  // the task can be deleted in Task Scheduler behind our back.
  const auto = state.autostart || {};
  $('autoOn').classList.toggle('on', !!auto.registered && !auto.stale);
  $('autoOff').classList.toggle('on', !auto.registered);
  $('autoOn').disabled = auto.supported === false;
  $('autoOff').disabled = auto.supported === false;
  $('autoNote').innerHTML =
    auto.supported === false ? esc(auto.reason || 'Not available on this platform.')
    : auto.stale ? 'A startup file exists but launches a different copy of the app. ' +
        'Turn it on again to repoint it.'
    : auto.registered ? 'On. <code>' + esc(auto.path || '') + '</code> runs at login ' +
        'and opens the app minimized — closing that window stops the app, and ' +
        'deleting the file turns this off.'
    : 'Off — after a restart you will need to start the app yourself.';
}

function flash(id) {
  const el = $(id);
  if (!el) return;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1400);
}

async function saveSettings(patch, flashId) {
  const res = await post('/settings', patch);
  if (res && res.settings) state.settings = res.settings;
  if (res && res.autostart) state.autostart = res.autostart;
  renderSettings();
  // A setting the machine refused must say so. Silently snapping the toggle
  // back reads as a broken button rather than a refusal.
  if (res && res.error) $('autoNote').innerHTML = '<span style="color:var(--bad)">' +
    esc(res.error) + '</span>';
  else if (flashId) flash(flashId);
}

// -------------------------------------------------------------- setup

function renderSetup() {
  const cli = state.cli || {};
  const paired = (state.paired || []).length;
  const step = (done, h, d, extra) =>
    '<div class="step ' + (done ? 'done' : 'todo') + '">' +
      '<span class="mark">' + (done ? '\\u2713' : '\\u25cb') + '</span>' +
      '<span class="grow"><span class="h">' + h + '</span>' +
      '<span class="d">' + d + '</span></span>' + (extra || '') + '</div>';

  $('setupSteps').innerHTML =
    step(true, 'Local app running', 'You are looking at it \\u2014 it serves this page') +
    step(true, 'Certificate trusted',
      'This page loaded over HTTPS, so your browser already accepted it') +
    step(cli.available, 'Claude Code signed in',
      cli.available ? esc(cli.version || '') + ' \\u2014 the credential never leaves this machine'
        : 'Run <code>claude</code> once in a terminal and sign in') +
    step(paired > 0, 'Connect a spreadsheet',
      paired > 0 ? paired + ' connected' :
        'Copy the template, or add the add-on to a sheet you already have');
}

// ----------------------------------------------------------- diagnostics

function renderDiag() {
  const cli = state.cli || {};
  const row = (k, v) => '<tr><td>' + k + '</td><td><code>' + esc(v || '\\u2014') + '</code></td></tr>';
  $('diagTable').innerHTML =
    row('App version', state.version) +
    row('Listening on', state.origin) +
    row('Claude Code', cli.available ? cli.version : 'not found') +
    row('CLI path', cli.path) +
    row('Model', (state.settings || {}).model) +
    row('Web access', (state.settings || {}).webAccess === false ? 'off' : 'on') +
    row('Ask before changes', (state.settings || {}).askBefore) +
    row('Paired spreadsheets', String((state.paired || []).length)) +
    row('Turns recorded', String((state.activity || []).length));
}

// ------------------------------------------------------------------ wiring

function renderAll() {
  renderStatus(); renderPending(); renderSheets(); renderRecent();
  renderActivity(); renderSettings(); renderSetup(); renderDiag();
}

function trouble(headline, detail) {
  const bar = $maybe('statusbar');
  if (!bar) return console.error(headline, detail);
  bar.innerHTML =
    '<span class="dot off"></span>' +
    '<strong style="font-family:var(--sans);font-weight:600">' + headline + '</strong>' +
    '<span class="sep">\u00b7</span><span>' + detail + '</span>';
}

/**
 * Fetch and render are caught SEPARATELY on purpose.
 *
 * One catch around both cannot tell "the app stopped" from "this page has a
 * bug", and it reported the first for every case of the second -- sending you
 * to restart a daemon that was serving fine. A render fault is ours: say so,
 * and name it.
 */
async function refresh() {
  let next;
  try {
    const r = await fetch('/status', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    next = await r.json();
  } catch (e) {
    return trouble('Not responding',
      'The local app is not answering (' + esc(e.message) + '). ' +
      'Restart it with <code>npm start</code>.');
  }

  state = next;
  try {
    renderAll();
  } catch (e) {
    console.error('dashboard render failed', e);
    trouble('Page error',
      'The app is fine \u2014 this page failed to draw: ' + esc(e.message) +
      '. Reload, and check the browser console.');
  }
}

// One delegated listener rather than inline handlers, so re-rendering the list
// never leaves a dead onclick behind.
function toggleCard(id) {
  openSheet = openSheet === id ? null : id;
  renderSheets();
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) {
    // Anywhere on the header row opens or closes it. Clicks inside the open
    // drawer are for its own controls and must not collapse it underfoot.
    const head = e.target.closest('[data-card]');
    if (head) toggleCard(head.dataset.card);
    return;
  }

  if (b.dataset.pair !== undefined) {
    await post('/pair', { spreadsheetId: b.dataset.pair, allow: !!b.dataset.allow });
    return refresh();
  }
  if (b.dataset.saveins !== undefined) {
    const box = $maybe('sheetIns');
    if (!box) return;   // drawer closed underneath the click; nothing to save
    await post('/instructions', { scope: 'sheet', spreadsheetId: b.dataset.saveins,
                                  text: box.value });
    return refresh();
  }
  if (b.dataset.reset !== undefined) {
    await post('/reset', { spreadsheetId: b.dataset.reset });
    return refresh();
  }
  if (b.dataset.unpair !== undefined) {
    if (!confirm('Unpair this spreadsheet? Claude will ask for approval again next time.')) return;
    openSheet = null;
    await post('/unpair', { spreadsheetId: b.dataset.unpair });
    return refresh();
  }
  if (b.dataset.web !== undefined) return saveSettings({ webAccess: b.dataset.web === '1' });
  if (b.dataset.ask !== undefined) return saveSettings({ askBefore: b.dataset.ask });
  if (b.dataset.auto !== undefined) return saveSettings({ autostart: b.dataset.auto === '1' });

  if (b.id === 'saveGlobal') {
    // Global instructions have their own route; they are memory, not a setting.
    await post('/instructions', { scope: 'global', text: $('globalIns').value });
    flash('savedGlobal');
    return refresh();
  }
  if (b.id === 'rawStatus') { window.open('/status', '_blank'); return; }

  if (b.id === 'quitApp') {
    if (!confirm('Quit the local app? Sidebars will show "local app not running" until it starts again.')) return;
    await post('/quit', {});
    $('statusbar').innerHTML = '<span class="dot off"></span>' +
      '<strong style="font-family:var(--sans)">Stopped</strong>' +
      '<span class="sep">\\u00b7</span><span>Start it again with <code>npm start</code>.</span>';
    return;
  }
  if (b.id === 'copyDiag') {
    const text = Array.from(document.querySelectorAll('#diagTable tr'))
      .map((tr) => tr.cells[0].textContent + ': ' + tr.cells[1].textContent).join('\\n');
    navigator.clipboard.writeText(text).then(() => flash('copiedDiag'));
    return;
  }
});

document.addEventListener('keydown', (e) => {
  const head = e.target.closest && e.target.closest('[data-card]');
  if (head && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleCard(head.dataset.card); }
});

$('model').addEventListener('change', () => saveSettings({ model: $('model').value }, 'savedModel'));

// ---- navigation
const links = document.querySelectorAll('nav a[data-go]');
const pages = document.querySelectorAll('section.page');
function go(id) {
  links.forEach((x) => x.classList.toggle('on', x.dataset.go === id));
  pages.forEach((p) => p.classList.toggle('on', p.id === id));
  window.scrollTo(0, 0);
  if (location.hash.slice(1) !== id) history.replaceState(null, '', '#' + id);
}
links.forEach((a) => {
  a.setAttribute('tabindex', '0');
  a.addEventListener('click', () => go(a.dataset.go));
  a.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(a.dataset.go); }
  });
});
if (location.hash) go(location.hash.slice(1));

// ---- polling, backed off when nobody is looking
let timer = null;
function schedule() {
  clearInterval(timer);
  timer = setInterval(refresh, document.hidden ? 10000 : 2000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); schedule(); });
refresh();
schedule();
`;

module.exports = { CLIENT };
