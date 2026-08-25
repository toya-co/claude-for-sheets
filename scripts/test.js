#!/usr/bin/env node
/**
 * Find the test files and run them.
 *
 * This exists because `node --test daemon/test/*.test.js` relies on the SHELL
 * expanding the glob. On Windows npm runs scripts through cmd.exe, which does
 * not — so the literal `*.test.js` reached node. Node 22 and later expand globs
 * themselves and papered over it; Node 20 does not, and failed with "Could not
 * find ...\daemon\test\*.test.js". Green on three of four CI jobs, red on the
 * one with the older runtime.
 *
 * Discovering the files here instead is the same on every platform and every
 * Node version. It is also the single source of truth for which directories
 * hold tests — `scripts/check.js` imports TEST_DIRS rather than keeping its own
 * copy, so a new suite cannot be picked up by one and missed by the other.
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** Every directory holding *.test.js, relative to the repo root. */
const TEST_DIRS = [
  path.join('daemon', 'test'),
  path.join('addon', 'test'),
  path.join('scripts', 'test'),
];

/** Absolute paths of every test file, sorted so runs are reproducible. */
function testFiles() {
  const found = [];
  for (const dir of TEST_DIRS) {
    const full = path.join(ROOT, dir);
    let entries;
    try { entries = fs.readdirSync(full); } catch { continue; }
    for (const f of entries.sort()) {
      if (f.endsWith('.test.js')) found.push(path.join(full, f));
    }
  }
  return found;
}

module.exports = { TEST_DIRS, testFiles };

if (require.main === module) {
  const files = testFiles();
  if (!files.length) {
    console.error('no test files found — has a directory moved?');
    process.exit(1);
  }
  const run = spawnSync(process.execPath, ['--test', ...files],
    { cwd: ROOT, stdio: 'inherit' });
  process.exit(run.status === null ? 1 : run.status);
}
