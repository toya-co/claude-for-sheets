/**
 * Minimal dashboard. M2 scope is pairing approval and visibility; the real
 * dashboard (cross-sheet activity, settings, credential management) is M10.
 *
 * This is also the auth boundary. CORS cannot be one — the sidebar's origin is
 * n-<rotating-hash>-script.googleusercontent.com and the hash is not stable, so
 * no origin allowlist is possible and any page can reach the daemon. Approval
 * happens here, out-of-band, in a UI the web cannot drive.
 */

function page(dashToken) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Claude for Sheets — local app</title>
  <style>
    :root { color-scheme: light dark; }
    body { font: 14px/1.6 -apple-system, system-ui, "Segoe UI", sans-serif;
           max-width: 720px; margin: 40px auto; padding: 0 20px; }
    h1 { font-size: 18px; margin: 0 0 4px; }
    .sub { color: #6b7280; font-size: 13px; margin-bottom: 24px; }
    h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em;
         color: #6b7280; margin: 28px 0 8px; }
    .card { border: 1px solid #d0d7de; border-radius: 8px; padding: 12px 14px; margin: 8px 0; }
    .pending { border-color: #d97706; background: #fffbeb; }
    button { font: inherit; padding: 6px 14px; border-radius: 6px; cursor: pointer;
             border: 1px solid #d0d7de; background: #fff; margin-right: 6px; }
    button.approve { background: #1e8e3e; border-color: #1e8e3e; color: #fff; }
    button.deny { color: #d93025; }
    .muted { color: #6b7280; font-size: 12px; }
    .empty { color: #6b7280; font-style: italic; }
    code { font-size: 12px; background: #f3f4f6; padding: 1px 5px; border-radius: 4px; }
    .row { display: flex; align-items: center; gap: 10px; }
    .grow { flex: 1; }
  </style>
</head>
<body>
  <h1>Claude for Sheets</h1>
  <div class="sub" id="status">checking…</div>

  <h2>Waiting for approval</h2>
  <div id="pending"><div class="empty">Nothing waiting.</div></div>

  <h2>Paired spreadsheets</h2>
  <div id="paired"><div class="empty">None yet.</div></div>

  <h2>Recent activity</h2>
  <div id="activity"><div class="empty">No turns yet.</div></div>

<script>
// Proof this page came from the daemon. A cross-origin page cannot read
// GET / (no CORS headers there), so it cannot learn this — and every
// state-changing route below refuses without it.
const DASH_TOKEN = ${JSON.stringify(dashToken)};

function post(path, body) {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': DASH_TOKEN },
    body: JSON.stringify(body),
  });
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

async function refresh() {
  const s = await (await fetch('/status')).json();

  document.getElementById('status').innerHTML =
    (s.cli.available
      ? 'Claude Code ' + esc(s.cli.version) + ' — credential ready'
      : '<b>Claude Code not found on PATH.</b> Install it, or configure an API key.')
    + ' · listening on <code>' + esc(s.origin) + '</code>';

  document.getElementById('pending').innerHTML = s.pending.length
    ? s.pending.map(p => \`
        <div class="card pending">
          <div class="row">
            <div class="grow">
              <b>\${esc(p.spreadsheetName)}</b>
              <div class="muted">\${esc(p.spreadsheetId)}</div>
            </div>
            <button class="approve" onclick="decide('\${esc(p.spreadsheetId)}',true)">Allow</button>
            <button class="deny" onclick="decide('\${esc(p.spreadsheetId)}',false)">Deny</button>
          </div>
        </div>\`).join('')
    : '<div class="empty">Nothing waiting.</div>';

  document.getElementById('paired').innerHTML = s.paired.length
    ? s.paired.map(p => \`
        <div class="card row">
          <div class="grow">
            <b>\${esc(p.name)}</b>
            <div class="muted">paired \${esc(p.pairedAt.slice(0,10))} · \${esc(p.spreadsheetId)}</div>
          </div>
          <button onclick="unpair('\${esc(p.spreadsheetId)}')">Remove</button>
        </div>\`).join('')
    : '<div class="empty">None yet.</div>';

  document.getElementById('activity').innerHTML = s.activity.length
    ? s.activity.map(a => \`
        <div class="card">
          <b>\${esc(a.spreadsheetName)}</b> · <span class="muted">\${esc(a.at.replace('T',' ').slice(0,19))}</span>
          <div class="muted">\${esc(a.summary)}\${a.costUsd ? ' · $' + a.costUsd.toFixed(4) : ''}</div>
        </div>\`).join('')
    : '<div class="empty">No turns yet.</div>';
}

async function decide(id, allow) {
  await post('/pair', { spreadsheetId: id, allow });
  refresh();
}

async function unpair(id) {
  await post('/unpair', { spreadsheetId: id });
  refresh();
}

refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;
}

module.exports = { page };
