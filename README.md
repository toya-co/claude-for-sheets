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

**M2 — daemon works.** The sidebar reads real sheet context; the local app pairs,
invokes Claude, and streams back. They are not wired to each other yet — that is
M3, and it is the architecture checkpoint.

| Milestone | State |
|---|---|
| Platform probes (`experiments/`) | ✅ all three passed |
| M1 add-on skeleton | ✅ verified in a live sheet |
| M2 daemon: HTTPS loopback, pairing, `claude -p` | ✅ verified by `curl` |
| M3 first real round-trip edit | next — the architecture checkpoint |
| M4+ streaming, tool loop, undo, history UI, dashboard | — |

Full plan in [`ARCHITECTURE.md`](ARCHITECTURE.md). The platform verification
behind it is in [`PLAN.md`](PLAN.md).

---

## Try M1

You need a Google account and a scratch spreadsheet.

1. Open a spreadsheet → **Extensions ▸ Apps Script**.
2. Copy in `addon/Code.gs`, `addon/Sheet.gs`, and `addon/Sidebar.html` (the HTML
   file must be named exactly `Sidebar`). Or `clasp push` if you have it set up.
3. Save, reload the spreadsheet tab.
4. **Claude ▸ Open sidebar**, authorize, then **Read sheet context**.

You should get the tab manifest, a preview of the active range, and a context
hash — proving the sidebar↔Apps Script round trip works end to end.

---

## Design notes worth knowing

**Agent edits do not touch your Ctrl+Z.** Writes go through
`SpreadsheetApp.openById()` rather than the bound handle, which — measured, not
assumed — keeps them out of the native undo stack. Your own typing still undoes
normally; Claude's changes are governed entirely by the in-sheet history. Two
undo systems that never touch the same edits.

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
