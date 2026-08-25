# stream-json fixtures

Real `claude -p --output-format stream-json` output, recorded with the daemon's
own flags. `../parser.test.js` asserts against these.

They exist because this layer is the one most likely to break on a Claude Code
version bump, and the break is quiet: an unrecognized line shape does not throw,
it just stops producing text. A user reports "Claude stopped answering" and
nothing in the logs says why. Fixtures make that failure loud, and make it free
to test — the alternative is a live invocation per run, at real cost.

| File | What it holds |
|---|---|
| `turn-with-op.jsonl` | A complete turn on a fresh session, answering with a `sheetop` block |
| `turn-resumed.jsonl` | The next turn on that same session, via `--resume` |
| `resume-missing.jsonl` | `--resume` against a session ID that does not exist |

`resume-missing.jsonl` is the important one. It is a single `result` line with
`is_error: true` and **no `system/init`** — which is exactly what the fallback in
`claude.js` keys on to tell "your stored session is gone" apart from "the turn
failed". It also shows the reason living in `errors[]` rather than `result`.

Recorded against **Claude Code 2.1.236**, 2026-08-19.

Note that these were captured while the daemon still passed `--disallowedTools`,
so their `init` lines list eighteen tools as available. That is the bug those
recordings helped find, not the current behavior — the daemon now passes
`--tools ""` and `init` reports `tools: []`. The parser tests do not read that
field, so the fixtures were not re-recorded to hide the evidence.

## Re-recording

Do this when the CLI updates and a test starts failing. Run from
`~/.claude-sheets/workspace` so the session lands in the same project bucket the
daemon uses.

```
SID=$(uuidgen)   # or: python -c "import uuid;print(uuid.uuid4())"

claude -p "Put the word hello in cell B2 of Sheet1." \
  --output-format stream-json --include-partial-messages --verbose \
  --session-id "$SID" --strict-mcp-config --model claude-sonnet-5 \
  --disallowedTools "Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit" \
  --system-prompt "You are Claude, working inside a Google Sheets sidebar. To change the sheet, emit a single fenced code block tagged \`sheetop\` containing one JSON object, for example {\"type\":\"setValues\",\"sheetName\":\"Sheet1\",\"a1\":\"B2\",\"values\":[[\"hello\"]]}. Be concise." \
  > turn-with-op.jsonl

claude -p "What cell did you just change? Answer with just the A1 reference." \
  --output-format stream-json --include-partial-messages --verbose \
  --resume "$SID" --strict-mcp-config --model claude-sonnet-5 \
  --disallowedTools "Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit" \
  > turn-resumed.jsonl

claude -p "hi" --output-format stream-json --verbose --model claude-sonnet-5 \
  --resume "00000000-dead-4000-8000-000000000000" \
  > resume-missing.jsonl        # exits 1; that is the point
```

**Then scrub them, before anything else:**

```
node scripts/scrub-fixtures.js --write
```

A real `system/init` line records the machine it ran on — your home directory
with your account name in it, your auto-memory path, and every slash command,
skill, agent and plugin you have installed. It is in these files the moment you
record them, none of it is under test, and this repo is public. The scrubber
replaces those fields and leaves the shape alone; `fixtures.test.js` fails if a
recording is committed without it, because the whole point of these
instructions is that someone will do this again later.

Then update the version line above, and re-read the tests rather than only
re-running them — a fixture that changed shape may be telling you the parser
needs to change too, not that the assertion was wrong.

## What is deliberately not here

**An auth failure fixture.** Producing one means expiring a real OAuth session,
which is not worth doing to a developer's machine. The `AUTH_FAILED` path in
`claude.js` is matched on message text and is covered by the M2 manual check
instead.

**Anything with real spreadsheet content.** These are committed to a public repo.
Prompts stay synthetic.

## If a recording was already committed

Scrubbing the working tree fixes the tip and nothing else — a push uploads every
revision, so `git show <old>:<path>` still serves whatever was there before.
`scripts/audit-history.js` scans every blob in history rather than the checkout,
which is the only view that matches what publishing would expose.

To fix it, `git filter-repo --replace-text scripts/history-replacements.txt`.

**That file must contain nothing but rules.** `--replace-text` has no comment
syntax: a line beginning with `#` is treated as a match, and one such line
replaced every `#` in the repository with `***REMOVED***` — every shebang, every
hex colour, in every commit. Rewrite against a throwaway clone first and audit
that, not the real repo.
