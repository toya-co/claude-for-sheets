# Operation protocol

The contract between the sidebar and Apps Script. Both halves of the repo depend
on it, which is why it lives here rather than inside either one.

**Keep it transport-agnostic.** The same vocabulary runs over `google.script.run`
today and over the Sheets REST API in the headless/MCP path later
(`ARCHITECTURE.md` §7). Anything Apps-Script-shaped that leaks into these
definitions is a migration paid for twice.

---

## Envelope

**Request**

```json
{
  "opId": "op_01H…",
  "type": "setValues",
  "sheetId": 0,
  "target": { "a1": "B2:D10" },
  "payload": { "values": [["…"]] },
  "contextHash": "9f2c…"
}
```

| Field | Notes |
|---|---|
| `opId` | Client-generated, unique per op. Becomes the history entry key. |
| `type` | One of the op types below. |
| `sheetId` | Numeric Sheets ID, **not** the tab name — names are user-editable and change under you. |
| `target` | `{a1}` for value ops; `{index, count}` for structural. |
| `payload` | Type-specific. |
| `contextHash` | The hash returned by the `getContext` call this op was planned against. |

**Response**

```json
{
  "opId": "op_01H…",
  "ok": true,
  "inverse": { "type": "snapshot", "ref": "snap_01H…" },
  "newContextHash": "4b71…",
  "error": null
}
```

`inverse` is either `{type: "snapshot", ref}` for value ops or a complete inverse
op envelope for structural ops. `error` carries `{code, message}` when `ok` is
false; `code` is machine-readable — `CONTEXT_STALE`, `RANGE_TOO_LARGE`,
`NOT_IMPLEMENTED`, `SHEET_NOT_FOUND`.

---

## Value ops

Bounded to a range. Invertible by snapshotting that range before writing.

| `type` | `payload` |
|---|---|
| `setValues` | `{values: [[…]]}` |
| `setFormulas` | `{formulas: [[…]]}` |
| `setFormats` | `{formats: {…}}` — background, font, number format, alignment |
| `clear` | `{what: "all" \| "values" \| "formats"}` |

A snapshot captures **values, formulas, and formats together**. Restoring values
alone leaves the sheet visibly wrong, and that gap is the specific weakness in
the competing product.

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

**`deleteSheet` needs a policy, not just a row.** A full-sheet snapshot can dwarf
every other history entry combined. Above the cell-count threshold, require
explicit confirmation and record the entry as non-restorable rather than
silently capturing megabytes.

---

## Concurrency

Every write is a compare-and-swap built by hand, because Sheets v4 offers no
ETag, no `If-Match`, and `LockService` does not cover a human typing in the UI.

1. `getContext` returns `contextHash` for the region the agent may touch.
2. The op carries that hash back.
3. Immediately before applying — **inside the same execution**, so nothing can
   interleave — Apps Script re-hashes and compares.
4. Mismatch → abort with `CONTEXT_STALE`. The sidebar re-reads context and
   re-plans rather than retrying blind.

`onEdit` is a secondary signal only. It fires for human edits and never for our
own writes, which makes a timestamp newer than the context read positive evidence
that a person touched the sheet mid-turn. It queues at most two events, so treat
it as a hint, never a ledger.

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

M1 implements `getContext` only. `applyOp` exists with this signature and throws
`NOT_IMPLEMENTED` until M3.
