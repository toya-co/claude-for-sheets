/**
 * Where a new release-log entry lands.
 *
 * This exists because the log got corrupted rather than appended: the insertion
 * point was found with an LF-only `indexOf`, which misses on a CRLF file and
 * returns -1 — and the `+ 5` that followed turned the miss into offset 4, four
 * characters into the title. The entry spliced mid-word and the header lost its
 * first line, silently, on the one file whose whole job is to be trustworthy
 * after the fact.
 *
 * The lesson generalises past this file: an offset computed from a failed
 * search must never be usable as a valid position.
 */

const test = require('node:test');
const assert = require('node:assert');

const { spliceNewest_ } = require('../check');

const HEADER = ['# Release log', '', 'Some prose about the log.', '', '---', '', ''];
const lf = HEADER.join('\n');
const crlf = HEADER.join('\r\n');
const ENTRY = '## 2026-01-01 — a release\n\n---\n\n';

test('an entry goes under the header rule, not into the title', () => {
  const out = spliceNewest_(lf, ENTRY);
  assert.ok(out.startsWith('# Release log'), 'the title survives intact');
  assert.ok(out.indexOf(ENTRY) > out.indexOf('---'), 'the entry lands after the rule');
});

test('CRLF endings splice in the same place as LF', () => {
  const out = spliceNewest_(crlf, ENTRY);
  assert.ok(out.startsWith('# Release log'), 'the title survives intact');
  assert.ok(!/# Re##/.test(out), 'the entry did not land inside the title');
  assert.ok(out.includes('Some prose about the log.'), 'the header prose survives');
  assert.ok(out.indexOf(ENTRY) > out.indexOf('---'), 'the entry lands after the rule');
});

test('newest ends up first', () => {
  const once = spliceNewest_(crlf, '## 2026-01-01 — older\n\n---\n\n');
  const twice = spliceNewest_(once, '## 2026-02-02 — newer\n\n---\n\n');
  assert.ok(twice.indexOf('newer') < twice.indexOf('older'),
    'the most recent entry is the first one a reader meets');
});

test('a header with no rule appends rather than corrupting', () => {
  const out = spliceNewest_('# Release log\n\nno rule here\n', ENTRY);
  assert.ok(out.startsWith('# Release log\n\nno rule here\n'), 'nothing existing is disturbed');
  assert.ok(out.endsWith(ENTRY), 'the entry goes at the end, which is merely wrong-order');
});
