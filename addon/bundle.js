/**
 * Build the paste-install bundle.
 *
 * Installing by hand meant six files plus a hidden-manifest edit, which is the
 * part of setup people actually resent. Apps Script has a FLAT namespace —
 * every .gs in a project shares one scope, which is why the test harness can
 * concatenate them and run them as one — so the four .gs files can be a single
 * file with no code changes at all.
 *
 * That leaves two pastes: this file, and Sidebar.html, which has to stay
 * separate because HtmlService loads it by name.
 *
 * Order matters. Top-level `const`s are evaluated as the file loads, so a file
 * whose constants another file's top level reads must come first. This is the
 * same order fake-sheets.js loads them in, and the tests would fail loudly if
 * it were wrong.
 *
 * Not a build step for the real install path — `clasp push` remains the
 * recommended route and pushes the original files untouched. This exists for
 * people without clasp.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ORDER = ['Sheet.gs', 'History.gs', 'Ops.gs', 'Code.gs'];
const OUT_DIR = path.join(__dirname, 'dist');
const OUT_FILE = path.join(OUT_DIR, 'Claude.gs');

const HEADER = `/**
 * Claude for Sheets — generated bundle. Do not edit here.
 *
 * The four source files concatenated into one, because Apps Script shares a
 * single scope across every .gs in a project. Regenerate with:
 *
 *     cd addon && npm run bundle
 *
 * To install by hand:
 *   1. Extensions ▸ Apps Script
 *   2. Paste THIS file over the default Code.gs
 *   3. Add an HTML file named exactly "Sidebar" and paste addon/Sidebar.html
 *   4. Services ▸ add "Google Sheets API" (needed for borders and
 *      conditional formatting, which Apps Script can write but not read back)
 *   5. Save, reload the spreadsheet tab, then Claude ▸ Open sidebar
 *
 * Or skip all of that with:  cd addon && clasp push
 */

`;

function build() {
  const parts = ORDER.map((name) => {
    const body = fs.readFileSync(path.join(__dirname, name), 'utf8');
    return '// ' + '='.repeat(70) + '\n' +
           '// ' + name + '\n' +
           '// ' + '='.repeat(70) + '\n\n' + body.trim() + '\n';
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, HEADER + parts.join('\n'), 'utf8');
  return OUT_FILE;
}

/* istanbul ignore next -- CLI wiring */
if (require.main === module) {
  const out = build();
  const lines = fs.readFileSync(out, 'utf8').split('\n').length;
  console.log('wrote ' + path.relative(process.cwd(), out) + '  (' + lines + ' lines)');
  console.log('paste that plus Sidebar.html, and enable the Sheets API service.');
}

module.exports = { build, ORDER, OUT_FILE };
