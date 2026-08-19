/**
 * stream-json parser tests.
 *
 * The fixtures are real `claude -p --output-format stream-json` output, captured
 * with the daemon's own flags. This is the layer most likely to break on a CLI
 * version bump, and the break would otherwise be quiet: an unrecognized line
 * shape does not throw, it just stops producing text. Assert against recorded
 * output so a shape change fails here instead of in a user's sidebar.
 *
 * Re-record with the commands in test/fixtures/README.md when the CLI updates.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { createParser_, extractPartialText_ } = require('../src/claude');

const FIX = path.join(__dirname, 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');

/** Run a whole fixture through one parser and collect what it emitted. */
function run(text, chunkSize) {
  const events = [];
  const parser = createParser_((ev) => events.push(ev));
  if (chunkSize) {
    for (let i = 0; i < text.length; i += chunkSize) {
      parser.feed(text.slice(i, i + chunkSize));
    }
  } else {
    parser.feed(text);
  }
  parser.end();
  return { events, state: parser.state };
}

const textOf = (events) =>
  events.filter((e) => e.type === 'text').map((e) => e.delta).join('');

// ---------------------------------------------------------------- a real turn

test('a completed turn opens a session, streams text, and reports cost', () => {
  const { events, state } = run(fixture('turn-with-op.jsonl'));

  const open = events.filter((e) => e.type === 'open');
  assert.strictEqual(open.length, 1, 'exactly one open event');
  assert.match(open[0].sessionId, /^[0-9a-f-]{36}$/);
  assert.ok(open[0].model, 'open carries the model');

  assert.ok(state.opened);
  assert.strictEqual(state.failed, null);
  assert.ok(state.costUsd > 0, 'cost is reported');
  assert.ok(state.usage.cache_read_input_tokens !== undefined, 'usage is captured');
  assert.ok(textOf(events).length > 0, 'the answer streamed');
});

test('the sheetop block survives the stream intact', () => {
  const { events } = run(fixture('turn-with-op.jsonl'));
  const text = textOf(events);
  assert.match(text, /```sheetop/, 'op block is present');
  const body = text.match(/```sheetop\s*([\s\S]*?)```/);
  assert.ok(body, 'op block is closed');
  const op = JSON.parse(body[1].trim());
  assert.strictEqual(op.type, 'setValues');
  assert.ok(Array.isArray(op.values), 'values is an array');
});

test('the answer is not delivered twice when partial streaming works', () => {
  // The `assistant` line repeats the whole message after the deltas. Emitting
  // both would render the answer twice in the sidebar.
  const { events, state } = run(fixture('turn-with-op.jsonl'));
  const streamed = textOf(events);
  assert.strictEqual(streamed, state.streamedText);
  assert.ok(!streamed.includes(state.finalText + state.finalText));
});

// ------------------------------------------------------------------- resuming

test('a resumed turn echoes the session it reopened', () => {
  const { events, state } = run(fixture('turn-resumed.jsonl'));
  const open = events.find((e) => e.type === 'open');
  assert.ok(open, 'resume produced an open event');
  assert.strictEqual(open.sessionId, state.sessionId);
  assert.strictEqual(state.failed, null);
});

test('a resume against a missing session never opens, and says why', () => {
  // This is what the fallback keys on: no system/init line, so `opened` stays
  // false and runTurn can start a clean session instead of surfacing an error.
  const { events, state } = run(fixture('resume-missing.jsonl'));

  assert.strictEqual(events.filter((e) => e.type === 'open').length, 0);
  assert.strictEqual(state.opened, false, 'the session never opened');
  assert.ok(state.failed, 'the failure was recorded');
  assert.match(state.failed.message, /No conversation found/,
    'the reason comes from errors[], not the empty result field');
});

// --------------------------------------------------------- chunking and noise

test('output split at arbitrary boundaries parses identically', () => {
  // stdout arrives in OS-sized reads, so a JSON line can land across two of
  // them. One byte at a time is the worst case.
  const text = fixture('turn-with-op.jsonl');
  const whole = run(text);
  for (const size of [1, 7, 64, 4096]) {
    const split = run(text, size);
    assert.strictEqual(textOf(split.events), textOf(whole.events), `chunk size ${size}`);
    assert.strictEqual(split.state.sessionId, whole.state.sessionId, `chunk size ${size}`);
    assert.strictEqual(split.state.costUsd, whole.state.costUsd, `chunk size ${size}`);
  }
});

test('a final line with no trailing newline is not dropped', () => {
  const events = [];
  const parser = createParser_((ev) => events.push(ev));
  parser.feed('{"type":"result","total_cost_usd":0.5,"result":"done"}');
  assert.strictEqual(parser.state.costUsd, 0, 'not parsed until end()');
  parser.end();
  assert.strictEqual(parser.state.costUsd, 0.5);
  assert.strictEqual(parser.state.finalText, 'done');
});

test('unknown line types and malformed lines are ignored, not fatal', () => {
  const events = [];
  const parser = createParser_((ev) => events.push(ev));
  parser.feed([
    '{"type":"rate_limit_event","x":1}',
    '{"type":"system","subtype":"post_turn_summary"}',
    'not json at all',
    '',
    '{"type":"something_new_in_a_future_version"}',
    '{"type":"result","total_cost_usd":0.01}',
  ].join('\n') + '\n');
  parser.end();
  assert.strictEqual(events.length, 0, 'nothing user-facing was emitted');
  assert.strictEqual(parser.state.costUsd, 0.01, 'parsing continued past the junk');
});

test('hook and status noise never reaches the sidebar', () => {
  // Hooks fire on every invocation and cannot be disabled on the subscription
  // path; their output must stay internal.
  const { events } = run(fixture('turn-with-op.jsonl'));
  const leaked = events.filter((e) =>
    e.type === 'text' && /hook_started|hook_response|post_turn_summary/.test(e.delta));
  assert.strictEqual(leaked.length, 0);
});

// ------------------------------------------------------------- delta shapes

test('text deltas are read defensively across shapes', () => {
  assert.strictEqual(
    extractPartialText_({ event: { type: 'content_block_delta', delta: { text: 'hi' } } }), 'hi');
  assert.strictEqual(
    extractPartialText_({ type: 'content_block_delta', delta: { text: 'hi' } }), 'hi');
  assert.strictEqual(
    extractPartialText_({ event: { type: 'content_block_delta', delta: { partial_json: '{' } } }), null,
    'tool-input deltas are not answer text');
  assert.strictEqual(extractPartialText_({ type: 'message_stop' }), null);
  assert.strictEqual(extractPartialText_(null), null);
});
