/**
 * The paste-install bundle.
 *
 * addon/dist/Claude.gs is committed rather than built on demand: it exists so
 * someone can paste one file into Apps Script without running any tooling. A
 * committed artifact drifts the moment a source file changes and nobody
 * regenerates it, and the failure is silent — the add-on installs and then
 * behaves like whatever version was current when the bundle was last built.
 *
 * So the check is exact: rebuild in memory, compare byte for byte.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { build, ORDER, OUT_FILE } = require('../bundle');

test('the committed bundle matches its sources', () => {
  const before = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : null;
  build();
  const after = fs.readFileSync(OUT_FILE, 'utf8');
  assert.strictEqual(before, after,
    'addon/dist/Claude.gs is out of date — run `npm run bundle` and commit it');
});

test('every source file is in the bundle, in load order', () => {
  const body = fs.readFileSync(OUT_FILE, 'utf8');
  const dir = path.join(__dirname, '..');
  const onDisk = fs.readdirSync(dir).filter((f) => f.endsWith('.gs')).sort();
  assert.deepStrictEqual(ORDER.slice().sort(), onDisk,
    'a .gs file exists that the bundler does not include');

  // Top-level consts evaluate as the file loads, so order is load-bearing.
  let last = -1;
  for (const name of ORDER) {
    const at = body.indexOf('// ' + name);
    assert.ok(at > last, name + ' is out of order in the bundle');
    last = at;
  }
});

test('the bundle carries no Node-only syntax into Apps Script', () => {
  // Apps Script has no require/module. The bundler itself is Node code and
  // must never end up inside its own output.
  const body = fs.readFileSync(OUT_FILE, 'utf8');
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\brequire\s*\(/.test(code), 'require() would fail to load');
  assert.ok(!/module\.exports/.test(code), 'module.exports would fail to load');
});

test('the bundler and its output are kept out of clasp pushes', () => {
  // Pushing dist/Claude.gs alongside the originals would define every function
  // twice in one shared namespace; pushing bundle.js would break the project
  // the same way the test suite would.
  const ignore = fs.readFileSync(path.join(__dirname, '..', '.claspignore'), 'utf8');
  assert.match(ignore, /^bundle\.js$/m);
  assert.match(ignore, /^dist\/\*\*$/m);
});

test('the OnlyCurrentDoc token never reaches the bundle', () => {
  // Apps Script scans JSDoc for the literal token, so it would re-enable the
  // annotation that makes openById illegal -- and openById is the entire undo
  // mechanism. The source files avoid even naming it; the bundle must too.
  const body = fs.readFileSync(OUT_FILE, 'utf8');
  assert.ok(!body.includes('@' + 'OnlyCurrentDoc'), 'that token breaks undo everywhere');
});

test('install instructions travel with the file', () => {
  const body = fs.readFileSync(OUT_FILE, 'utf8');
  assert.match(body, /Extensions/, 'someone opening this file should learn what to do');
  assert.match(body, /Sidebar/, 'and that a second file is needed');
  assert.match(body, /Sheets API/, 'and that the advanced service must be enabled');
});
