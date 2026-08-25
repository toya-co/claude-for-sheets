#!/usr/bin/env node
/**
 * Scan EVERY blob in git history for anything personal.
 *
 * Cleaning the working tree cleans the front page and nothing else — a push
 * uploads every revision of every file, so a value removed in a later commit is
 * still served by `git show <old>:<path>`. This walks all reachable blobs
 * instead of the checkout, which is the only view that matches what publishing
 * would actually expose.
 *
 * Reports; changes nothing.
 */

'use strict';

const { execFileSync } = require('child_process');

const git = (args, opts) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, ...opts });

/** What we are looking for, and why it matters if found. */
const PATTERNS = [
  ['windows home', /[A-Z]:\\+Users\\+([A-Za-z0-9._-]+)/g],
  ['unix home', /\/(?:home|Users)\/(?!user\b)([A-Za-z0-9._-]+)/g],
  ['email', /[\w.+-]+@[\w-]+\.[\w.]{2,}/g],
  ['apps script sandbox origin', /n-[a-z0-9]{20,}-[a-z0-9]+-script\.googleusercontent\.com/g],
  ['google file id', /\b1[A-Za-z0-9_-]{25,}\b/g],
];

/** Known-safe matches: placeholders, and third-party addresses in quoted docs. */
const ALLOW = [
  /^\/home\/user\//,
  /noreply@anthropic\.com$/,
  /@gmail\.com'\)/,                       // quoted from Google's own docs in PLAN.md
  /^n-<opaque>-/,
];

// rev-list --objects lists trees and commits alongside blobs, and cat-file
// blob refuses those — so ask git which objects are blobs first.
const isBlob = new Set(
  git(['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)'])
    .split('\n')
    .filter((l) => l.endsWith(' blob'))
    .map((l) => l.slice(0, l.indexOf(' '))));

const blobs = git(['rev-list', '--objects', '--all'])
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => {
    const sp = l.indexOf(' ');
    return sp === -1 ? null : { sha: l.slice(0, sp), path: l.slice(sp + 1) };
  })
  .filter((o) => o && isBlob.has(o.sha));

const SKIP = /\.(png|jpg|jpeg|gif|pdf|zip|ico|woff2?)$/i;
const findings = new Map();   // "label\tvalue" -> Set of paths

let scanned = 0;
for (const { sha, path } of blobs) {
  if (SKIP.test(path)) continue;
  let text;
  try { text = git(['cat-file', 'blob', sha]); } catch { continue; }
  if (text.includes('\0')) continue;
  scanned++;

  for (const [label, re] of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const value = m[0];
      if (ALLOW.some((ok) => ok.test(value))) continue;
      const key = label + '\t' + value;
      if (!findings.has(key)) findings.set(key, new Set());
      findings.get(key).add(path);
    }
  }
}

// Commit identities are published too, and no blob scan sees them.
const identities = new Set(git(['log', '--all', '--format=%an <%ae>%n%cn <%ce>'])
  .split('\n').map((s) => s.trim()).filter(Boolean));

console.log(`scanned ${scanned} blobs across ${blobs.length} objects\n`);

if (!findings.size) {
  console.log('CONTENT: clean — nothing matched.\n');
} else {
  console.log('CONTENT findings:\n');
  const rows = [...findings.entries()].sort();
  for (const [key, paths] of rows) {
    const [label, value] = key.split('\t');
    const list = [...paths];
    console.log(`  [${label}] ${value}`);
    console.log(`      in: ${list.slice(0, 4).join(', ')}${list.length > 4 ? ` (+${list.length - 4} more)` : ''}`);
  }
  console.log('');
}

console.log('COMMIT IDENTITIES (published verbatim, not visible to a blob scan):');
for (const id of identities) console.log('  ' + id);

process.exit(findings.size ? 1 : 0);
