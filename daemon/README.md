# daemon — local companion app

Serves the HTTPS loopback API the sidebar calls, invokes Claude with your own
credential, and hosts the pairing dashboard. Holds no Google credentials of any
kind. Zero npm dependencies — Node standard library only.

## Run

```
npm run certs     # once — self-signed cert into certs/
npm start
```

Then open **https://localhost:8443/** and click through the certificate warning
once. That page is the dashboard and the pairing surface.

Requires **Claude Code** installed and signed in (`claude` in a terminal). If
your OAuth session has expired the daemon reports `AUTH_FAILED` with that
instruction rather than failing silently — refresh tokens hard-expire, they do
not slide with use.

## API

| Route | Purpose |
|---|---|
| `GET /` | Dashboard — pairing approvals, paired sheets, recent activity |
| `GET /ping` | Health. `{ok, version, credentialReady}` — the sidebar's status dot |
| `GET /status` | Dashboard state: pending, paired, activity, CLI version |
| `POST /turn` | The turn. SSE stream out; body `{spreadsheetId, spreadsheetName, prompt, context}` |
| `POST /pair` | `{spreadsheetId, allow}` — settles a pending request |
| `POST /unpair` | `{spreadsheetId}` — revokes |

### `/turn` event vocabulary

```
{type:'pairing_required', spreadsheetName}   waiting on the dashboard
{type:'paired'}                              approved, proceeding
{type:'session', model, sessionId}           Claude started
{type:'text', delta}                         incremental output
{type:'done', costUsd, usage}                turn complete
{type:'error', code, message}                AUTH_FAILED · CLI_NOT_FOUND · PAIRING_DENIED · …
```

## Pairing is the auth boundary

It has to be. CORS cannot be one: the sidebar's origin is
`n-<rotating-hash>-script.googleusercontent.com` and the hash is not stable, so
no origin allowlist is possible and `*` is the only workable answer. Any page can
reach this daemon.

So a first request from an unrecognized spreadsheet is **held** while the
dashboard prompts, and approval is by spreadsheet ID, confirmed out-of-band in a
UI the web cannot drive. A hostile page can knock; it cannot let itself in.
Requests time out unapproved after three minutes.

## Isolation

This is a spreadsheet editor, not a coding agent, so every invocation strips what
the CLI would otherwise inherit: `--system-prompt` replaces the coding prompt,
`--strict-mcp-config` drops MCP servers, `--disallowedTools` removes every local
tool, `--no-session-persistence` keeps it out of your Claude Code history, and
cwd is a neutral `~/.claude-sheets/workspace` so no `CLAUDE.md` is discovered.

Claude has **no tools at all** here. It proposes sheet operations; the sidebar
executes them via Apps Script. So a prompt injection hidden in a cell cannot
reach your filesystem — worst case is one spreadsheet, which the undo history
covers.

**Hooks are the exception.** They fire regardless of cwd and regardless of
`--settings '{"hooks":{}}'` (that flag merges, it does not replace). `--bare`
would stop them but never reads OAuth, which breaks subscription auth. Their
output is filtered so it never reaches the sidebar, but the latency stays.

Instructions — global and per-spreadsheet — live in `state.json`, not in Claude
Code projects or auto-memory. Sheet preferences help; coding-project context does
not.

## Cost

Every turn pays ~25,000 tokens of CLI baseline, whatever the model. Measured on
an identical trivial prompt:

| Model | Cost |
|---|---|
| Fable 5 | $0.4987 |
| Sonnet 5 | $0.1498 |

Hence the `claude-sonnet-5` default rather than whatever you use for coding.
Change it in `state.json` → `settings.model`.

`--no-session-persistence` is currently a ~10x multiplier, because each turn
re-creates that 25k rather than reading it from cache. One resumed session per
spreadsheet fixes it and adds conversation continuity — that is M4.5.

## Two things that are deliberate

**The CLI is resolved to an absolute path and spawned with `shell: false`.** The
argument list carries the prompt, which embeds spreadsheet cell content the user
did not write. Passing that through a shell is a command-injection vector. Never
reintroduce `shell: true` here.

**`--bare` is not used**, despite suppressing the hook noise on every
invocation — its own help states "OAuth and keychain are never read", which
breaks subscription auth. Hook and init lines are filtered in `claude.js`
instead.

## State

`~/.claude-sheets/state.json` — paired spreadsheets, activity index (newest
first, capped at 500), settings.

Snapshot payloads are deliberately **not** here: they live in a hidden sheet
inside the user's own spreadsheet so restore works with this app closed. See
`../ARCHITECTURE.md` §4.

## Layout

```
src/index.js      HTTPS server, routes, pairing lifecycle, prompt assembly
src/claude.js     CLI resolution, spawn, stream-json parsing
src/store.js      on-disk paired list + activity index
src/dashboard.js  dashboard HTML
```

## Status

M2 complete. Verified end to end by `curl`: pairing handshake, persistence,
Claude spawn, stream parsing, and clean error surfacing. M3 wires the sidebar to
this and performs the first real cell edit.
