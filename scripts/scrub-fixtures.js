#!/usr/bin/env node
/**
 * Strip personal detail out of the recorded CLI fixtures.
 *
 * The fixtures are real `claude -p --output-format stream-json` output, which is
 * exactly what makes them worth having — and the `system/init` line that opens a
 * real session carries the machine it ran on: a home directory with a username
 * in it, an auto-memory path, and a full inventory of the operator's installed
 * slash commands, skills, agents and plugins. None of that is under test, and
 * all of it ships to whoever clones the repo.
 *
 * So: replace the identifying fields, keep the shape. The parser reads types,
 * subtypes, session ids, text deltas and tool calls; the isolation tests read
 * `--tools` off the argv builder rather than from here, so trimming the tool
 * list would cost nothing either — but it is the one part of the line that is a
 * property of the CLI rather than of a person, so it stays.
 *
 *   node scripts/scrub-fixtures.js          report what would change
 *   node scripts/scrub-fixtures.js --write  rewrite the files
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'daemon', 'test', 'fixtures');
const WRITE = process.argv.includes('--write');

/** Replaced wholesale — the value is the operator's, not the CLI's. */
const REDACT = {
  cwd: '/home/user/.claude-sheets/workspace',
  memory_paths: { auto: '/home/user/.claude-app/projects/workspace/memory/' },
  slash_commands: [],
  terminal_slash_commands: [],
  skills: [],
  agents: [],
  plugins: [],
};

/**
 * Anything left that still looks like a person's machine — run after the
 * replacement, so it catches a leak in a field this script does not know about
 * rather than the ones it just handled. `/home/user` is the placeholder above
 * and is the one home path that is not somebody's.
 */
const SUSPECT = [/[Uu]sers[\\/][^\\/"]+/, /home[\\/](?!user[\\/])[^\\/"]+/i, /@[\w.-]+\.\w+/];

let changed = 0;
let flagged = 0;

for (const name of fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl'))) {
  const file = path.join(DIR, name);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

  const out = lines.map((line) => {
    if (!line.trim()) return line;
    let obj;
    try { obj = JSON.parse(line); } catch { return line; }
    if (obj.type !== 'system' || obj.subtype !== 'init') return line;

    let touched = false;
    for (const [key, value] of Object.entries(REDACT)) {
      if (obj[key] === undefined) continue;
      if (JSON.stringify(obj[key]) === JSON.stringify(value)) continue;
      obj[key] = value;
      touched = true;
    }
    if (touched) { changed++; console.log(`  ${name}: scrubbed a system/init line`); }
    return JSON.stringify(obj);
  });

  const text = out.join('\n');
  for (const re of SUSPECT) {
    const hit = re.exec(text);
    if (hit) { flagged++; console.log(`  ${name}: still looks personal — ${hit[0]}`); }
  }
  if (WRITE) fs.writeFileSync(file, text, 'utf8');
}

console.log(WRITE
  ? `\nrewrote ${changed} line(s); ${flagged} pattern(s) still flagged`
  : `\n${changed} line(s) would change; ${flagged} pattern(s) flagged. Re-run with --write.`);
process.exit(flagged ? 1 : 0);
