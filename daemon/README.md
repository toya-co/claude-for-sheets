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
| `POST /reset` | `{spreadsheetId}` — ends the conversation, keeps the pairing |
| `POST /unpair` | `{spreadsheetId}` — revokes |
| `POST /bridge/call` | MCP bridge only — token-gated; relays a tool call to the sidebar |
| `POST /op-result` | Sidebar answering a tool call; the unguessable `callId` is the credential |

### `/turn` event vocabulary

```
{type:'pairing_required', spreadsheetName}   waiting on the dashboard
{type:'paired'}                              approved, proceeding
{type:'session', model, sessionId, resumed}   Claude started
{type:'tool_call', callId, name, args}       execute this and POST /op-result
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
`--strict-mcp-config` drops MCP servers, `--tools ""` removes every tool, and cwd
is a neutral `~/.claude-sheets/workspace` so no `CLAUDE.md` is discovered.

Claude's **only tools are ours**: five sheet tools served by `mcp-bridge.js`
(granted with `--allowedTools "mcp__sheets"`, verified as the only entries on
the `init` line). Every call is executed by the *sidebar* through Apps Script,
behind the confirmation gate — this process cannot touch a spreadsheet, it can
only ask. So a prompt injection hidden in a cell cannot reach your filesystem —
worst case is one spreadsheet, which the undo history covers.

**`--tools ""` and never a denylist.** This was `--disallowedTools` naming ten
tools, and a live `init` line showed eighteen others still available, including
`CronCreate`, `Workflow`, and `SendMessage`. A denylist excludes only what
existed when it was written. `daemon/test/isolation.test.js` fails if anyone
reintroduces one; the CLI-side proof is `init` reporting `tools: []`, which is
worth re-checking after a Claude Code upgrade.

**Hooks are the exception.** They fire regardless of cwd and regardless of
`--settings '{"hooks":{}}'` (that flag merges, it does not replace). `--bare`
would stop them but never reads OAuth, which breaks subscription auth. Their
output is filtered so it never reaches the sidebar, but the latency stays.

Instructions — global and per-spreadsheet — live in `state.json`, not in Claude
Code projects or auto-memory. Sheet preferences help; coding-project context does
not.

## One conversation per spreadsheet

A turn continues the previous turn for the same spreadsheet, so "now make it
bold" has a referent. The session ID is minted here, stored per spreadsheet in
`state.json`, and passed as `--session-id` on the first turn and `--resume`
after. `POST /reset` ends it; the sidebar's **New chat** does that.

Sessions are therefore written to disk, which `--no-session-persistence` used to
prevent — the two are mutually exclusive, since a conversation that was never
saved cannot be resumed. They do not land in your coding history: cwd is the
neutral workspace, so they go to that path's own project bucket
(`~/.claude/projects/…-claude-sheets-workspace/`).

A stored ID whose session has been deleted is **not** an error the user sees.
The resume attempt is held silent until the CLI confirms the session opened; if
it never does, a fresh session starts and the turn proceeds normally.

## Cost

Every turn pays ~25,000 tokens of CLI baseline, whatever the model. Measured on
an identical trivial prompt, on a fresh session:

| Model | Cost |
|---|---|
| Fable 5 | $0.4987 |
| Sonnet 5 | $0.1498 |

Hence the `claude-sonnet-5` default rather than whatever you use for coding.
Change it in `state.json` → `settings.model`.

Resuming is where the real saving is, because the baseline becomes a cache read
instead of a cache write. Measured across two turns of one Sonnet 5 session:

| | Cost | `cache_creation` | `cache_read` |
|---|---|---|---|
| First turn | $0.0449 | 6,545 | 18,660 |
| Resumed turn | $0.0081 | 88 | 25,205 |

The longer a conversation runs the more of it is cached, so **New chat** costs
more than the turn before it. That is the trade for having the context.

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
src/index.js      HTTPS server, routes, pairing lifecycle, tool-call relay
src/claude.js     CLI resolution, spawn, stream-json parsing
src/mcp-bridge.js stdio MCP server the CLI spawns; forwards tool calls here
src/store.js      on-disk paired list + activity index
src/dashboard.js  dashboard HTML
```

## Status

M8 complete. Eleven tools: read, four value ops, and six structural ops (rows,
columns, tabs) with inverse-op undo. Verified live through the loop: "delete the
Gadget row" produced read_range, the correct delete_rows index derived from what
it read, and add_sheet — one conversation. M9 (mid-turn edit detection) and M5.5
(web search/fetch behind the gate) are next.
