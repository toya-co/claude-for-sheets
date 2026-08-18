# Claude Sidebar for Google Sheets

A Claude chat sidebar inside Google Sheets that reads and edits your spreadsheet,
with a **clickable, restorable edit history** instead of hoping Ctrl+Z catches it.

Runs on **your own Claude subscription** via a local companion app, or on your own
API key. Nothing is hosted — the model call originates on your machine, and no
server of ours sits in the middle.

> **Status: pre-alpha. Nothing is usable yet.**
> Platform feasibility is proven (see `experiments/`), architecture is designed
> (see `ARCHITECTURE.md`), and implementation has not started.

---

## Why it exists

Existing Sheets AI add-ons undo one step, on one tab, restoring values but not
formatting. That is not a safety net for an agent editing a spreadsheet. This one
snapshots values, formulas, and formats before every write, models structural
operations (insert/delete rows, add/remove sheets) with explicit inverses, and
keeps a history you can scroll back through and restore from — across tabs and
across sessions.

Agent writes deliberately bypass the native undo stack, so `Ctrl+Z` keeps doing
exactly what it always did for *your* typing while the agent's changes are
governed entirely by the restorable history. The two never collide.

## How it fits together

Two halves in this repo:

- **`addon/`** — a container-bound Apps Script project: the sidebar UI and all
  sheet I/O. Requests only `spreadsheets.currentonly` and stores no credentials.
- **`daemon/`** — a local app that holds your Claude credential, serves the
  sidebar over HTTPS loopback, and is also the dashboard (activity across every
  spreadsheet it has served, settings, paired-sheet approvals).
- **`shared/`** — the operation protocol both halves speak. Transport-agnostic on
  purpose, so the same vocabulary can back an MCP server later.

Full design in [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Platform findings

Three things this depends on are undocumented by Google. All three were measured
rather than assumed, and the harnesses are in [`experiments/`](experiments/) so
you can re-run them:

| # | Question | Result |
|---|---|---|
| 1 | Can an Apps Script sidebar reach third-party HTTPS origins, and stream? | Yes, including SSE |
| 2 | Do Apps Script writes enter the native undo stack? | Bound writes do; `openById` writes escape it |
| 3 | Can the sidebar reach an HTTPS server on `127.0.0.1`? | Yes, including SSE |

Because these are undocumented, they can change without a deprecation notice.
Re-run the probes before trusting a release.

## Verification record

[`PLAN.md`](PLAN.md) is the Phase 0 record — every claim that was checked against
primary sources, what was confirmed, what could not be, and which planning
assumptions the results overturned. Kept because the reasoning matters more than
the conclusions when the platform shifts.

## License

Not yet chosen — see `ARCHITECTURE.md` §11.
