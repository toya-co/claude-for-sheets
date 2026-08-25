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
git clone <this repo> && cd claude-sheets-sidebar/daemon
npm run certs     # once — makes the loopback certificate
npm start
```

No dependencies to install; it is Node standard library only. Open **https://localhost:8443/** and accept the certificate warning once per browser — it is self-signed, for your own machine, and a browser has no way to tell the difference.

That page is the dashboard. Leave it open or don't; the app runs either way.

### 2. The add-on

Three routes, easiest first. All three end at the same place.

**Copy a spreadsheet that already has it.** The bound script travels with the copy. Open the copy, **Claude ▸ Open sidebar**, authorize once, and it works — nothing to install. This is what a template sheet is for.

**Paste two files.** For a spreadsheet you already have and care about.

1. **Extensions ▸ Apps Script**
2. Paste [`addon/dist/Claude.gs`](addon/dist/Claude.gs) over the default `Code.gs`
3. Add an HTML file named exactly `Sidebar` and paste [`addon/Sidebar.html`](addon/Sidebar.html) into it
4. **Services ▸ +** and add **Google Sheets API**
5. Save, reload the spreadsheet tab, then **Claude ▸ Open sidebar** and authorize

**With clasp.** `cd addon && clasp push`. Worth the setup only if you intend to track this repo — [`addon/README.md`](addon/README.md) is the walkthrough, including the account-level Apps Script API switch that makes every first push fail.

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

Full design in [`ARCHITECTURE.md`](ARCHITECTURE.md). The op contract both halves depend on is [`shared/protocol.md`](shared/protocol.md).

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
addon/       Apps Script — sidebar, sheet I/O, history
daemon/      Local app — credential, loopback API, dashboard
shared/      Op protocol — the contract both halves depend on
experiments/ Platform probes; re-run before releases
```

## License

[Apache-2.0](LICENSE) © Toyo Co.

Apache rather than MIT for the explicit patent grant — a longer file, and one less thing for anyone adopting it to think about.
