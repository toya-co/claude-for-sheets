/**
 * The isolation flags are a security boundary, and they fail silently.
 *
 * This existed as a denylist naming ten tools. A live `system/init` line showed
 * eighteen others still available — CronCreate, Workflow, SendMessage, Skill,
 * RemoteTrigger among them — because a denylist can only exclude what existed
 * when it was written, and this CLI is not ours to freeze. Nothing errored;
 * ARCHITECTURE.md simply claimed "no tools at all" and was wrong.
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

test('tools are an allowlist of nothing, not a denylist', () => {
  const a = args();
  assert.ok(a.includes('--tools'), '--tools is passed');
  assert.strictEqual(valueAfter(a, '--tools'), '',
    'empty string is what disables every tool');
  assert.ok(!a.includes('--disallowedTools'),
    'a denylist silently fails open as the CLI grows new tools — never reintroduce it');
  assert.ok(!a.includes('--allowedTools'),
    'an allowlist naming anything is a tool this app does not need');
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
