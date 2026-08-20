# Operation protocol

The contract between the sidebar and Apps Script. Both halves of the repo depend
on it, which is why it lives here rather than inside either one.

**The live transport is the MCP tool loop** (`daemon/src/mcp-bridge.js`): Claude
calls tools named 1:1 after the ops below (`read_range`, `set_values`,
`merge_cells`, `sort_range`, …), and the sidebar translates each into an op and
executes it. The envelope, the gate, and undo semantics in this file are
unchanged by that — tools are a delivery mechanism for ops, not a second
protocol.

**Keep it transport-agnostic.** The same vocabulary runs over `google.script.run`
today and over the Sheets REST API in the headless/MCP path later
(`ARCHITECTURE.md` §7). Anything Apps-Script-shaped that leaks into these
definitions is a migration paid for twice.

---

## Envelope

**A turn is a list of ops, not one op.** They apply in order, and each becomes
its own undo entry — so a request that changes two unrelated things can be walked
back one at a time.

**Request**

```json
{
  "ops": [
    { "opId": "op_01H…", "type": "setValues", "sheetName": "Sheet1",
      "a1": "B2", "values": [["…"]] }
  ],
  "guard": { "sheetName": "Sheet1", "a1": "A1:E20", "hash": "9f2c…" },
  "confirmed": ["op_01H…"]
}
```

| Field | Notes |
|---|---|
| `ops` | Applied in order. Execution stops at the first failure or unconfirmed gate. |
| `guard` | The region `getContext` read, and its hash. Re-checked once, before any op runs. Omit to skip the check. |
| `confirmed` | `opId`s the user has explicitly approved. See **The confirmation gate**. |

Per op:

| Field | Notes |
|---|---|
| `opId` | Client-generated, unique per op. Becomes the history entry key, and the name `confirmed` refers to. |
| `type` | One of the op types below. |
| `sheetId` | Numeric Sheets ID. Preferred — names are user-editable and change under you. |
| `sheetName` | Accepted, and what the model actually emits, since names are all it sees. `sheetId` wins when both are present. |
| `a1` | Top-left anchor for grid ops; the written range is sized from the payload. The range itself for `clear`. |

**The guard is the context's region, not the op's.** It carries the hash of the
range `getContext` returned, and that same range is re-hashed before the turn
runs. Hashing an op's own target instead compares two different ranges, which can
only agree by accident.

**Response**

```json
{
  "ok": false,
  "turnId": "turn_01H…",
  "results": [
    { "ok": true, "opId": "op_01H…", "type": "setValues",
      "applied": "Sheet1!B2", "restorable": true, "newContextHash": "4b71…" },
    { "ok": false, "opId": "op_01H…", "needsConfirmation": true,
      "target": "Sheet1!D2:D9", "reason": "overwrites 2 formulas",
      "error": { "code": "NEEDS_CONFIRMATION", "message": "…" } }
  ]
}
```

`ok` is true only when every op succeeded. `turnId` groups the resulting history
entries for display without merging them. A guard failure returns `{ok, error}`
with no `results` — nothing was attempted.

`error.code` is machine-readable: `CONTEXT_STALE`, `NEEDS_CONFIRMATION`,
`BAD_PAYLOAD`, `RANGE_TOO_LARGE`, `NOT_IMPLEMENTED`, `SHEET_NOT_FOUND`,
`APPLY_FAILED`.

**Ops stop at the first failure** rather than pressing on. Later ops in a turn
are usually planned against the state the earlier ones were meant to produce, so
continuing past a failure applies them to a sheet that never got there. Whatever
already ran stays applied and stays individually undoable.

---

## The confirmation gate

An op that would destroy existing content is returned with
`needsConfirmation: true` instead of being applied. The caller shows the user
`reason` and `target`, and re-submits with that `opId` in `confirmed` if they
approve.

Three things make an op destructive, and they are different in kind:

| Trigger | Why it is not just a cell count |
|---|---|
| Overwrites **any formula** | Replacing a formula with its current value looks identical in the grid and destroys the thing that computed it. Always ask, even for one cell. |
| Overwrites **more than 10 occupied cells** | One cell is a typo fix; forty is a column of someone's data. |
| `clear` that would remove anything | Unlike a write, it leaves nothing behind to notice. |

Formatting is never gated: it destroys no content, and the snapshot captures
formats anyway.

**The gate is enforced by the executor, not the caller.** The sidebar renders the
question, but Apps Script re-inspects at apply time against the sheet as it is
*now* — including whatever the previous op in the same turn just changed. A
dry-run `inspectOps()` exists for the UI, and is advisory only. The sidebar is
the half a prompt injection could plausibly reach; the gate must not live there.

---

## Value ops

Bounded to a range. Invertible by snapshotting that range before writing.

| `type` | `payload` |
|---|---|
| `setValues` | `{values: [[…]]}` — 2-D, row-major, even for one cell |
| `setFormulas` | `{formulas: [[…]]}` — same shape |
| `setFormats` | `{format: {background, fontColor, bold, italic, numberFormat, align}}` |
| `clear` | `{what: "all" \| "values" \| "formats"}` |

`setFormats` takes **one format object applied to the whole range**, not a grid
per property. A model emits that reliably; parallel 2-D arrays of backgrounds and
font weights it does not. The format object accepts `background`, `fontColor`,
`bold`, `italic`, `numberFormat`, `align`, `fontSize`, `fontFamily`, `wrap`,
`verticalAlign`, and `fontLine` (`underline` | `line-through` | `none`).
Snapshots still capture the full per-cell formatting, so an undo restores
exactly what was there.

A snapshot captures **values, formulas, and formats together**. Restoring values
alone leaves the sheet visibly wrong, and that gap is the specific weakness in
the competing product.

## Range ops

Range-scoped like the value ops, and undone the same way — a snapshot of the
rectangle — so they share the rectangle-overlap conflict rule for undo.

| `type` | Payload | Gate |
|---|---|---|
| `mergeCells` | `{a1, mergeType: "all" \| "across" \| "vertical"}` | Asks when merging would destroy any content: only the first cell of each merged block survives, like `clear`, it leaves nothing behind to notice |
| `unmergeCells` | `{a1}` | Never — no values are lost |
| `sortRange` | `{a1, by: [{column, ascending}]}` | Asks when the range holds formulas — sorting rearranges their relative references, which can silently change results |

`sortRange` columns are absolute sheet columns (letter or 1-based number) and
must fall inside the range. Sorting is a permutation — nothing is destroyed —
and the snapshot restores the exact original order. A merge records the merged
blocks it absorbed; its undo is breakApart, restore the snapshot, then re-merge
what was there before. An unmerge records what it broke and re-merges it on undo.

## Layout ops

Presentation, not content: widths, heights, frozen panes, hidden spans, tab
names and visibility. Each records just enough prior state to undo exactly, no
snapshot payload. **None is ever gated** — nothing is destroyed and every one
restores cleanly.

| `type` | Payload | Inverse |
|---|---|---|
| `setColumnWidth` | `{index, count, width}` | prior width per column |
| `setRowHeight` | `{index, count, height}` | prior height per row |
| `freezePanes` | `{rows?, cols?}` (0 unfreezes) | prior frozen counts |
| `renameSheet` | `{newName}` | rename back |
| `hideRows` / `showRows` | `{index, count}` | prior per-row hidden state |
| `hideColumns` / `showColumns` | `{index, count}` | prior per-column hidden state |
| `hideSheet` / `showSheet` | — | prior visibility |

**`renameSheet` rewrites the history index** — every entry on the renamed sheet
follows it to the new name, and undoing the rename rewrites them back. Without
that, a rename orphans the entire history: every older entry points at a name
that no longer resolves, and every undo on that sheet fails. Snapshot payloads
are not rewritten (that would be a full history rewrite); restore uses the
index entry's current name and treats the payload's stored name as a fallback.

**Layout entries conflict on their own plane.** They never disturb cell
content, so a width change does not block a value undo or vice versa. A layout
undo is refused only when a later layout entry of the *same kind* overlaps its
span (two width changes to the same columns), and structural ops still conflict
with everything on their sheet — an inserted column shifts what every recorded
width index means.

## Structural ops

These change the coordinate space, so a value snapshot cannot invert them. Each
carries an explicit inverse.

| `type` | `target` | Inverse |
|---|---|---|
| `insertRows` | `{index, count}` | `deleteRows` — no snapshot |
| `deleteRows` | `{index, count}` | snapshot, then `insertRows` + rewrite |
| `insertColumns` | `{index, count}` | `deleteColumns` — no snapshot |
| `deleteColumns` | `{index, count}` | snapshot, then `insertColumns` + rewrite |
| `addSheet` | `{name}` | `deleteSheet` — no snapshot |
| `deleteSheet` | `{sheetId}` | snapshot whole sheet + metadata, then recreate + rewrite |

**`deleteSheet`'s policy:** it always asks, even for an empty sheet — a tab is a
big thing to lose. Above the snapshot ceiling (`MAX_ENTRY_BYTES`) the entry is
recorded non-restorable and the confirmation says the one thing that matters:
THIS CANNOT BE UNDONE. Deleting rows or columns is gated like `clear` — whenever
the doomed span holds any content — because a delete leaves nothing behind to
notice. Inserts and `addSheet` destroy nothing and never ask.

**Structural ops conflict with everything on their sheet for undo purposes,**
in both directions. They change the coordinate space, so every other entry's
recorded range on that sheet may no longer mean what it meant when written.
Undo refuses (with the override) rather than reconciling ranges across shifts —
walking back in reverse order always works, since each undo unblocks the next.

---

## Undoing one op out of several

Every op is its own history entry, so undo is per-op rather than per-turn. That
granularity is the point — "undo the formatting but keep the values" is a normal
thing to want — but it needs one check to be honest.

Restoring an entry rewrites its whole range from a snapshot taken *before* it
ran. If a later change touched any of the same cells, undoing the earlier one
reverts the later one too, while the later entry still shows as applied. So an
undo whose range overlaps a newer, not-yet-undone entry is **refused**, naming
what it would take with it, and offering an explicit override.

Disjoint edits — the normal case — are never affected. Walking a turn back in
reverse order always works, because each undo clears the block on the one before
it.

---

## Concurrency

Every write is a compare-and-swap built by hand, because Sheets v4 offers no
ETag, no `If-Match`, and `LockService` does not cover a human typing in the UI.

1. `getContext` returns `contextHash` for the region read, plus `editWatermark`.
2. Every write in the turn carries both back as `guard: {sheetName, a1, hash, since}`.
3. Immediately before applying — **inside the same execution**, so nothing can
   interleave — Apps Script re-hashes and compares.
4. Mismatch → abort the **whole turn** with `CONTEXT_STALE` before any op runs.
   The tool result tells Claude to re-read, which it does, and the retry
   succeeds against current data.

**The guard must be blind to our own writes.** A turn that writes twice would
otherwise reject its own second op, having changed the guarded region itself. So
`applyOps` returns a `guard` refreshed to the post-write state, and the caller
carries that forward. It stays sensitive to everyone except the current turn.

`onEdit` is the secondary signal, and it closes the gap the hash cannot see: an
edit *outside* the region that was read. It fires for human edits and never for
our own writes — those go through `openById` — so a marker newer than `since` is
positive evidence a person typed. It queues at most two events, so treat it as a
hint, never a ledger; a corrupt or missing marker is ignored rather than blocking
every write. The simple trigger runs unauthorized and is wrapped in `try/catch`,
because nothing here may ever break a user's ability to type in their own file.

---

## Limits that shape the schema

| Limit | Consequence |
|---|---|
| **`google.script.run` rejects `Date`** — *"including prohibited types inside objects or arrays"* | **Sanitize every grid before returning it.** `getValues()` emits real `Date` objects for date-formatted cells |
| Cell holds ≤ 50,000 characters | Snapshot payloads chunk across cells/rows |
| Properties: 9 KB per value, 500 KB per store | Index only — payloads go to the hidden sheet |
| CacheService may return null at any time | Never load-bearing |
| `spreadsheets.values.batchUpdate` documents no atomicity | Use `spreadsheets.batchUpdate` where all-or-nothing matters |

### The `Date` trap, because it fails invisibly

A prohibited type in the return value kills the request during serialization, and
**neither the success nor the failure handler fires** — the call simply never
returns. There is no error in the console and no entry in the execution log,
because the server function itself ran fine. Every value grid crossing this
boundary goes through `sanitizeGrid_()`.

Dates currently become ISO strings, which is lossy in one direction: a text cell
containing `"2026-08-18"` and a real date cell arrive identically. Fine while
context is read-only; **before M3 writes dates back, this needs a typed
representation** (a tagged `{__t:"date"}` wrapper or a parallel type grid).

Hash the *sanitized* grid, never the raw one — otherwise the hash taken at read
time and the one computed at write time differ for cells that never changed.

Oversized payloads fail the same silent way, so context reads are capped at
`MAX_CONTEXT_CELLS` and set `truncated: true` when they clip.

---

## Status

Implemented: `getContext`, `inspectOps`, `applyOps`, `undoOp`, `getHistory`, and
`applyOp` as a one-op convenience over `applyOps`. All four value ops, all six
structural ops, all three range ops, and all ten layout ops work, with the
gate, the guard, and inverse-op undo. The hidden history sheet is protected
from every op type (`PROTECTED_SHEET`). Context reads report merged blocks.

Not yet ops at all (the model's prompt says so, so it declines honestly):
borders (Apps Script can write but not *read* them, so honest undo needs the
Advanced Sheets API — Tier 2), conditional formatting, data validation, notes,
named ranges, charts, pivot tables, protected ranges.

Mid-turn conflict detection is live: range hash plus the `onEdit` watermark,
carried on every write and refreshed after each.

Not implemented: `RANGE_TOO_LARGE` is not yet raised — an oversized range is
capped at read time instead.

The `Date` representation is still lossy in the write direction, as flagged
above. It has not bitten yet because nothing writes dates back, but the moment
a turn sets a date-formatted cell it will.
