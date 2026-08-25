/**
 * A stand-in for the Claude CLI, for the tests that need a process which is
 * genuinely running rather than a recorded transcript.
 *
 * Emits one `system/init` line — the shape claude.js treats as the session
 * opening — then holds the process open forever. Whoever spawned it decides
 * when it ends, which is the whole point: stopping a turn is only observable
 * against a child that would otherwise still be alive.
 *
 * FAKE_CLI_LOG: a file this appends one line to per invocation, so a test can
 * count spawns and prove a stopped turn was not quietly retried.
 * FAKE_CLI_SILENT=1: never open a session, so a resume looks lost.
 */

const fs = require('fs');

if (process.env.FAKE_CLI_LOG) {
  // One line per spawn, whatever the args contain. The prompt and system prompt
  // are full of newlines, and a counter that counts those counts one spawn many.
  const flat = process.argv.slice(2).join(' ').replace(/\s+/g, ' ');
  fs.appendFileSync(process.env.FAKE_CLI_LOG, flat + '\n');
}

if (process.env.FAKE_CLI_SILENT !== '1') {
  const sessionId = process.env.FAKE_CLI_SESSION || '00000000-0000-4000-8000-000000000000';
  process.stdout.write(JSON.stringify({
    type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-model',
  }) + '\n');
}

// Outlive the test unless killed. The interval is what keeps the event loop up.
setInterval(() => {}, 1000);
