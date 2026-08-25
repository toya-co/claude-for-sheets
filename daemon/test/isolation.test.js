/**
 * The isolation flags are a security boundary, and they fail silently.
 *
 * This existed as a denylist naming ten tools. A live `system/init` line showed
 * eighteen others still available — CronCreate, Workflow, SendMessage, Skill,
 * RemoteTrigger among them — because a denylist can only exclude what existed
 * when it was written, and this CLI is not ours to freeze. Nothing errored;
 * The docs simply claimed "no tools at all" and were wrong.
 *
 * So these assert the shape rather than the outcome, which is what a unit test
 * can honestly check: that the arguments are an allowlist of nothing. Whether
 * the CLI honors that is verified live, and recorded in the fixtures README.
 */

const test = require('node:test');
const assert = require('node:assert');
const { buildArgs_ } = require('../src/claude');

const args = (opts = {}, sessionId = 'sid', resuming = false) =>
  buildArgs_('the prompt', opts, sessionId, resuming);

/** Value that follows a flag, so a flag/value pair can be asserted as a pair. */
function valueAfter(list, flag) {
  const i = list.indexOf(flag);
  return i === -1 ? undefined : list[i + 1];
}

test('built-in tools are an allowlist of nothing, not a denylist', () => {
  const a = args();
  assert.ok(a.includes('--tools'), '--tools is passed');
  assert.strictEqual(valueAfter(a, '--tools'), '',
    'empty string is what disables every built-in tool');
  assert.ok(!a.includes('--disallowedTools'),
    'a denylist silently fails open as the CLI grows new tools — never reintroduce it');
});

test('without an MCP config, no tool grant of any kind exists', () => {
  const a = args();
  assert.ok(!a.includes('--mcp-config'));
  assert.ok(!a.includes('--allowedTools'));
});

test('the sheets MCP server is the only grant, and only when configured', () => {
  const cfg = { mcpServers: { sheets: { command: 'node', args: ['x'] } } };
  const a = args({ mcpConfig: cfg });
  assert.strictEqual(valueAfter(a, '--mcp-config'), JSON.stringify(cfg),
    'the config rides inline as one argv element');
  assert.strictEqual(valueAfter(a, '--allowedTools'), 'mcp__sheets',
    'exactly the sheets server — never a broader grant');
  assert.strictEqual(valueAfter(a, '--tools'), '',
    'built-ins stay disabled even with MCP tools present');
  assert.ok(a.includes('--strict-mcp-config'),
    "the user's own MCP servers stay out regardless");
});

test('MCP servers are dropped regardless of the user config', () => {
  assert.ok(args().includes('--strict-mcp-config'));
});

test('the coding system prompt is replaced, not appended to', () => {
  const a = args();
  assert.ok(a.includes('--system-prompt'));
  assert.ok(!a.includes('--append-system-prompt'),
    'appending would leave the coding-agent prompt in place underneath');
  assert.match(valueAfter(a, '--system-prompt'), /Google Sheets sidebar/);
});

test('a caller can override the system prompt but not lose it', () => {
  const a = args({ systemPrompt: 'custom' });
  assert.strictEqual(valueAfter(a, '--system-prompt'), 'custom');
});

test('the prompt is one argv element, never shell-interpolated', () => {
  // The prompt embeds spreadsheet cell content the user did not write. It is
  // passed as its own element and spawned with shell:false; anything that
  // concatenates it into a command line is a command-injection vector.
  const nasty = 'total"; rm -rf ~; echo "';
  const a = buildArgs_(nasty, {}, 'sid', false);
  assert.strictEqual(valueAfter(a, '-p'), nasty, 'passed through verbatim as one arg');
  assert.strictEqual(a.filter((x) => x === nasty).length, 1);
});

test('a first turn opens a named session; a later turn resumes it', () => {
  const fresh = args({}, 'abc', false);
  assert.strictEqual(valueAfter(fresh, '--session-id'), 'abc');
  assert.ok(!fresh.includes('--resume'));

  const again = args({}, 'abc', true);
  assert.strictEqual(valueAfter(again, '--resume'), 'abc');
  assert.ok(!again.includes('--session-id'));
});

test('session persistence is left on, or resuming cannot work', () => {
  assert.ok(!args().includes('--no-session-persistence'),
    'that flag and --resume are mutually exclusive');
});

test('the model is only pinned when one is configured', () => {
  assert.ok(!args().includes('--model'));
  assert.strictEqual(valueAfter(args({ model: 'claude-sonnet-5' }), '--model'), 'claude-sonnet-5');
});

test('streaming stays on, since the sidebar renders deltas', () => {
  const a = args();
  assert.strictEqual(valueAfter(a, '--output-format'), 'stream-json');
  assert.ok(a.includes('--include-partial-messages'));
  assert.ok(a.includes('--verbose'), 'stream-json requires it in print mode');
});
