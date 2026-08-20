# Claude for Google Sheets

A Claude chat sidebar inside Google Sheets, with a **restorable edit history** —
click any past change to roll back to it, formats and formulas included.

Two halves, both open source, no server involved:

- **`addon/`** — a container-bound Apps Script add-on. Hosts the sidebar and does
  all sheet I/O. Requests `spreadsheets.currentonly` — so it can touch the
  spreadsheet it is installed in and nothing else — plus `script.container.ui`,
  which only permits drawing the sidebar and grants no data access.
- **`daemon/`** — a local app you run on your own machine. Holds your Claude
  credential, serves the sidebar over HTTPS loopback, and is also the dashboard.

Because the model call originates on your machine, it runs on **your own Claude
subscription** via a local Claude Code install. No API key required, no inference
billed to anyone else. If you would rather use an API key, BYOK works too.

Nothing is hosted. No Google tokens are stored anywhere, by anyone.

---

## Status

**M8 — Claude works your sheet with live tools, structure included.** It reads
ranges when it needs to, edits values, formulas, formats, rows, columns, and
tabs through tool calls, sees each result, and keeps going — like Claude in
Chrome, wrapped in your sidebar. Turns continue each other, every change is its
own undo entry, and anything destructive asks first.

| Milestone | State |
|---|---|
| Platform probes (`experiments/`) | ✅ all three passed |
| M1 add-on skeleton | ✅ verified in a live sheet |
| M2 daemon: HTTPS loopback, pairing, `claude -p` | ✅ verified by `curl` |
| M3 first real round-trip edit | ✅ architecture checkpoint passed |
| M4 streaming · M6 one-button undo | ✅ landed with M3 |
| M4.5 one conversation per spreadsheet | ✅ memory, and 5.5× cheaper per turn |
| M5 multi-op turns + confirmation gate | ✅ four value ops, per-op undo, stale-context guard |
| M5.7 live tool loop (read, write, continue) | ✅ verified end to end |
| M7 restorable history | ✅ undo any entry; blocked when a later edit overlaps |
| M8 rows, columns, and tabs — with undo | ✅ deletes snapshot first; sheet deletes always ask |
| M9 mid-turn edit detection | ✅ your typing aborts Claude's write, never the reverse |
| M5.5 web search and fetch, behind the gate | next |

Full plan in [`ARCHITECTURE.md`](ARCHITECTURE.md). The platform verification
behind it is in [`PLAN.md`](PLAN.md).

---

## Try it

You need a Google account, a scratch spreadsheet, and Claude Code installed and
signed in.

1. `cd daemon && npm run certs && npm start`, then open
   **https://localhost:8443/** once and accept the self-signed certificate.
2. Open a spreadsheet → **Extensions ▸ Apps Script**.
3. Copy in every file from `addon/` (the HTML files must be named exactly
   `Sidebar` and `Diagnostic`). Or `clasp push` if you have it set up.
4. Save, reload the spreadsheet tab, then **Claude ▸ Open sidebar** and authorize.
5. Ask for a change — "put today's total in B7". The first request for a new
   spreadsheet waits for you to approve it on the dashboard.

Then ask a follow-up that refers back to the first ("now make it bold") to see
the conversation carry, and **History** to roll any single change back.

Run the tests with `npm test` from the repo root. No browser, no Google account,
no Claude invocation — the add-on half runs against a fake `SpreadsheetApp` and
the daemon half against recorded CLI output.

---

## Design notes worth knowing

**If you type while Claude is working, you win.** Every write carries a
fingerprint of the data Claude read. Apps Script re-checks it in the same
instant it writes, so an edit you made in between aborts the write rather than
being silently overwritten — the whole turn stops before anything changes,
Claude re-reads, and continues against what is actually there. A second signal
catches edits outside the range it was looking at.

**Nothing destructive happens without a question.** Overwriting a formula asks
every time, even for one cell — replacing a formula with its own current value
looks like nothing changed and quietly kills what computed it. Overwriting more
than ten cells that already hold something asks. Clearing anything asks. Writing
into empty cells does not, because that is not a risk. The check runs in Apps
Script rather than the sidebar, so a prompt injection hidden in a cell cannot
talk its way past it.

**Agent edits do not touch your Ctrl+Z.** Writes go through
`SpreadsheetApp.openById()` rather than the bound handle, which — measured, not
assumed — keeps them out of the native undo stack. Your own typing still undoes
normally; Claude's changes are governed entirely by the in-sheet history. Two
undo systems that never touch the same edits.

**The conversation is per spreadsheet, and endable.** Each sheet gets its own
Claude Code session, resumed turn to turn, so context carries and the CLI's
startup cost is read from cache instead of paid again. **New chat** ends it. The
transcript lives in Claude Code's own store under a neutral workspace path — not
mixed into your coding history.

**History lives in your spreadsheet.** Snapshots go to a hidden
`__claude_history__` sheet, so they never leave the file, travel with it when
shared, and restore even with the daemon closed. A safety feature should not have
a running-process dependency.

**Everything rests on three probes.** The sidebar reaching non-Google origins,
`openById` escaping native undo, and the sidebar reaching `127.0.0.1` over TLS
are all **undocumented** Google behaviors that were measured rather than looked
up. `experiments/` re-runs all three in a few minutes; do that before any release.

---

## Repo layout

```
addon/       Apps Script add-on — sidebar host, sheet I/O, undo history
addon/test/  Runs the .gs files against a fake SpreadsheetApp
daemon/      Local app — credential, loopback API, dashboard
daemon/test/ stream-json fixtures from the real CLI
shared/      Op protocol — the contract both halves depend on
experiments/ Platform probes; re-run before releases
```

## License

TBD before first release.
