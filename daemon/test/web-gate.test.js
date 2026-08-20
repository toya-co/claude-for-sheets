/**
 * The web-access gate (web-gate.js).
 *
 * This hook is the ONLY thing between an allowlisted WebFetch and the network —
 * verified live: headless print mode has no permission UI, so without the hook
 * a web call runs immediately and unprompted. Two properties must hold and are
 * tested to destruction here:
 *
 *   1. FAIL CLOSED — any failure (daemon down, bad input, garbage response)
 *      denies. An error that allowed would demote the boundary to a suggestion.
 *   2. SSRF dies before a human is asked — the daemon itself is on loopback,
 *      and inet_aton accepts numeric spellings a naive check waves through.
 */

const test = require('node:test');
const assert = require('node:assert');
const { decide_, checkUrl_, privateHost_, numericV4_, SELF_TIMEOUT_MS } =
  require('../src/web-gate');
const { buildArgs_, WEB_HOOK_TIMEOUT_S } = require('../src/claude');

const publicDns = (host, cb) => cb(null, [{ address: '93.184.216.34' }]);
const privateDns = (host, cb) => cb(null, [{ address: '10.0.0.5' }]);
const posterAllow = (p, cb) => cb({ ok: true, allow: true });
const posterDeny = (p, cb) => cb({ ok: true, allow: false });

const decide = (input, deps) => new Promise((resolve) =>
  decide_(input, { post: posterAllow, resolve: publicDns, ...deps }, resolve));

// ------------------------------------------------------------------- SSRF

test('every spelling of a private address is recognized', () => {
  for (const host of [
    'localhost', 'LOCALHOST', 'foo.localhost', 'printer.local', 'db.internal',
    '127.0.0.1', '127.1', '127.0.1', '0177.0.0.1',      // dotted, short, octal
    '2130706433', '0x7f000001', '0x7f.0.0.1',           // decimal + hex inet_aton
    '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254',                                  // cloud metadata
    '100.64.0.1',                                       // CGNAT
    '0.0.0.0', '0',
    '::1', '::', 'fd00::1', 'fc00::2', 'fe80::1',
    '::ffff:127.0.0.1', '::ffff:192.168.0.1',
  ]) {
    assert.strictEqual(privateHost_(host), true, host + ' must be private');
  }
});

test('public addresses and names are not misjudged', () => {
  for (const host of [
    'example.com', 'api.exchangerate.host', 'sub.domain.co.uk',
    '8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1',
    '2606:4700::1111', '::ffff:8.8.8.8',
  ]) {
    assert.strictEqual(privateHost_(host), false, host + ' must be public');
  }
});

test('inet_aton parsing matches the OS resolver, not just dotted quads', () => {
  assert.deepStrictEqual(numericV4_('2130706433'), [127, 0, 0, 1]);
  assert.deepStrictEqual(numericV4_('0x7f000001'), [127, 0, 0, 1]);
  assert.deepStrictEqual(numericV4_('127.1'), [127, 0, 0, 1]);
  assert.deepStrictEqual(numericV4_('0177.0.0.1'), [127, 0, 0, 1]);
  assert.strictEqual(numericV4_('example.com'), null);
  assert.strictEqual(numericV4_('256.1.1.1'), null, 'out-of-range octet is not an IP');
});

test('a fetch of the daemon itself is refused without asking anyone', async () => {
  let asked = false;
  const out = await decide(
    { tool_name: 'WebFetch', tool_input: { url: 'https://127.0.0.1:8443/status' } },
    { post: (p, cb) => { asked = true; cb({ ok: true, allow: true }); } });
  assert.strictEqual(out.allow, false);
  assert.strictEqual(asked, false, 'the human is never consulted about SSRF');
  assert.match(out.reason, /private or local/);
});

test('a public-looking hostname resolving to a private address is refused', async () => {
  const out = await decide(
    { tool_name: 'WebFetch', tool_input: { url: 'https://innocent.example.com/x' } },
    { resolve: privateDns });
  assert.strictEqual(out.allow, false);
  assert.match(out.reason, /resolves to a private address/);
});

test('non-http schemes and embedded credentials are refused', async () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/x',
                     'https://user:pass@example.com/']) {
    const out = await decide({ tool_name: 'WebFetch', tool_input: { url } });
    assert.strictEqual(out.allow, false, url);
  }
});

// -------------------------------------------------------------- decisions

test('an approved fetch of a public URL is allowed', async () => {
  const out = await decide(
    { tool_name: 'WebFetch', tool_input: { url: 'https://example.com/rates' } });
  assert.strictEqual(out.allow, true);
});

test('a search relays the query and honors the answer both ways', async () => {
  let sent = null;
  const yes = await decide(
    { tool_name: 'WebSearch', tool_input: { query: 'euro to usd rate' } },
    { post: (p, cb) => { sent = p; cb({ ok: true, allow: true }); } });
  assert.strictEqual(yes.allow, true);
  assert.deepStrictEqual(sent, { tool: 'WebSearch', detail: { query: 'euro to usd rate' } });

  const no = await decide(
    { tool_name: 'WebSearch', tool_input: { query: 'euro to usd rate' } },
    { post: posterDeny });
  assert.strictEqual(no.allow, false);
  assert.match(no.reason, /chose not to allow/, 'Claude is told it was a decision');
});

// ------------------------------------------------------------ fail closed

test('every failure path denies: daemon down, garbage, timeout, alien tool', async () => {
  const cases = [
    ['daemon unreachable', { post: (p, cb) => cb({ ok: false, error: 'ECONNREFUSED' }) }],
    ['daemon returned garbage', { post: (p, cb) => cb(null) }],
    ['gate timed out', { post: (p, cb) => cb({ ok: true, allow: false, timedOut: true }) }],
  ];
  for (const [label, deps] of cases) {
    const out = await decide(
      { tool_name: 'WebFetch', tool_input: { url: 'https://example.com/' } }, deps);
    assert.strictEqual(out.allow, false, label);
  }

  const alien = await decide({ tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.strictEqual(alien.allow, false, 'a tool the gate was never meant to judge is denied');

  const unresolvable = await decide(
    { tool_name: 'WebFetch', tool_input: { url: 'https://nope.example/' } },
    { resolve: (h, cb) => cb(new Error('ENOTFOUND')) });
  assert.strictEqual(unresolvable.allow, false, 'DNS failure denies rather than guessing');
});

// ------------------------------------------------- the timeout nesting

test('the timeouts nest so a killed hook can never fail open', () => {
  // daemon gate (240s) < hook self-timeout (270s) < CLI hook timeout (300s).
  // If the CLI killed the hook mid-wait, no decision would be emitted — and
  // with the tools allowlisted, no decision means the tool RUNS.
  const GATE_TIMEOUT_MS = 4 * 60 * 1000;   // mirrored from index.js
  assert.ok(GATE_TIMEOUT_MS < SELF_TIMEOUT_MS,
    'the daemon answers (deny) before the hook gives up');
  assert.ok(SELF_TIMEOUT_MS < WEB_HOOK_TIMEOUT_S * 1000,
    'the hook answers (deny) before the CLI kills it');
});

// --------------------------------------------------- the CLI arguments

test('web access changes the allowlist, never into a denylist', () => {
  const off = buildArgs_('p', {}, 'sid', false);
  const offTools = off[off.indexOf('--tools') + 1];
  assert.strictEqual(offTools, '', 'web off: an allowlist of nothing, unchanged');
  assert.ok(!off.includes('--settings'), 'web off: no hook settings');

  const on = buildArgs_('p', { webAccess: true,
    mcpConfig: { mcpServers: { sheets: { command: 'node', args: ['x'] } } } }, 'sid', false);
  assert.strictEqual(on[on.indexOf('--tools') + 1], 'WebSearch,WebFetch',
    'web on: exactly the two web tools, still an allowlist');
  assert.strictEqual(on[on.indexOf('--allowedTools') + 1], 'mcp__sheets,WebSearch,WebFetch');
  assert.ok(!on.includes('--disallowedTools'), 'never a denylist');
});

test('web access installs the PreToolUse hook on exactly the web tools', () => {
  const a = buildArgs_('p', { webAccess: true }, 'sid', false);
  const settings = JSON.parse(a[a.indexOf('--settings') + 1]);
  const pre = settings.hooks.PreToolUse;
  assert.strictEqual(pre.length, 1);
  assert.strictEqual(pre[0].matcher, 'WebFetch|WebSearch');
  assert.match(pre[0].hooks[0].command, /web-gate\.js/);
  assert.strictEqual(pre[0].hooks[0].timeout, WEB_HOOK_TIMEOUT_S);
});

test('the web prompt paragraph rides only when web access is on', () => {
  const off = buildArgs_('p', {}, 'sid', false);
  const on = buildArgs_('p', { webAccess: true }, 'sid', false);
  const sys = (a) => a[a.indexOf('--system-prompt') + 1];
  assert.ok(!/search the web/.test(sys(off)), 'web off: no promise of a web capability');
  assert.match(sys(on), /search the web/);
  assert.match(sys(on), /Never put spreadsheet content/,
    'the exfiltration rule is stated to the model too');
});
