/**
 * The fixtures must not carry the machine they were recorded on.
 *
 * They are real CLI output, which is the point of them — and the `system/init`
 * line that opens a real session comes with a home directory containing a
 * username, an auto-memory path, and a full inventory of whatever slash
 * commands, skills, agents and plugins the operator had installed. None of it
 * is under test. All of it ships to anyone who clones the repo.
 *
 * This is a guard rather than a one-time cleanup: `fixtures/README.md` tells you
 * to re-record when the CLI's output shape changes, and a fresh recording
 * arrives with a fresh copy of all of it. `scripts/scrub-fixtures.js --write`
 * puts it right; this fails if someone forgets.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DIR = __dirname + path.sep + 'fixtures';
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl'));

test('there are fixtures to check', () => {
  assert.ok(files.length, 'no .jsonl fixtures found — has the folder moved?');
});

for (const name of files) {
  test(`${name} names no real machine`, () => {
    const text = fs.readFileSync(path.join(DIR, name), 'utf8');

    const users = /[Uu]sers[\\/]([^\\/"]+)/.exec(text);
    assert.strictEqual(users, null,
      'a Windows or macOS home path leaks the account name: ' + (users && users[0]));

    // /home/user is the placeholder the scrubber writes; any other is somebody's.
    const home = /home[\\/](?!user[\\/])([^\\/"]+)/i.exec(text);
    assert.strictEqual(home, null, 'a home path leaks a username: ' + (home && home[0]));

    const email = /[\w.-]+@[\w.-]+\.\w+/.exec(text);
    assert.strictEqual(email, null, 'an email address: ' + (email && email[0]));
  });

  test(`${name} carries no inventory of an installed setup`, () => {
    for (const line of fs.readFileSync(path.join(DIR, name), 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.type !== 'system' || obj.subtype !== 'init') continue;

      // `tools` deliberately stays: it is a property of the CLI, and it is the
      // evidence the isolation decision rests on (§ Isolation). The rest
      // describes a person's install and nothing here reads it.
      for (const key of ['slash_commands', 'terminal_slash_commands',
                         'skills', 'agents', 'plugins']) {
        if (obj[key] === undefined) continue;
        assert.deepStrictEqual(obj[key], [],
          key + ' should be emptied by scripts/scrub-fixtures.js before committing');
      }
    }
  });
}
