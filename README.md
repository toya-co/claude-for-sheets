# Claude for Google Sheets

A Claude chat sidebar inside Google Sheets, with a restorable edit history — click any past change to roll it back, formats and formulas included. It runs on your own Claude subscription, on your own machine.

> Requires [Claude Code](https://claude.com/claude-code) installed and signed in, and Node 18+. Nothing is hosted, no API key is needed, and no Google token is stored anywhere by anyone. An API key works instead if you prefer.

## Features

- **Reads before it writes** - it pulls the range it needs, sees the result of each change, and continues. A turn can be many edits
- **Every change is its own undo entry** - open History and roll back any single one. Values, formulas *and* formatting come back
- **Anything destructive asks first** - overwriting a formula, replacing more than ten filled cells, clearing, deleting a tab. Writing into empty cells does not ask, because that is not a risk
- **Your typing wins** - edit a cell while Claude is working and its write aborts rather than overwriting you. It re-reads and carries on
- **Stop** - Send becomes Stop mid-turn, and Escape does the same. What already landed stays landed and is still undoable
- **32 sheet tools** - values, formulas, formatting, borders, structure, merge/sort/layout, conditional formats, validation, notes, named ranges
- **Web search and fetch, gated** - every request stops at an Allow/Skip card showing the full URL. Local and private addresses are refused outright, no card
- **Model picker** - beside the message box, applies from the next turn
- **One conversation per spreadsheet** - resumed turn to turn, so "now make it bold" has a referent. **New chat** ends it
- **A local dashboard** - setup, activity, cost per turn, settings, and reference pages. Its capability list is generated from the tools themselves, so it cannot drift

Not yet: charts, pivot tables, filters, protected ranges. It says so rather than improvising.

## Install

Two halves. The local app once per machine, the add-on once per spreadsheet.

### 1. The local app

```bash
git clone https://github.com/toya-co/claude-for-sheets.git && cd claude-for-sheets/daemon
npm run certs     # once — makes the loopback certificate
npm start
```

No dependencies to install; it is Node standard library only. Open **https://localhost:8443/** and accept the certificate warning once per browser — it is self-signed, for your own machine, and a browser has no way to tell the difference.

That page is the dashboard. Leave it open or don't; the app runs either way.

### 2. The add-on

Three routes. All three end at the same place.

**Paste two files.** Start here. No tooling, five minutes.

1. **Extensions ▸ Apps Script**
2. Paste [`addon/dist/Claude.gs`](addon/dist/Claude.gs) over the default `Code.gs`
3. Add an HTML file named exactly `Sidebar` and paste [`addon/Sidebar.html`](addon/Sidebar.html) into it
4. **Services ▸ +** and add **Google Sheets API**
5. Save, reload the spreadsheet tab, then **Claude ▸ Open sidebar** and authorize

**Copy a spreadsheet that already has it.** Once one sheet has the add-on, the bound script travels with any copy of it. Open the copy, **Claude ▸ Open sidebar**, authorize once, and it works — nothing to install. Quickest way to a second sheet, and what a template sheet is for.

**With clasp.** `cd addon && clasp push`. Worth the setup only if you intend to track this repo — **Installing the add-on with clasp** below is the walkthrough, including the account-level Apps Script API switch that makes every first push fail.

The first turn in a new spreadsheet waits for you to approve it on the dashboard. That approval happens there and not in the sidebar on purpose: a web page must not be able to grant itself access.

## Usage

Ask for a change — *"put the total in B7 and bold it"*. Then ask a follow-up that refers back to it — *"now make it a percentage"* — to see the conversation carry.

- **History** (the clock icon) - every change, newest first. Click Undo on any one
- **New chat** (the + icon) - ends the conversation. The sheet's edit history is untouched
- **Settings** (the third icon) - shows what the app is set to, and links to the dashboard for the rest

Per-spreadsheet instructions live on the dashboard: *"Dates as ISO. Keep totals bold. Never edit column A."*

## The permission it asks for

Google's consent screen will say this add-on can see and edit **all** your spreadsheets. That is accurate about the grant and not about what it does — every call it makes targets the spreadsheet it is installed in, and the code is here to read.

The reason is a platform constraint. Apps Script's narrow `spreadsheets.currentonly` scope and `SpreadsheetApp.openById()` are mutually exclusive, and `openById` is the only measured way to write without landing in your native Ctrl+Z stack. So the choice was a real restorable history with the broad scope, or the narrow scope with Claude's edits tangled into your own undo. This takes the first. If that trade is wrong for you, it is the one decision worth forking over.

**Ctrl+Z does not undo Claude's edits, and that is deliberate.** Your own typing undoes normally; Claude's changes are governed entirely by the in-sheet history. Two undo systems that never touch the same edits — otherwise one keystroke could collapse a whole turn's work with no record of what it removed.

## How it works

The add-on never sees the model. The local app never sees Google.

Apps Script hosts the sidebar and does all sheet I/O. The sidebar talks over HTTPS loopback to the local app, which holds your Claude credential and runs the turn. When Claude calls a tool, the **sidebar** executes it — the local app only relays. So a prompt injection hidden in a cell is talking to something that cannot write to your sheet.

History lives in a hidden `__claude_history__` sheet inside your spreadsheet, so snapshots never leave the file, travel with it when shared, and restore even with the app closed.

More detail under **Under the hood** below. The op contract both halves depend on is [`shared/protocol.md`](shared/protocol.md).

## Updating

`git pull`, then quit the local app from the dashboard and start it again. If you installed the add-on by pasting, re-paste both files; with clasp, `clasp push --force`.

A sidebar newer than the local app will tell you so rather than claiming the app is unreachable. Start-at-login means there is usually already one running, so `npm start` alone will refuse the port.

## Development

```bash
npm test          # 257 tests, ~2s
npm run check     # release preflight: automated pass, then a manual checklist
npm run bundle    # regenerate addon/dist/Claude.gs
```

No browser, no Google account, and no Claude invocation are involved — the add-on half runs against a fake `SpreadsheetApp`, the daemon half against recorded CLI output.

```
addon/           Apps Script — sidebar, sheet I/O, history
  Code.gs        Menu, sidebar host, the google.script.run entry points
  Sheet.gs       Reading — context, ranges, the mid-turn guard's hash
  Ops.gs         Every write, and the inverse recorded for each one
  History.gs     Snapshots and the hidden __claude_history__ sheet
  Sidebar.html   The whole UI — markup, style, turn loop
  dist/          Generated: the four .gs files concatenated, for pasting

daemon/          Local app — credential, loopback API, dashboard
  src/index.js       HTTPS server, routes, pairing, tool-call relay
  src/claude.js      CLI resolution, spawn, stream-json parsing
  src/mcp-bridge.js  stdio MCP server the CLI spawns; forwards calls back
  src/store.js       Paired list, activity index, settings
  src/web-gate.js    PreToolUse hook gating web search and fetch
  src/autostart.js   Start at login
  src/dashboard/     The dashboard page

shared/          Op protocol — the contract both halves depend on
```

Apps Script shares one global scope across every file in a project, which is why `dist/Claude.gs` exists and why the paste install is two files rather than five.

---

## Under the hood

Everything below is reference. You can install and use this without reading any of it.

<details>
<summary><b>The local app's HTTP API</b></summary>

<br>

| Route | Purpose |
|---|---|
| `GET /` | The dashboard. Carries the dashboard token, and deliberately sends no CORS headers so no other page can read it |
| `GET /ping` | Health — `{ok, version, credentialReady}`. The sidebar's status dot |
| `GET /status` | Everything the dashboard renders. **Token-guarded** |
| `POST /turn` | The turn. SSE stream out; body `{spreadsheetId, spreadsheetName, prompt, context}` |
| `POST /prefs` | The sidebar's door. `{spreadsheetId}` reads model, askBefore, webAccess and the model list; adding `model` sets it. Gated on the sheet being paired, and it accepts no other key |
| `POST /pair` | `{spreadsheetId, allow}` — settles a pending request. Token-guarded |
| `POST /reset` | `{spreadsheetId}` — ends the conversation, keeps the pairing |
| `POST /unpair` | `{spreadsheetId}` — revokes |
| `POST /settings` | Global settings. Token-guarded |
| `POST /bridge/call` | MCP bridge only — relays a tool call to the sidebar |
| `POST /op-result` | The sidebar answering one; the unguessable `callId` is the credential |
| `POST /gate` | Web-gate hook only — relays a web request to the sidebar |
| `POST /gate-result` | The sidebar answering one. No answer means deny |

The `/turn` stream:

```
{type:'pairing_required', spreadsheetName}   waiting on the dashboard
{type:'paired'}                              approved, proceeding
{type:'settings', askBefore, webAccess}      this turn's rules
{type:'session', model, sessionId, resumed}  Claude started
{type:'tool_call', callId, name, args}       execute this, POST /op-result
{type:'gate', gateId, tool, detail}          ask the human, POST /gate-result
{type:'text', delta}                         incremental output
{type:'done', costUsd, usage}                turn complete
{type:'error', code, message}                AUTH_FAILED · CLI_NOT_FOUND · …
```

Timeouts nest on purpose: a tool call waits 5 minutes, a web gate 4, and the hook's own limit sits inside the CLI's — a killed hook emits no decision, and no decision means the tool runs.

</details>

<details>
<summary><b>Why pairing is the auth boundary</b></summary>

<br>

It has to be. CORS cannot be one: the sidebar's origin is `n-<rotating-hash>-script.googleusercontent.com`, the hash is not stable, so no allowlist is possible and `*` is the only workable answer. **Any page can reach this app.**

So a first request from an unrecognized spreadsheet is *held* while the dashboard prompts, and approval is by spreadsheet ID, confirmed out-of-band in a UI the web cannot drive. A hostile page can knock; it cannot let itself in. Unapproved requests time out after three minutes.

This is also why the sidebar cannot change the confirmation gate or web access. It is a web page, so anything that could steal its credentials could switch your protections off. It gets `POST /prefs`, which accepts a model and nothing else.

</details>

<details>
<summary><b>Isolation — a spreadsheet editor, not a coding agent</b></summary>

<br>

Every invocation strips what the CLI would otherwise inherit: `--system-prompt` replaces the coding prompt, `--strict-mcp-config` drops your MCP servers, `--tools ""` removes every built-in tool, and cwd is a neutral `~/.claude-sheets/workspace` so no `CLAUDE.md` is discovered by tree walk.

Claude's only tools are ours, granted with `--allowedTools "mcp__sheets"` and served by `mcp-bridge.js`. Every call is executed by the **sidebar** through Apps Script, behind the confirmation gate — the local app cannot touch a spreadsheet, it can only ask. So a prompt injection hidden in a cell cannot reach your filesystem, and its worst case is one spreadsheet, which the edit history covers.

**`--tools ""`, and never a denylist.** This was `--disallowedTools` naming ten tools, and a live `init` line showed eighteen others still reachable, including `CronCreate` and `Workflow`. A denylist excludes only what existed when it was written. `daemon/test/isolation.test.js` fails if anyone reintroduces one.

**Hooks are the exception.** They fire regardless of cwd and regardless of `--settings '{"hooks":{}}'` — that flag merges rather than replaces. `--bare` would stop them but never reads OAuth, which breaks subscription auth. Their output is filtered so it never reaches the sidebar, but the latency stays.

</details>

<details>
<summary><b>One conversation per spreadsheet, and what it costs</b></summary>

<br>

A turn continues the previous turn for the same spreadsheet. The session ID is minted by the local app, stored per spreadsheet, and passed as `--session-id` on the first turn and `--resume` after. **New chat** ends it.

A stored session that has been deleted is not an error you see: the resume is held silent until the CLI confirms the session opened, and if it never does, a fresh one starts and the turn proceeds normally.

Every turn pays roughly 25,000 tokens of CLI baseline whatever the model, which is why the model matters more than message length. Measured on an identical trivial prompt, fresh session:

| Model | Cost |
|---|---|
| Fable 5 | $0.4987 |
| Sonnet 5 | $0.1498 |

Resuming is where the saving is, because that baseline becomes a cache read instead of a cache write. Two turns of one Sonnet 5 session:

| | Cost | `cache_creation` | `cache_read` |
|---|---|---|---|
| First turn | $0.0449 | 6,545 | 18,660 |
| Resumed | $0.0081 | 88 | 25,205 |

The longer a conversation runs the more of it is cached, so **New chat** costs more than the turn before it. That is the trade for having the context.

</details>

<details>
<summary><b>Installing the add-on with clasp</b></summary>

<br>

Google's CLI is [`@google/clasp`](https://github.com/google/clasp); this was written against **3.4.0**.

**1.** `npm install -g @google/clasp && clasp login`

**2. Turn on the Apps Script API for your account** — https://script.google.com/home/usersettings, switch **Google Apps Script API** to On. This is the step everyone misses. It is off by default, and without it every push fails with an error about the Apps Script API that reads like a spreadsheet permissions problem.

**3.** In your spreadsheet, **Extensions ▸ Apps Script** — opening the editor is what *creates* the bound project — then **⚙ Project Settings ▸ Script ID**, and copy it.

**4.** `cp addon/.clasp.json.example addon/.clasp.json` and paste the ID in. That file is gitignored because it names *your* spreadsheet's project.

**5.** `cd addon && clasp push`

The first push asks whether to overwrite the remote manifest. **Say yes** — `appsscript.json` is what enables the Sheets advanced service, and declining leaves borders and conditional formatting with an undo that has nothing to restore. `--force` answers yes without asking, and is required anywhere stdin is not a terminal: a scripted push takes the default, which is to *skip* the manifest.

**`.claspignore` must stay.** `clasp push` uploads everything under `rootDir`, and `addon/` holds a Node test suite — Apps Script would pull its helpers, including a fake `SpreadsheetApp`, into the same global namespace the real files share, and the add-on breaks on load with no obvious cause. `clasp status` lists exactly what a push would send: seven files.

</details>

<details>
<summary><b>Where things are stored</b></summary>

<br>

`~/.claude-sheets/state.json` — paired spreadsheets, the activity index (newest first, capped at 500), settings, and per-spreadsheet instructions. Deliberately not in Claude Code's projects or auto-memory: sheet preferences help, coding-project context does not.

Snapshot payloads are deliberately **not** there. They live in a hidden sheet inside your own spreadsheet, so restore works with the local app closed, and travels with the file when you share it.

The certificate is generated, never shared — `*.pem` is gitignored. `npm run certs` remakes it; it refuses to overwrite an existing one without `--force`.

</details>

<details>
<summary><b>Two things that must not be changed back</b></summary>

<br>

**The CLI is resolved to an absolute path and spawned with `shell: false`.** The argument list carries the prompt, which embeds spreadsheet cell content you did not write. Passing that through a shell is a command-injection vector.

**`--bare` is not used**, despite suppressing hook noise on every invocation. Its own help states "OAuth and keychain are never read", which breaks subscription auth. Hook and init lines are filtered in `claude.js` instead.

</details>

## License

[Apache-2.0](LICENSE) © Toyo Co.

Apache rather than MIT for the explicit patent grant — a longer file, and one less thing for anyone adopting it to think about.
