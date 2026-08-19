# Claude for Google Sheets

A Claude chat sidebar inside Google Sheets, with a **restorable edit history** —
click any past change to roll back to it, formats and formulas included.

Two halves, both open source, no server involved:

- **`addon/`** — a container-bound Apps Script add-on. Hosts the sidebar and does
  all sheet I/O. Requests only `spreadsheets.currentonly`, so it can touch the
  spreadsheet it is installed in and nothing else.
- **`daemon/`** — a local app you run on your own machine. Holds your Claude
  credential, serves the sidebar over HTTPS loopback, and is also the dashboard.

Because the model call originates on your machine, it runs on **your own Claude
subscription** via a local Claude Code install. No API key required, no inference
billed to anyone else. If you would rather use an API key, BYOK works too.

Nothing is hosted. No Google tokens are stored anywhere, by anyone.

---

## Status

**M4.5 — the round trip works and remembers.** Type an instruction, the local app
runs it on your Claude subscription, the cell changes, and the change is undoable
from the sidebar. Turns continue each other, so "now make it bold" knows what
"it" is.

| Milestone | State |
|---|---|
| Platform probes (`experiments/`) | ✅ all three passed |
| M1 add-on skeleton | ✅ verified in a live sheet |
| M2 daemon: HTTPS loopback, pairing, `claude -p` | ✅ verified by `curl` |
| M3 first real round-trip edit | ✅ architecture checkpoint passed |
| M4 streaming · M6 one-button undo | ✅ landed with M3 |
| M4.5 one conversation per spreadsheet | ✅ memory, and 5.5× cheaper per turn |
| M7 restorable history | ◐ lists and undoes any entry; restoring entry 3 of 7 must still invalidate 4–7 |
| M5 multi-op tool loop + confirmation gate | next |

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
the conversation carry, and **History** to roll the change back.

---

## Design notes worth knowing

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
addon/       Apps Script add-on — sidebar host and sheet I/O
daemon/      Local app — credential, loopback API, dashboard (M2)
shared/      Op protocol — the contract both halves depend on
experiments/ Platform probes; re-run before releases
```

## License

TBD before first release.
