/**
 * Claude for Sheets — generated bundle. Do not edit here.
 *
 * The four source files concatenated into one, because Apps Script shares a
 * single scope across every .gs in a project. Regenerate with:
 *
 *     cd addon && npm run bundle
 *
 * To install by hand:
 *   1. Extensions ▸ Apps Script
 *   2. Paste THIS file over the default Code.gs
 *   3. Add an HTML file named exactly "Sidebar" and paste addon/Sidebar.html
 *   4. Services ▸ add "Google Sheets API" (needed for borders and
 *      conditional formatting, which Apps Script can write but not read back)
 *   5. Save, reload the spreadsheet tab, then Claude ▸ Open sidebar
 *
 * Or skip all of that with:  cd addon && clasp push
 */

// ======================================================================
// Sheet.gs
// ======================================================================

/**
 * The OnlyCurrentDoc annotation is deliberately absent, and must stay absent.
 * Adding it breaks undo across the whole add-on, and the failure is a runtime
 * exception on every write rather than a warning. (Written without its "@"
 * prefix on purpose: Apps Script scans JSDoc for the literal token, so even
 * naming it in a comment would switch it back on.)
 *
 * The annotation narrows the grant to `spreadsheets.currentonly`, which is what
 * this product would rather ask for. But `currentonly` and
 * `SpreadsheetApp.openById()` are mutually exclusive — Google's docs are explicit
 * that a script restricted to the current document cannot call `openById` at all.
 * And `openById` is the entire undo mechanism: it is the only measured way to
 * write to this spreadsheet without landing in the user's native Ctrl+Z stack.
 *
 * So the choice is the broad `spreadsheets` scope with a working restorable
 * history, or the narrow scope with agent edits tangled into the user's own undo
 * stack. Decided: broad scope. Explained under "The permission it asks for"
 * in the README, and stated
 * plainly in the README, because it is a real thing to ask of a user.
 *
 * Sheet I/O. The only file that touches SpreadsheetApp.
 *
 * The read/write split below is load-bearing, not stylistic. Measured: writes
 * through the *bound* spreadsheet handle land in the user's native Ctrl+Z stack, and writes through openById() do not. The
 * agent's edits must stay out of that stack so the restorable history is the
 * only thing governing them, so every write goes through writeSpreadsheet_().
 *
 * Keeping these as two named accessors makes the rule structural. Do not add a
 * write path that calls getActiveSpreadsheet().
 */

/** Hard cap on cells returned in one context read. See MAX_CELLS note below. */
const MAX_CONTEXT_CELLS = 20000;

/** Reads may use the bound handle — cheaper, and reads touch no undo stack. */
function readSpreadsheet_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

/**
 * Writes MUST go through this. openById() on the currently-open spreadsheet is
 * permitted under spreadsheets.currentonly (measured 2026-08-18) and escapes
 * native undo.
 */
function writeSpreadsheet_() {
  return SpreadsheetApp.openById(SpreadsheetApp.getActiveSpreadsheet().getId());
}

/**
 * Make a value grid safe to hand to google.script.run.
 *
 * Google's docs are explicit: "Requests fail if you attempt to pass a Date,
 * Function, DOM element besides a form, or other prohibited type, including
 * prohibited types inside objects or arrays."
 *
 * Range.getValues() returns real Date objects for any date-formatted cell, so
 * an unsanitized grid silently kills the round trip — the request fails on
 * serialization and *neither* the success nor the failure handler fires. The
 * symptom is a call that never returns, which is why this is worth a comment.
 *
 * Dates become ISO strings. That is lossy in one direction: a text cell holding
 * "2026-08-18" and a real date cell both arrive as strings. Acceptable while
 * context is read-only; revisit before M3 writes dates back, when a typed
 * representation will be needed.
 */
function sanitizeGrid_(grid) {
  return grid.map(function (row) {
    return row.map(function (cell) {
      // Object.prototype.toString rather than `instanceof Date`. instanceof
      // compares against one realm's constructor, so a Date from anywhere else
      // slips straight through — and a Date that slips through does not throw,
      // it makes google.script.run fail during serialization, where NEITHER
      // handler fires and the call simply never returns. The stronger check
      // costs one call and the weaker one fails silently.
      if (Object.prototype.toString.call(cell) === '[object Date]') {
        return cell.toISOString();
      }
      return cell;
    });
  });
}

/**
 * Stable hash of a range's contents. The optimistic-concurrency token: captured
 * when context is gathered, re-checked immediately before a write. Sheets v4 has
 * no ETag and LockService does not cover human UI edits, so this is the
 * compare-and-swap primitive, scoped to the range rather than the file.
 *
 * Hash the sanitized grid, not the raw one — otherwise the hash captured at read
 * time and the hash computed at write time can differ for the same unchanged
 * cells.
 */
function hashValues_(sanitizedGrid) {
  const json = JSON.stringify(sanitizedGrid);
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, json);
  return bytes
    .map(function (b) { return ((b & 0xff) + 0x100).toString(16).slice(1); })
    .join('')
    .slice(0, 32);
}

/** Cheap manifest of every tab. Always sent; full cell data is not. */
function sheetManifest_() {
  const ss = readSpreadsheet_();
  const activeId = ss.getActiveSheet().getSheetId();
  return ss.getSheets().map(function (s) {
    return {
      sheetId: s.getSheetId(),
      name: s.getName(),
      index: s.getIndex(),
      rows: s.getLastRow(),
      cols: s.getLastColumn(),
      isActive: s.getSheetId() === activeId,
    };
  });
}

/**
 * Full cell data for one tab, bounded. Two tiers by design: the manifest above
 * goes on every turn, this only for the tab in play. See
 * (multi-tab / context strategy).
 *
 * Bounded because getDataRange() on a large sheet produces a payload big enough
 * to stall or exceed the google.script.run transport, which fails the same
 * silent way a Date does.
 */
function readRange_(sheetName, a1) {
  const ss = readSpreadsheet_();
  const sheet = sheetName ? ss.getSheetByName(sheetName) : ss.getActiveSheet();
  if (!sheet) throw new Error('No such sheet: ' + sheetName);

  let range = a1 ? sheet.getRange(a1) : sheet.getDataRange();

  let truncated = false;
  if (range.getNumRows() * range.getNumColumns() > MAX_CONTEXT_CELLS) {
    const cols = Math.max(1, Math.min(range.getNumColumns(), 50));
    const rows = Math.max(1, Math.floor(MAX_CONTEXT_CELLS / cols));
    range = sheet.getRange(range.getRow(), range.getColumn(),
                           Math.min(rows, range.getNumRows()),
                           Math.min(cols, range.getNumColumns()));
    truncated = true;
  }

  const values = sanitizeGrid_(range.getValues());

  return {
    sheetId: sheet.getSheetId(),
    sheetName: sheet.getName(),
    a1: range.getA1Notation(),
    rows: range.getNumRows(),
    cols: range.getNumColumns(),
    truncated: truncated,
    values: values,
    formulas: range.getFormulas(),
    // Merged blocks intersecting the range, as A1 strings. Without these the
    // model sees a merged header as one value and a field of blanks, and
    // writes into cells that do not visibly exist. Capped for payload safety.
    merges: range.getMergedRanges().slice(0, 50)
      .map(function (r) { return r.getA1Notation(); }),
    contextHash: hashValues_(values),
  };
}

// ======================================================================
// History.gs
// ======================================================================

/**
 * Do NOT add the OnlyCurrentDoc annotation here — see the note in Sheet.gs.
 * It breaks undo across the whole add-on.
 *
 * Restorable edit history.
 *
 * Two stores, split by role:
 *   - payloads → a hidden sheet inside this spreadsheet. Never leaves the file,
 *     travels with it when shared, and restores with the local app closed. Undo
 *     is a safety feature; it must not depend on a running process.
 *   - index → Document Properties. Small and fast enough to render the history
 *     list without touching the payload sheet.
 *
 * Properties caps at 9 KB per value and 500 KB per store, so payloads cannot
 * live there. A Sheets cell caps at 50,000 characters, so payloads chunk.
 */

const HISTORY_SHEET = '__claude_history__';
const HISTORY_INDEX_KEY = 'claude.history.index';
const CELL_CHUNK = 40000;          // under the 50k cell ceiling, with headroom
const MAX_ENTRY_BYTES = 500 * 1024; // above this, record as non-restorable

function historySheet_() {
  const ss = writeSpreadsheet_();
  let sheet = ss.getSheetByName(HISTORY_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(HISTORY_SHEET);
    sheet.getRange(1, 1, 1, 3).setValues([['opId', 'chunkIndex', 'payload']]);
    sheet.hideSheet();
  }
  return sheet;
}

function readIndex_() {
  const raw = PropertiesService.getDocumentProperties().getProperty(HISTORY_INDEX_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function writeIndex_(index) {
  PropertiesService.getDocumentProperties()
    .setProperty(HISTORY_INDEX_KEY, JSON.stringify(index));
}

/**
 * A1 range for the Sheets API, sheet name quoted the way the API wants it.
 */
function apiRange_(sheetName, a1) {
  return "'" + String(sheetName).replace(/'/g, "''") + "'!" + a1;
}

/**
 * Per-cell border grid via the Advanced Sheets service — SpreadsheetApp can
 * WRITE borders but cannot read them, so without this call a border is
 * invisible to the snapshot and an undo silently erases it. Returns null when
 * the service is unavailable or errors; the snapshot then simply omits borders
 * rather than failing the write.
 *
 * The grid holds the API's own `borders` objects untouched — captured from
 * `userEnteredFormat.borders`, restored into the same field — so nothing here
 * ever needs to understand a border's insides.
 */
function borderGrid_(ss, sheetName, a1, rows, cols) {
  try {
    const resp = Sheets.Spreadsheets.get(ss.getId(), {
      ranges: [apiRange_(sheetName, a1)],
      fields: 'sheets(data(rowData(values(userEnteredFormat/borders))))',
    });
    const rowData = (((resp.sheets || [])[0] || {}).data || [])[0] || {};
    const grid = [];
    for (let r = 0; r < rows; r++) {
      const line = [];
      const vals = ((rowData.rowData || [])[r] || {}).values || [];
      for (let c = 0; c < cols; c++) {
        line.push(((vals[c] || {}).userEnteredFormat || {}).borders || null);
      }
      grid.push(line);
    }
    return grid;
  } catch (e) {
    return null;
  }
}

/**
 * Write a captured border grid back, per cell. `fields` scopes the update to
 * borders alone, and a null cell clears them — restoring "no border" is as
 * much a part of the undo as restoring one.
 */
function restoreBorders_(ss, sheet, a1, grid) {
  const anchor = sheet.getRange(a1);
  const rows = grid.map(function (line) {
    return { values: line.map(function (b) {
      return { userEnteredFormat: { borders: b || {} } };
    }) };
  });
  Sheets.Spreadsheets.batchUpdate({
    requests: [{
      updateCells: {
        range: {
          sheetId: sheet.getSheetId(),
          startRowIndex: anchor.getRow() - 1,
          endRowIndex: anchor.getRow() - 1 + grid.length,
          startColumnIndex: anchor.getColumn() - 1,
          endColumnIndex: anchor.getColumn() - 1 + (grid[0] ? grid[0].length : 0),
        },
        rows: rows,
        fields: 'userEnteredFormat.borders',
      },
    }],
  }, ss.getId());
}

/**
 * Serialize a range's data validations to JSON and back. Criteria values may
 * contain live Range and Date objects, neither of which survives JSON — they
 * are tagged and rebuilt.
 */
function serializeValidations_(range) {
  const grid = range.getDataValidations();
  let any = false;
  const out = grid.map(function (row) {
    return row.map(function (dv) {
      if (!dv) return null;
      any = true;
      return {
        criteria: String(dv.getCriteriaType()),
        args: dv.getCriteriaValues().map(function (v) {
          if (v && typeof v.getA1Notation === 'function') {
            return { __r: apiRange_(v.getSheet().getName(), v.getA1Notation()) };
          }
          if (v instanceof Date) return { __d: v.toISOString() };
          return v;
        }),
        allowInvalid: dv.getAllowInvalid(),
        help: dv.getHelpText() || null,
      };
    });
  });
  return any ? out : null;   // the overwhelmingly common case stays payload-free
}

function applyValidations_(ss, range, grid) {
  range.setDataValidations(grid.map(function (row) {
    return row.map(function (spec) {
      if (!spec) return null;
      const criteria = SpreadsheetApp.DataValidationCriteria[spec.criteria];
      if (!criteria) return null;   // an enum this runtime no longer knows
      const args = spec.args.map(function (v) {
        if (v && v.__r) return ss.getRange(v.__r);
        if (v && v.__d) return new Date(v.__d);
        return v;
      });
      const builder = SpreadsheetApp.newDataValidation()
        .withCriteria(criteria, args)
        .setAllowInvalid(spec.allowInvalid !== false);
      if (spec.help) builder.setHelpText(spec.help);
      return builder.build();
    });
  }));
}

/**
 * Capture values, formulas AND formats. Restoring values alone leaves the sheet
 * visibly wrong — that is the specific gap in the competing product's undo.
 */
function snapshotRange_(sheet, range) {
  const ss = writeSpreadsheet_();
  return {
    sheetName: sheet.getName(),
    a1: range.getA1Notation(),
    notes: range.getNotes(),
    validations: serializeValidations_(range),
    borders: borderGrid_(ss, sheet.getName(), range.getA1Notation(),
                         range.getNumRows(), range.getNumColumns()),
    values: sanitizeGrid_(range.getValues()),
    formulas: range.getFormulas(),
    backgrounds: range.getBackgrounds(),
    fontWeights: range.getFontWeights(),
    fontColors: range.getFontColors(),
    numberFormats: range.getNumberFormats(),
    horizontalAlignments: range.getHorizontalAlignments(),
    fontStyles: range.getFontStyles(),
    fontSizes: range.getFontSizes(),
    fontFamilies: range.getFontFamilies(),
    wraps: range.getWraps(),
    verticalAlignments: range.getVerticalAlignments(),
    fontLines: range.getFontLines(),
  };
}

/**
 * `sheetName` overrides the name frozen inside the payload: a renameSheet op
 * rewrites the *index* entries to the new name, but rewriting every chunked
 * payload would be a full history rewrite — so the caller passes the entry's
 * current name and the payload's copy is only a fallback.
 */
function restoreSnapshot_(snap, sheetName) {
  const name = sheetName || snap.sheetName;
  const sheet = writeSpreadsheet_().getSheetByName(name);
  if (!sheet) throw new Error('Sheet no longer exists: ' + name);
  const range = sheet.getRange(snap.a1);

  // Formulas first, then values — setValues would clobber a restored formula,
  // and a cell with no formula carries '' here, which setValues then corrects.
  range.setFormulas(snap.formulas);
  const merged = snap.values.map((row, r) =>
    row.map((v, c) => (snap.formulas[r][c] ? snap.formulas[r][c] : v)));
  range.setValues(merged);

  range.setBackgrounds(snap.backgrounds);
  range.setFontWeights(snap.fontWeights);
  range.setFontColors(snap.fontColors);
  range.setNumberFormats(snap.numberFormats);
  range.setHorizontalAlignments(snap.horizontalAlignments);
  // Guarded: snapshots recorded before these fields existed lack them, and a
  // partial restore beats a thrown undo.
  if (snap.fontStyles) range.setFontStyles(snap.fontStyles);
  if (snap.fontSizes) range.setFontSizes(snap.fontSizes);
  if (snap.fontFamilies) range.setFontFamilies(snap.fontFamilies);
  if (snap.wraps) range.setWraps(snap.wraps);
  if (snap.verticalAlignments) range.setVerticalAlignments(snap.verticalAlignments);
  if (snap.fontLines) range.setFontLines(snap.fontLines);
  if (snap.notes) range.setNotes(snap.notes);
  if (snap.validations) applyValidations_(writeSpreadsheet_(), range, snap.validations);
  if (snap.borders) {
    try { restoreBorders_(writeSpreadsheet_(), sheet, snap.a1, snap.borders); }
    catch (e) { /* the rest of the restore already landed; borders degrade */ }
  }
  SpreadsheetApp.flush();
}

/**
 * Append a history entry; payload chunked across rows of the hidden sheet.
 *
 * One entry per op, never per turn. A turn that edits two places is two entries
 * the user can undo independently — `turnId` only groups them for display.
 *
 * `snapshot` may be null: inserting rows or adding a sheet needs no payload to
 * undo, only its inverse op. `extra` lands on the index entry itself — for
 * structural ops it carries {structural: true, sheetName, inverse: {…}}.
 */
function recordHistory_(opId, opType, target, snapshot, turnId, extra) {
  const json = snapshot ? JSON.stringify(snapshot) : null;
  const restorable = json ? json.length <= MAX_ENTRY_BYTES : true;

  if (json && restorable) {
    const sheet = historySheet_();
    const chunks = [];
    for (let i = 0; i < json.length; i += CELL_CHUNK) {
      chunks.push([opId, chunks.length, json.slice(i, i + CELL_CHUNK)]);
    }
    sheet.getRange(sheet.getLastRow() + 1, 1, chunks.length, 3).setValues(chunks);
  }

  const index = readIndex_();
  const entry = {          // newest first, per the vault-wide log convention
    opId: opId,
    turnId: turnId || null,
    at: new Date().toISOString(),
    type: opType,
    target: target,
    // Kept apart from `target` so conflicts can be computed without re-parsing
    // a display string. See laterOverlaps_().
    sheetName: snapshot ? snapshot.sheetName : null,
    a1: snapshot ? snapshot.a1 : null,
    bytes: json ? json.length : 0,
    restorable: restorable,
    undone: false,
  };
  if (extra) {
    for (const k in extra) entry[k] = extra[k];
  }
  index.unshift(entry);
  writeIndex_(index);
  return { restorable: restorable, bytes: entry.bytes };
}

function loadSnapshot_(opId) {
  const sheet = historySheet_();
  const last = sheet.getLastRow();
  if (last < 2) return null;

  const rows = sheet.getRange(2, 1, last - 1, 3).getValues()
    .filter((r) => r[0] === opId)
    .sort((a, b) => a[1] - b[1]);
  if (!rows.length) return null;

  try { return JSON.parse(rows.map((r) => r[2]).join('')); } catch { return null; }
}

/** History list for the sidebar. Index only — payloads are never read here. */
function getHistory() {
  return readIndex_().slice(0, 50);
}

/** Do two A1 ranges on the same sheet share a cell? Pure rectangle overlap. */
function rangesOverlap_(sheet, a1A, a1B) {
  const A = sheet.getRange(a1A);
  const B = sheet.getRange(a1B);
  const aTop = A.getRow(), aLeft = A.getColumn();
  const aBottom = aTop + A.getNumRows() - 1, aRight = aLeft + A.getNumColumns() - 1;
  const bTop = B.getRow(), bLeft = B.getColumn();
  const bBottom = bTop + B.getNumRows() - 1, bRight = bLeft + B.getNumColumns() - 1;
  return aTop <= bBottom && bTop <= aBottom && aLeft <= bRight && bLeft <= aRight;
}

/**
 * Do two history entries conflict for undo purposes?
 *
 * Value ops conflict when their rectangles share a cell on the same sheet.
 * A structural op conflicts with EVERYTHING on its sheet, in both directions:
 * it changed the coordinate space, so every other entry's recorded range on
 * that sheet may no longer mean what it meant when it was written. Refusing is
 * the honest answer; precise reconciliation across shifts is not worth its bugs.
 */
function conflicts_(entry, other) {
  if (!entry.sheetName || !other.sheetName) return false;
  if (entry.sheetName !== other.sheetName) return false;
  if (entry.structural || other.structural) return true;

  // Layout entries (widths, heights, frozen panes, hidden spans, tab name and
  // visibility) live on their own plane: they never disturb cell content, so
  // they conflict only with a later layout entry of the SAME kind whose span
  // overlaps — two width changes to the same columns, say. Kinds with no span
  // (freeze, rename, visibility) conflict whenever the kind matches.
  if (entry.layout || other.layout) {
    if (!entry.layout || !other.layout) return false;
    if (entry.layout.kind !== other.layout.kind) return false;
    // A key narrows a kind: two edits to DIFFERENT named ranges share a kind
    // but never conflict; two edits to the same one always do.
    if (entry.layout.key !== undefined || other.layout.key !== undefined) {
      return entry.layout.key === other.layout.key;
    }
    if (entry.layout.index !== undefined && other.layout.index !== undefined) {
      const aEnd = entry.layout.index + (entry.layout.count || 1) - 1;
      const bEnd = other.layout.index + (other.layout.count || 1) - 1;
      return entry.layout.index <= bEnd && other.layout.index <= aEnd;
    }
    return true;
  }

  if (!entry.a1 || !other.a1) return false;
  const sheet = writeSpreadsheet_().getSheetByName(entry.sheetName);
  if (!sheet) return false;
  try {
    return rangesOverlap_(sheet, entry.a1, other.a1);
  } catch (e) {
    return false;   // an unparseable stored range should not block an undo
  }
}

/**
 * Entries newer than this one that its undo would disturb.
 *
 * This is what makes per-op undo safe. Restoring an entry rewrites state from
 * before it ran, so if a later edit touched the same cells — or shifted the
 * same sheet's coordinates — undoing the earlier one silently corrupts the
 * later one, which would still be listed as applied. Disjoint edits, the
 * normal case, are unaffected.
 *
 * The index is newest-first, so "newer" is everything before this entry's slot.
 */
function laterOverlaps_(index, entry) {
  const slot = index.findIndex((e) => e.opId === entry.opId);
  const blockers = [];
  for (let i = 0; i < slot; i++) {
    const other = index[i];
    if (other.undone) continue;
    if (conflicts_(entry, other)) blockers.push(other);
  }
  return blockers;
}

/** Restore a layout inverse: exactly the prior state the apply recorded. */
function applyLayoutInverse_(sheet, inv, entry, index) {
  if (inv.kind === 'colwidth') {
    inv.widths.forEach(function (w) { sheet.setColumnWidth(w.index, w.width); });
  } else if (inv.kind === 'rowheight') {
    inv.heights.forEach(function (h) { sheet.setRowHeight(h.index, h.height); });
  } else if (inv.kind === 'freeze') {
    sheet.setFrozenRows(inv.rows);
    sheet.setFrozenColumns(inv.cols);
  } else if (inv.kind === 'rename') {
    // Rename back, and point the history at the restored name again — the
    // mirror image of what applying the rename did. `index` is the caller's
    // loaded copy, mutated in place so its single final write wins.
    const from = entry.sheetName;
    sheet.setName(inv.to);
    index.forEach(function (e) { if (e.sheetName === from) e.sheetName = inv.to; });
  } else if (inv.kind === 'rowshidden') {
    inv.spans.forEach(function (s) {
      if (s.hidden) sheet.hideRows(s.index, 1); else sheet.showRows(s.index, 1);
    });
  } else if (inv.kind === 'colshidden') {
    inv.spans.forEach(function (s) {
      if (s.hidden) sheet.hideColumns(s.index, 1); else sheet.showColumns(s.index, 1);
    });
  } else if (inv.kind === 'sheetvis') {
    if (inv.hidden) sheet.hideSheet(); else sheet.showSheet();
  } else if (inv.kind === 'condfmt') {
    setCondRules_(writeSpreadsheet_(), sheet, inv.rules || []);
  } else if (inv.kind === 'namedrange') {
    const ss = writeSpreadsheet_();
    const current = namedRange_(ss, inv.name);
    if (inv.prior) {
      const priorSheet = ss.getSheetByName(inv.prior.sheetName);
      if (!priorSheet) throw new Error('Sheet no longer exists: ' + inv.prior.sheetName);
      ss.setNamedRange(inv.name, priorSheet.getRange(inv.prior.a1));
    } else if (current) {
      current.remove();   // it did not exist before the op; undo removes it
    }
  } else {
    throw new Error('Unknown layout inverse: ' + inv.kind);
  }
}

/**
 * Undo an entry that carries a stored inverse (structural, merge, layout).
 *
 * Delete-undo is insert-then-rewrite: the coordinates are recreated first, and
 * restoreSnapshot_ then lands on the same A1 the snapshot was taken from.
 *
 * `index` is the caller's loaded history index; a rename inverse mutates it in
 * place rather than writing itself, so the caller's one write at the end is
 * the only write and cannot be clobbered.
 */
function applyInverse_(entry, index) {
  const ss = writeSpreadsheet_();
  const inv = entry.inverse;
  if (!inv) throw new Error('Structural entry has no inverse recorded.');

  const needSheet = () => {
    const sheet = ss.getSheetByName(entry.sheetName);
    if (!sheet) throw new Error('Sheet no longer exists: ' + entry.sheetName);
    return sheet;
  };
  const needSnapshot = () => {
    const snap = loadSnapshot_(entry.opId);
    if (!snap) throw new Error('Snapshot missing — the history sheet may have been deleted.');
    return snap;
  };

  if (inv.type === 'deleteRows') {            // undoing an insert
    needSheet().deleteRows(inv.index, inv.count);
  } else if (inv.type === 'insertRows') {     // undoing a delete: recreate, refill
    needSheet().insertRowsBefore(inv.index, inv.count);
    restoreSnapshot_(needSnapshot(), entry.sheetName);
  } else if (inv.type === 'deleteColumns') {
    needSheet().deleteColumns(inv.index, inv.count);
  } else if (inv.type === 'insertColumns') {
    needSheet().insertColumnsBefore(inv.index, inv.count);
    restoreSnapshot_(needSnapshot(), entry.sheetName);
  } else if (inv.type === 'deleteSheet') {    // undoing addSheet
    ss.deleteSheet(needSheet());
  } else if (inv.type === 'recreateSheet') {  // undoing deleteSheet
    if (ss.getSheetByName(inv.name)) {
      throw new Error("A sheet named '" + inv.name + "' already exists.");
    }
    ss.insertSheet(inv.name, inv.index);
    restoreSnapshot_(needSnapshot(), inv.name);
  } else if (inv.type === 'unmergeRestore') { // undoing mergeCells
    const sheet = needSheet();
    sheet.getRange(entry.a1).breakApart();
    restoreSnapshot_(needSnapshot(), entry.sheetName);
    (inv.priorMerges || []).forEach(function (a1) { sheet.getRange(a1).merge(); });
  } else if (inv.type === 'remerge') {        // undoing unmergeCells
    const sheet = needSheet();
    (inv.ranges || []).forEach(function (a1) { sheet.getRange(a1).merge(); });
  } else if (inv.type === 'layout') {
    applyLayoutInverse_(needSheet(), inv, entry, index);
  } else {
    throw new Error('Unknown inverse type: ' + inv.type);
  }
  SpreadsheetApp.flush();
  return entry.target;
}

/**
 * Undo one entry by rewriting its snapshot.
 *
 * Refuses when a later change overlaps, rather than silently eating it. `force`
 * is the user's override, offered once they have been told what it costs.
 */
function undoOp(opId, force) {
  const index = readIndex_();
  const entry = index.find((e) => e.opId === opId);
  if (!entry) throw new Error('No history entry: ' + opId);
  if (!entry.restorable) throw new Error('That change was too large to be restorable.');
  if (entry.undone) throw new Error('That change has already been undone.');

  if (!force) {
    const blockers = laterOverlaps_(index, entry);
    if (blockers.length) {
      return {
        ok: false,
        code: 'BLOCKED_BY_LATER_EDIT',
        opId: opId,
        blockers: blockers.map((b) => ({ opId: b.opId, type: b.type, target: b.target })),
        message: blockers.length === 1
          ? 'A later change to ' + blockers[0].target + ' overlaps this one. Undoing this would revert that too.'
          : blockers.length + ' later changes overlap this one. Undoing this would revert them too.',
      };
    }
  }

  let restored;
  if (entry.inverse) {
    restored = applyInverse_(entry, index);
  } else {
    const snap = loadSnapshot_(opId);
    if (!snap) throw new Error('Snapshot missing — the history sheet may have been deleted.');
    restoreSnapshot_(snap, entry.sheetName);
    restored = entry.sheetName + '!' + snap.a1;
  }
  entry.undone = true;
  writeIndex_(index);
  return { ok: true, opId: opId, restored: restored };
}

// ======================================================================
// Ops.gs
// ======================================================================

/**
 * Do NOT add the OnlyCurrentDoc annotation here — see the note in Sheet.gs.
 * It breaks undo across the whole add-on.
 *
 * Multi-op turns: inspection, the confirmation gate, and sequential execution.
 *
 * A turn is a list of ops, not one op. Each gets its own history entry so the
 * user can undo "this" without undoing "that", and they share a `turnId` so the
 * sidebar can group them visually without giving up that granularity.
 *
 * Two phases on purpose. `inspectOps()` reports what each op would destroy
 * without touching the sheet; `applyOps()` refuses to run a gated op that the
 * user did not confirm. The gate is enforced here rather than in the sidebar,
 * because the sidebar is the part an injected prompt could plausibly influence.
 */

/** Above this many existing non-empty cells overwritten, ask first. */
const DESTRUCTIVE_CELL_THRESHOLD = 10;

/**
 * How much the gate asks about. The user's choice, set in the dashboard and
 * carried on the request; see `askLevel_`.
 *
 *   'destructive'   — anything that overwrites or deletes (the default)
 *   'unrecoverable' — only what undo cannot take back
 *
 * The split is undo, not difficulty. Every gated edit below is restorable from
 * the in-file history, so for those the prompt is a courtesy and relaxing it is
 * honest. Two things are different in kind and keep asking either way:
 * deleting a sheet, and any edit whose snapshot would exceed MAX_ENTRY_BYTES —
 * that entry is recorded non-restorable, so there would be nothing to go back
 * to. Web requests are gated in the daemon and untouched by this.
 */
const ASK_DESTRUCTIVE = 'destructive';
const ASK_UNRECOVERABLE = 'unrecoverable';

/**
 * Read the level off a request, defaulting to the STRICT end.
 *
 * Anything unrecognized — absent, misspelled, or a value from a newer daemon
 * this add-on does not know — must mean "ask about everything". A gate that
 * fails open on an unfamiliar string is the exact shape of bug that shipped
 * twice already in this project, so the comparison is an allowlist of one.
 */
function askLevel_(request) {
  return (request && request.askBefore) === ASK_UNRECOVERABLE
    ? ASK_UNRECOVERABLE
    : ASK_DESTRUCTIVE;
}

/**
 * Would this op's snapshot fit under the ceiling — i.e. will undo actually be
 * able to put it back? Used only to decide whether the relaxed level may skip
 * the prompt; the real restorable flag is recorded at apply time.
 */
function wouldRestore_(grid) {
  try {
    return JSON.stringify(grid).length <= MAX_ENTRY_BYTES;
  } catch (e) {
    return false;   // unmeasurable means treat as unrecoverable, so it asks
  }
}

/** Where onEdit (Code.gs) leaves its "a person typed" marker. */
const EDIT_MARK_KEY = 'claude.humanEdit';

/**
 * The last human edit, or null. Millisecond timestamps, compared against the
 * watermark a turn captured when it read the sheet.
 */
function editWatermark_() {
  try {
    const raw = PropertiesService.getDocumentProperties().getProperty(EDIT_MARK_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

const VALUE_OPS = ['setValues', 'setFormulas', 'setFormats', 'clear'];
const STRUCTURAL_OPS = ['insertRows', 'deleteRows', 'insertColumns', 'deleteColumns',
                        'addSheet', 'deleteSheet', 'duplicateSheet'];

/**
 * Range-scoped ops beyond plain writes. Same undo story as value ops — bounded
 * to a rectangle, snapshot restores it — so they share the rectangle-overlap
 * conflict rule. Merge additionally records the merges it displaced; borders,
 * notes, and validations ride the plain snapshot, which captures all three.
 */
const RANGE_OPS = ['mergeCells', 'unmergeCells', 'sortRange',
                   'setBorders', 'setValidation', 'setNote'];

/**
 * Layout ops change how the sheet *presents*, not what it holds: widths,
 * heights, frozen panes, hidden spans, tab names and visibility. Each is
 * invertible from a small record of prior state — no snapshot payload at all —
 * and none destroys content, so none is ever gated. For undo conflicts they
 * live on their own plane: two width changes to the same columns conflict;
 * a width change and a value write never do.
 */
const LAYOUT_OPS = ['setColumnWidth', 'setRowHeight', 'freezePanes', 'renameSheet',
                    'hideRows', 'showRows', 'hideColumns', 'showColumns',
                    'hideSheet', 'showSheet',
                    'setConditionalFormat', 'clearConditionalFormats',
                    'setNamedRange', 'deleteNamedRange'];

/** '#rrggbb' → the API's {red, green, blue} floats. */
function hexColor_(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 };
}

const BORDER_STYLES = ['solid', 'dashed', 'dotted', 'thick', 'double', 'none'];

function borderStyleEnum_(style) {
  const map = {
    solid: SpreadsheetApp.BorderStyle.SOLID,
    dashed: SpreadsheetApp.BorderStyle.DASHED,
    dotted: SpreadsheetApp.BorderStyle.DOTTED,
    thick: SpreadsheetApp.BorderStyle.SOLID_THICK,
    double: SpreadsheetApp.BorderStyle.DOUBLE,
  };
  return map[style || 'solid'] || SpreadsheetApp.BorderStyle.SOLID;
}

/**
 * A sheet's conditional-format rules as the API's own JSON, via the Advanced
 * Sheets service. SpreadsheetApp can enumerate rules but cannot read a rule's
 * FORMAT back (BooleanCondition exposes the condition only), so honest
 * undo — and therefore the whole feature — goes through the API, where a rule
 * round-trips untouched.
 */
function condRules_(ss, sheet) {
  const resp = Sheets.Spreadsheets.get(ss.getId(), {
    fields: 'sheets(properties(sheetId),conditionalFormats)',
  });
  const entry = (resp.sheets || []).filter(function (s) {
    return s.properties && s.properties.sheetId === sheet.getSheetId();
  })[0];
  return (entry && entry.conditionalFormats) || [];
}

/** Replace a sheet's rules wholesale: delete what is there, add what should be. */
function setCondRules_(ss, sheet, rules) {
  const current = condRules_(ss, sheet);
  const requests = [];
  for (let i = 0; i < current.length; i++) {
    requests.push({ deleteConditionalFormatRule: { sheetId: sheet.getSheetId(), index: 0 } });
  }
  (rules || []).forEach(function (rule, i) {
    requests.push({ addConditionalFormatRule: { rule: rule, index: i } });
  });
  if (requests.length) Sheets.Spreadsheets.batchUpdate({ requests: requests }, ss.getId());
}

/** Build one API rule from the model-facing spec. Returns null on a bad spec. */
function condRuleFromSpec_(sheet, range, spec) {
  const gridRange = {
    sheetId: sheet.getSheetId(),
    startRowIndex: range.getRow() - 1,
    endRowIndex: range.getRow() - 1 + range.getNumRows(),
    startColumnIndex: range.getColumn() - 1,
    endColumnIndex: range.getColumn() - 1 + range.getNumColumns(),
  };
  if (spec && spec.gradient) {
    const g = spec.gradient;
    const point = function (color, type, value) {
      if (!color) return null;
      const p = { color: hexColor_(color), type: type || 'NUMBER' };
      if (value !== undefined && p.type !== 'MIN' && p.type !== 'MAX') p.value = String(value);
      return p;
    };
    const rule = { minpoint: point(g.minColor, g.minType || 'MIN', g.minValue),
                   maxpoint: point(g.maxColor, g.maxType || 'MAX', g.maxValue) };
    if (!rule.minpoint || !rule.maxpoint) return null;
    if (g.midColor) rule.midpoint = point(g.midColor, g.midType || 'PERCENTILE', g.midValue !== undefined ? g.midValue : 50);
    return { ranges: [gridRange], gradientRule: rule };
  }
  if (!spec || !spec.when) return null;
  const format = {};
  if (spec.background) format.backgroundColor = hexColor_(spec.background);
  if (spec.fontColor || spec.bold !== undefined || spec.italic !== undefined) {
    format.textFormat = {};
    if (spec.fontColor) format.textFormat.foregroundColor = hexColor_(spec.fontColor);
    if (spec.bold !== undefined) format.textFormat.bold = Boolean(spec.bold);
    if (spec.italic !== undefined) format.textFormat.italic = Boolean(spec.italic);
  }
  return {
    ranges: [gridRange],
    booleanRule: {
      condition: {
        type: String(spec.when),
        values: (spec.values || []).map(function (v) { return { userEnteredValue: String(v) }; }),
      },
      format: format,
    },
  };
}

/** The named range with this name, or null. */
function namedRange_(ss, name) {
  return ss.getNamedRanges().filter(function (nr) { return nr.getName() === name; })[0] || null;
}

/** "B" or 2 → 2. Sort specs arrive with whatever the model found natural. */
function colNum_(v) {
  if (typeof v === 'number') return v;
  const s = String(v || '').trim().toUpperCase();
  if (/^\d+$/.test(s)) return Number(s);
  if (!/^[A-Z]+$/.test(s)) return NaN;
  let n = 0;
  for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
  return n;
}

/**
 * Resolve an op's target. Sheet by name for now; protocol.md prefers sheetId
 * because names are user-editable, and the model only ever sees names — so
 * accept both and prefer the ID when it is present.
 */
function opSheet_(ss, op) {
  if (op.sheetId !== undefined && op.sheetId !== null) {
    const byId = ss.getSheets().filter(function (s) { return s.getSheetId() === op.sheetId; })[0];
    if (byId) return byId;
  }
  if (op.sheetName) return ss.getSheetByName(op.sheetName);
  return ss.getSheets()[0];
}

/**
 * The range an op writes to.
 *
 * For grid ops the written range is sized from the payload, not from the a1 the
 * model wrote — a1 is only the top-left anchor. For `clear` the a1 is the range
 * itself, since there is no payload to size from.
 */
function opRange_(sheet, op) {
  const anchor = sheet.getRange(op.a1);
  const grid = op.values || op.formulas;
  if (grid && grid.length && grid[0] && grid[0].length) {
    return sheet.getRange(anchor.getRow(), anchor.getColumn(), grid.length, grid[0].length);
  }
  return anchor;
}

function countNonEmpty_(grid) {
  let n = 0;
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      const v = grid[r][c];
      if (v !== '' && v !== null && v !== undefined) n++;
    }
  }
  return n;
}

/**
 * What would this op destroy?
 *
 * Reads only. Two things make an op destructive, and they are deliberately
 * different in kind:
 *
 *   - **Volume** — it overwrites more than DESTRUCTIVE_CELL_THRESHOLD cells that
 *     already hold something. One cell is a typo fix; forty is a column of
 *     someone's data.
 *   - **Formulas** — it overwrites a cell containing a formula, at any count.
 *     Replacing a formula with its own current value looks like a no-op in the
 *     grid and quietly destroys the thing that computed it. Always ask.
 *
 * `clear` is always gated when it would remove anything at all: unlike a write,
 * it leaves nothing behind to notice.
 */
function inspectOp_(ss, op, level) {
  const base = { opId: op.opId || null, type: op.type, ok: true };
  const checked = inspectOpRaw_(ss, op, base);

  // ONE relaxation point, deliberately. Each inspector decides only what an op
  // destroys and whether it could be put back; the decision about how much to
  // ask is made here, once, so no op type can quietly acquire its own policy.
  if (level === ASK_UNRECOVERABLE && checked.ok && checked.destructive &&
      !checked.alwaysAsk && checked.recoverable) {
    checked.destructive = false;
    checked.relaxed = true;
  }
  return checked;
}

function inspectOpRaw_(ss, op, base) {

  // The history sheet holds the undo payloads. An op that touches it — from a
  // confused model or a hostile cell — would let an edit destroy its own undo.
  if (op.sheetName === HISTORY_SHEET || op.name === HISTORY_SHEET ||
      op.newName === HISTORY_SHEET) {
    return { ok: false, type: op.type,
      error: { code: 'PROTECTED_SHEET', message: 'That sheet belongs to the undo history.' } };
  }

  if (STRUCTURAL_OPS.indexOf(op.type) !== -1) return inspectStructural_(ss, op, base);
  if (LAYOUT_OPS.indexOf(op.type) !== -1) return inspectLayout_(ss, op, base);
  if (RANGE_OPS.indexOf(op.type) !== -1) return inspectRangeOp_(ss, op, base);

  if (VALUE_OPS.indexOf(op.type) === -1) {
    return { ok: false, type: op.type,
      error: { code: 'NOT_IMPLEMENTED', message: 'Unsupported op type: ' + op.type } };
  }

  const sheet = opSheet_(ss, op);
  if (!sheet) {
    return { ok: false, type: op.type,
      error: { code: 'SHEET_NOT_FOUND', message: 'No sheet named ' + op.sheetName } };
  }

  let range;
  try { range = opRange_(sheet, op); } catch (e) {
    return { ok: false, type: op.type,
      error: { code: 'BAD_PAYLOAD', message: 'Bad range "' + op.a1 + '": ' + e.message } };
  }

  const existing = sanitizeGrid_(range.getValues());
  const formulas = range.getFormulas();
  const occupied = countNonEmpty_(existing);
  const formulaCount = countNonEmpty_(formulas);

  let destructive = false;
  let reason = '';

  if (op.type === 'clear' && occupied > 0) {
    destructive = true;
    reason = 'clears ' + occupied + ' cell' + (occupied === 1 ? '' : 's') + ' that hold content';
  } else if (formulaCount > 0 && op.type !== 'setFormats') {
    destructive = true;
    reason = 'overwrites ' + formulaCount + ' formula' + (formulaCount === 1 ? '' : 's');
  } else if (occupied > DESTRUCTIVE_CELL_THRESHOLD && op.type !== 'setFormats') {
    destructive = true;
    reason = 'overwrites ' + occupied + ' cells that already hold content';
  }

  base.target = sheet.getName() + '!' + range.getA1Notation();
  base.sheetName = sheet.getName();
  base.a1 = range.getA1Notation();
  base.cells = range.getNumRows() * range.getNumColumns();
  base.occupied = occupied;
  base.formulas = formulaCount;
  base.destructive = destructive;
  base.reason = reason;
  base.recoverable = wouldRestore_(existing);
  return base;
}

/** "Sheet1!rows 3-5" / "Sheet1!cols 2-4" / "sheet 'Data'" — for cards and history. */
function structTarget_(op, sheetName) {
  if (op.type === 'addSheet') return "sheet '" + op.name + "'";
  if (op.type === 'deleteSheet') return "sheet '" + sheetName + "'";
  if (op.type === 'duplicateSheet') {
    return "sheet '" + sheetName + "' → copy" + (op.newName ? " '" + op.newName + "'" : '');
  }
  const count = Math.max(1, op.count || 1);
  const unit = /Rows$/.test(op.type) ? 'rows' : 'cols';
  const span = count > 1 ? op.index + '-' + (op.index + count - 1) : String(op.index);
  return sheetName + '!' + unit + ' ' + span;
}

/**
 * What would this structural op destroy?
 *
 * Inserts and addSheet destroy nothing and are never gated. Deleting rows or
 * columns is gated exactly like `clear`: whenever the doomed span holds any
 * content at all, because a delete leaves nothing behind to notice. Deleting a
 * whole sheet always asks — and above the snapshot ceiling the confirmation
 * says the one thing that matters: this one cannot be undone.
 */
function inspectStructural_(ss, op, base) {
  const count = Math.max(1, op.count || 1);

  if (op.type === 'addSheet') {
    if (!op.name) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'addSheet needs a name.' } };
    }
    if (ss.getSheetByName(op.name)) {
      return { ok: false, type: op.type,
        error: { code: 'SHEET_EXISTS', message: "A sheet named '" + op.name + "' already exists." } };
    }
    base.target = structTarget_(op, op.name);
    base.destructive = false;
    base.reason = '';
    return base;
  }

  const sheet = opSheet_(ss, op);
  if (!sheet) {
    return { ok: false, type: op.type,
      error: { code: 'SHEET_NOT_FOUND', message: 'No sheet named ' + op.sheetName } };
  }
  base.target = structTarget_(op, sheet.getName());

  if (op.type === 'duplicateSheet') {
    if (op.newName && ss.getSheetByName(op.newName)) {
      return { ok: false, type: op.type,
        error: { code: 'SHEET_EXISTS', message: "A sheet named '" + op.newName + "' already exists." } };
    }
    base.destructive = false;
    base.reason = '';
    return base;
  }

  if (op.type === 'insertRows' || op.type === 'insertColumns') {
    if (!op.index || op.index < 1) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'index must be 1 or greater.' } };
    }
    base.destructive = false;
    base.reason = '';
    return base;
  }

  if (op.type === 'deleteRows' || op.type === 'deleteColumns') {
    if (!op.index || op.index < 1) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'index must be 1 or greater.' } };
    }
    const rows = op.type === 'deleteRows';
    const width = Math.max(1, rows ? sheet.getLastColumn() : sheet.getLastRow());
    const block = rows
      ? sheet.getRange(op.index, 1, count, width)
      : sheet.getRange(1, op.index, width, count);
    const blockVals = sanitizeGrid_(block.getValues());
    const occupied = countNonEmpty_(blockVals);
    const formulas = countNonEmpty_(block.getFormulas());
    base.recoverable = wouldRestore_(blockVals);
    base.occupied = occupied;
    base.formulas = formulas;
    base.destructive = occupied + formulas > 0;
    base.reason = base.destructive
      ? 'deletes ' + count + (rows ? ' row' : ' column') + (count === 1 ? '' : 's') +
        ' holding ' + occupied + ' cell' + (occupied === 1 ? '' : 's') + ' of content'
      : '';
    return base;
  }

  // deleteSheet
  if (ss.getSheets().filter(function (x) { return x.getName() !== HISTORY_SHEET; }).length <= 1) {
    return { ok: false, type: op.type,
      error: { code: 'LAST_SHEET', message: 'Cannot delete the only sheet.' } };
  }
  const lastRow = Math.max(1, sheet.getLastRow());
  const lastCol = Math.max(1, sheet.getLastColumn());
  const grid = sanitizeGrid_(sheet.getRange(1, 1, lastRow, lastCol).getValues());
  const occupied = countNonEmpty_(grid);
  const tooBig = JSON.stringify(grid).length > MAX_ENTRY_BYTES;
  base.occupied = occupied;
  base.recoverable = !tooBig;
  base.alwaysAsk = true;     // never relaxed, whatever the level
  base.destructive = true;   // always — a sheet is a big thing to lose
  base.reason = "deletes the sheet '" + sheet.getName() + "' (" + occupied +
    ' cell' + (occupied === 1 ? '' : 's') + ' of content)' +
    (tooBig ? ' — TOO LARGE TO UNDO' : '');
  return base;
}

/**
 * How many cells would a merge destroy?
 *
 * merge() keeps only the top-left cell of the block and silently deletes the
 * rest — mergeAcross keeps the first cell of each row, mergeVertically the
 * first of each column. Like `clear`, it leaves nothing behind to notice, so
 * any doomed content gates.
 */
function mergeDoomed_(values, formulas, mergeType) {
  let n = 0;
  for (let r = 0; r < values.length; r++) {
    for (let c = 0; c < values[r].length; c++) {
      const survives = mergeType === 'across' ? c === 0
                     : mergeType === 'vertical' ? r === 0
                     : (r === 0 && c === 0);
      if (survives) continue;
      const v = values[r][c];
      if ((v !== '' && v !== null && v !== undefined) || formulas[r][c]) n++;
    }
  }
  return n;
}

/**
 * What would this range op destroy?
 *
 * Merging is gated like `clear` — it deletes every non-surviving cell that
 * holds anything. Sorting destroys nothing (a permutation, and the snapshot
 * restores it exactly), but formulas gate it: their relative references get
 * rearranged, which can silently change what they compute. Unmerging destroys
 * nothing and never asks.
 */
function inspectRangeOp_(ss, op, base) {
  const sheet = opSheet_(ss, op);
  if (!sheet) {
    return { ok: false, type: op.type,
      error: { code: 'SHEET_NOT_FOUND', message: 'No sheet named ' + op.sheetName } };
  }
  let range;
  try { range = opRange_(sheet, op); } catch (e) {
    return { ok: false, type: op.type,
      error: { code: 'BAD_PAYLOAD', message: 'Bad range "' + op.a1 + '": ' + e.message } };
  }
  base.target = sheet.getName() + '!' + range.getA1Notation();
  base.sheetName = sheet.getName();
  base.a1 = range.getA1Notation();
  base.destructive = false;
  base.reason = '';

  if (op.type === 'mergeCells') {
    const mergeType = op.mergeType || 'all';
    if (['all', 'across', 'vertical'].indexOf(mergeType) === -1) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: "mergeType must be 'all', 'across', or 'vertical'." } };
    }
    const vals = sanitizeGrid_(range.getValues());
    base.recoverable = wouldRestore_(vals);
    const doomed = mergeDoomed_(vals, range.getFormulas(), mergeType);
    if (doomed > 0) {
      base.destructive = true;
      base.reason = 'merges away ' + doomed + ' cell' + (doomed === 1 ? '' : 's') +
        ' of content (only the first cell of a merge survives)';
    }
    return base;
  }

  if (op.type === 'unmergeCells') {
    if (!range.getMergedRanges().length) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'No merged cells in ' + base.target + '.' } };
    }
    return base;
  }

  // Borders, notes, and validations destroy no content — the snapshot captures
  // and restores all three — so none of them gates. Validation only.
  if (op.type === 'setBorders') {
    if (op.style !== undefined && BORDER_STYLES.indexOf(op.style) === -1) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: "style must be one of: " + BORDER_STYLES.join(', ') } };
    }
    const edges = ['top', 'bottom', 'left', 'right', 'vertical', 'horizontal'];
    if (!edges.some(function (e) { return op[e] !== undefined; })) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'Pass at least one edge: ' + edges.join(', ') + '.' } };
    }
    return base;
  }

  if (op.type === 'setNote') {
    if (op.note !== undefined && op.note !== null && typeof op.note !== 'string') {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'note must be a string (empty clears it).' } };
    }
    return base;
  }

  if (op.type === 'setValidation') {
    const rule = op.rule || {};
    const kinds = ['list', 'numberBetween', 'numberGreaterThan', 'checkbox', 'date', 'none'];
    if (kinds.indexOf(rule.type) === -1) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'rule.type must be one of: ' + kinds.join(', ') } };
    }
    if (rule.type === 'list' && (!Array.isArray(rule.values) || !rule.values.length)) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'a list rule needs values: ["a", "b", …].' } };
    }
    if (rule.type === 'numberBetween' &&
        (typeof rule.min !== 'number' || typeof rule.max !== 'number')) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'numberBetween needs numeric min and max.' } };
    }
    if (rule.type === 'numberGreaterThan' && typeof rule.min !== 'number') {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'numberGreaterThan needs a numeric min.' } };
    }
    return base;
  }

  // sortRange
  const by = op.by;
  if (!Array.isArray(by) || !by.length) {
    return { ok: false, type: op.type,
      error: { code: 'BAD_PAYLOAD', message: 'sortRange needs by: [{column, ascending}].' } };
  }
  const first = range.getColumn();
  const last = first + range.getNumColumns() - 1;
  for (let i = 0; i < by.length; i++) {
    const col = colNum_(by[i] && by[i].column);
    if (!col || isNaN(col) || col < first || col > last) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'Sort column ' + (by[i] && by[i].column) +
          ' is outside ' + base.target + '.' } };
    }
  }
  const formulas = countNonEmpty_(range.getFormulas());
  base.recoverable = wouldRestore_(sanitizeGrid_(range.getValues()));
  if (formulas > 0) {
    base.destructive = true;
    base.reason = 'sorts a range holding ' + formulas + ' formula' + (formulas === 1 ? '' : 's') +
      ', whose references will be rearranged';
  }
  return base;
}

/**
 * Validate a layout op. None of them is ever destructive — they change
 * presentation, not content, and each undoes exactly from its recorded prior
 * state — so this is validation only.
 */
function inspectLayout_(ss, op, base) {
  base.destructive = false;
  base.reason = '';

  // Named ranges are spreadsheet-scoped; resolve them before any sheet lookup.
  if (op.type === 'setNamedRange' || op.type === 'deleteNamedRange') {
    if (!op.name || typeof op.name !== 'string' ||
        !/^[A-Za-z_][A-Za-z0-9_.]{0,254}$/.test(op.name)) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'Named range names are letters, digits, and _ ' +
          '(no spaces), not starting with a digit.' } };
    }
    if (op.type === 'deleteNamedRange') {
      if (!namedRange_(ss, op.name)) {
        return { ok: false, type: op.type,
          error: { code: 'BAD_PAYLOAD', message: "No named range called '" + op.name + "'." } };
      }
      base.target = "named range '" + op.name + "'";
      return base;
    }
    const target = opSheet_(ss, op);
    if (!target) {
      return { ok: false, type: op.type,
        error: { code: 'SHEET_NOT_FOUND', message: 'No sheet named ' + op.sheetName } };
    }
    try { target.getRange(op.a1); } catch (e) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'Bad range "' + op.a1 + '": ' + e.message } };
    }
    base.target = "named range '" + op.name + "' → " + target.getName() + '!' + op.a1;
    return base;
  }

  const SHEET_SCOPED = ['renameSheet', 'hideSheet', 'showSheet', 'freezePanes',
                        'setConditionalFormat', 'clearConditionalFormats'];
  if (SHEET_SCOPED.indexOf(op.type) === -1) {
    if (!op.index || op.index < 1) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'index must be 1 or greater.' } };
    }
  }

  const sheet = opSheet_(ss, op);
  if (!sheet) {
    return { ok: false, type: op.type,
      error: { code: 'SHEET_NOT_FOUND', message: 'No sheet named ' + op.sheetName } };
  }
  const name = sheet.getName();
  base.destructive = false;
  base.reason = '';
  const count = Math.max(1, op.count || 1);
  const span = count > 1 ? op.index + '-' + (op.index + count - 1) : String(op.index);

  if (op.type === 'setColumnWidth' || op.type === 'setRowHeight') {
    const size = op.type === 'setColumnWidth' ? op.width : op.height;
    if (typeof size !== 'number' || size < 1 || size > 2000) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'Need a pixel size between 1 and 2000.' } };
    }
    base.target = name + '!' + (op.type === 'setColumnWidth' ? 'cols ' : 'rows ') + span;
  } else if (op.type === 'freezePanes') {
    if (op.rows === undefined && op.cols === undefined) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'freezePanes needs rows, cols, or both (0 unfreezes).' } };
    }
    base.target = name + '!frozen panes';
  } else if (op.type === 'renameSheet') {
    if (!op.newName || typeof op.newName !== 'string' || op.newName.length > 100) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'renameSheet needs a newName under 100 characters.' } };
    }
    if (ss.getSheetByName(op.newName)) {
      return { ok: false, type: op.type,
        error: { code: 'SHEET_EXISTS', message: "A sheet named '" + op.newName + "' already exists." } };
    }
    base.target = "sheet '" + name + "' → '" + op.newName + "'";
  } else if (op.type === 'hideSheet') {
    const others = ss.getSheets().filter(function (s) {
      return s.getName() !== name && s.getName() !== HISTORY_SHEET && !s.isSheetHidden();
    });
    if (!others.length) {
      return { ok: false, type: op.type,
        error: { code: 'LAST_SHEET', message: 'Cannot hide the only visible sheet.' } };
    }
    base.target = "sheet '" + name + "'";
  } else if (op.type === 'showSheet') {
    base.target = "sheet '" + name + "'";
  } else if (op.type === 'setConditionalFormat') {
    if (!op.a1) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'setConditionalFormat needs an a1 range.' } };
    }
    let range;
    try { range = sheet.getRange(op.a1); } catch (e) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'Bad range "' + op.a1 + '": ' + e.message } };
    }
    if (!condRuleFromSpec_(sheet, range, op.rule)) {
      return { ok: false, type: op.type,
        error: { code: 'BAD_PAYLOAD', message: 'rule needs {when, values?, background?, ' +
          'fontColor?, bold?} or {gradient: {minColor, maxColor, …}}.' } };
    }
    base.target = name + '!' + range.getA1Notation() + ' rule';
  } else if (op.type === 'clearConditionalFormats') {
    base.target = name + ' conditional formats';
  } else {  // hideRows / showRows / hideColumns / showColumns
    base.target = name + '!' + (/Rows$/.test(op.type) ? 'rows ' : 'cols ') + span;
  }
  return base;
}

/**
 * Dry run. Returns one inspection per op, in order, touching nothing.
 * The sidebar uses this to decide what to ask about before anything happens.
 */
function inspectOps(ops, askBefore) {
  if (!Array.isArray(ops)) return [];
  const ss = writeSpreadsheet_();
  const level = askLevel_({ askBefore: askBefore });
  return ops.map(function (op) { return inspectOp_(ss, op, level); });
}

/**
 * Verify the region the ops were planned against has not changed underneath us.
 *
 * This is the compare-and-swap from protocol.md §Concurrency, and the region is
 * the one `getContext` read — NOT each op's own target. Re-hashing an op's
 * target and comparing it to the context hash compares two different ranges,
 * which can only match by luck.
 */
function checkGuard_(ss, guard) {
  if (!guard) return null;

  // Secondary: did a person type anywhere in the file since this turn read it?
  // Catches edits outside the range that was read, which the hash cannot see.
  if (guard.since) {
    const mark = editWatermark_();
    if (mark && mark.at > guard.since) {
      const where = mark.sheetName && mark.a1 ? ' (' + mark.sheetName + '!' + mark.a1 + ')' : '';
      return {
        code: 'CONTEXT_STALE',
        message: 'Someone edited the spreadsheet' + where + ' after this was planned. ' +
                 'Nothing was changed. Read the sheet again before writing.',
      };
    }
  }

  // Primary: is the region this was planned against byte-for-byte unchanged?
  if (!guard.hash || !guard.a1) return null;
  const sheet = guard.sheetName ? ss.getSheetByName(guard.sheetName) : ss.getSheets()[0];
  if (!sheet) {
    return { code: 'SHEET_NOT_FOUND', message: 'No sheet named ' + guard.sheetName };
  }
  const current = hashValues_(sanitizeGrid_(sheet.getRange(guard.a1).getValues()));
  if (current !== guard.hash) {
    return {
      code: 'CONTEXT_STALE',
      message: 'The contents of ' + sheet.getName() + '!' + guard.a1 + ' changed after this ' +
               'was planned. Nothing was changed. Read the sheet again before writing.',
    };
  }
  return null;
}

/**
 * The guard, refreshed to reflect this turn's own work.
 *
 * Without this a multi-write turn defeats itself: op 1 changes the guarded
 * region, so op 2's hash check fails on a change *we* made. Re-hashing after
 * each turn keeps the guard sensitive to everyone except us.
 */
function refreshedGuard_(ss, guard) {
  if (!guard || !guard.a1) return null;
  const sheet = guard.sheetName ? ss.getSheetByName(guard.sheetName) : ss.getSheets()[0];
  if (!sheet) return null;
  try {
    return {
      sheetName: sheet.getName(),
      a1: guard.a1,
      hash: hashValues_(sanitizeGrid_(sheet.getRange(guard.a1).getValues())),
      since: guard.since || null,
    };
  } catch (e) {
    return null;   // the region stopped existing (a structural op); drop the guard
  }
}

function newOpId_() {
  return 'op_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
}

/**
 * Apply one already-gated structural op and record its inverse.
 *
 * Order is load-bearing on deletes: snapshot FIRST, then delete — the payload
 * has to be captured while the cells still exist. Undo is the stored inverse:
 * an insert is undone by deleting what it inserted; a delete by re-inserting
 * the coordinates and rewriting the snapshot into them (History.gs).
 */
function applyStructural_(ss, op, turnId) {
  const opId = op.opId || newOpId_();
  const count = Math.max(1, op.count || 1);
  let target;
  let snapshot = null;
  let inverse;
  let sheetName;

  if (op.type === 'addSheet') {
    ss.insertSheet(op.name);
    sheetName = op.name;
    target = structTarget_(op, op.name);
    inverse = { type: 'deleteSheet', name: op.name };
  } else if (op.type === 'duplicateSheet') {
    const source = opSheet_(ss, op);
    const copy = source.copyTo(ss);
    if (op.newName) copy.setName(op.newName);
    sheetName = copy.getName();
    target = structTarget_(op, source.getName());
    // Undoing a duplicate deletes the copy — nothing else changed, and the
    // source needs no snapshot.
    inverse = { type: 'deleteSheet', name: sheetName };
  } else {
    const sheet = opSheet_(ss, op);
    sheetName = sheet.getName();
    target = structTarget_(op, sheetName);

    if (op.type === 'insertRows') {
      sheet.insertRowsBefore(op.index, count);
      inverse = { type: 'deleteRows', index: op.index, count: count };
    } else if (op.type === 'insertColumns') {
      sheet.insertColumnsBefore(op.index, count);
      inverse = { type: 'deleteColumns', index: op.index, count: count };
    } else if (op.type === 'deleteRows') {
      const width = Math.max(1, sheet.getLastColumn());
      snapshot = snapshotRange_(sheet, sheet.getRange(op.index, 1, count, width));
      sheet.deleteRows(op.index, count);
      inverse = { type: 'insertRows', index: op.index, count: count };
    } else if (op.type === 'deleteColumns') {
      const height = Math.max(1, sheet.getLastRow());
      snapshot = snapshotRange_(sheet, sheet.getRange(1, op.index, height, count));
      sheet.deleteColumns(op.index, count);
      inverse = { type: 'insertColumns', index: op.index, count: count };
    } else {  // deleteSheet
      const lastRow = Math.max(1, sheet.getLastRow());
      const lastCol = Math.max(1, sheet.getLastColumn());
      snapshot = snapshotRange_(sheet, sheet.getRange(1, 1, lastRow, lastCol));
      inverse = { type: 'recreateSheet', name: sheetName, index: sheet.getIndex() - 1 };
      ss.deleteSheet(sheet);
    }
  }

  SpreadsheetApp.flush();
  const recorded = recordHistory_(opId, op.type, target, snapshot, turnId,
    { structural: true, sheetName: sheetName, inverse: inverse });

  return {
    ok: true,
    opId: opId,
    type: op.type,
    applied: target,
    restorable: recorded.restorable,
  };
}

/**
 * Apply one already-gated range op.
 *
 * Sort rides the value-op undo path exactly: snapshot before, restore on undo,
 * nothing else needed. Merge and unmerge record an inverse as well — undoing a
 * merge is breakApart + restore + re-merge whatever the merge displaced, and
 * undoing an unmerge is re-merging what it broke.
 */
function applyRangeOp_(ss, op, turnId) {
  const sheet = opSheet_(ss, op);
  const range = opRange_(sheet, op);
  const opId = op.opId || newOpId_();
  const target = sheet.getName() + '!' + range.getA1Notation();
  let snapshot = null;
  let extra = null;

  if (op.type === 'sortRange') {
    snapshot = snapshotRange_(sheet, range);
    range.sort(op.by.map(function (s) {
      return { column: colNum_(s.column), ascending: s.ascending !== false };
    }));
  } else if (op.type === 'mergeCells') {
    snapshot = snapshotRange_(sheet, range);
    const prior = range.getMergedRanges().map(function (r) { return r.getA1Notation(); });
    const mergeType = op.mergeType || 'all';
    if (mergeType === 'across') range.mergeAcross();
    else if (mergeType === 'vertical') range.mergeVertically();
    else range.merge();
    extra = { sheetName: sheet.getName(),
              inverse: { type: 'unmergeRestore', priorMerges: prior } };
  } else if (op.type === 'unmergeCells') {
    // Values survive an unmerge, so no snapshot needed.
    const prior = range.getMergedRanges().map(function (r) { return r.getA1Notation(); });
    range.breakApart();
    extra = { sheetName: sheet.getName(), a1: range.getA1Notation(),
              inverse: { type: 'remerge', ranges: prior } };
  } else if (op.type === 'setBorders') {
    // The snapshot carries the prior borders (borderGrid_), so undo is the
    // plain restore path — same as a value write.
    snapshot = snapshotRange_(sheet, range);
    const b = function (edge) { return op[edge] === undefined ? null : Boolean(op[edge]); };
    if (op.style === 'none') {
      range.setBorder(b('top'), b('left'), b('bottom'), b('right'),
                      b('vertical'), b('horizontal'), null, null);
    } else {
      range.setBorder(b('top'), b('left'), b('bottom'), b('right'),
                      b('vertical'), b('horizontal'),
                      op.color || '#000000', borderStyleEnum_(op.style));
    }
  } else if (op.type === 'setNote') {
    snapshot = snapshotRange_(sheet, range);
    range.setNote(op.note ? String(op.note) : null);
  } else {  // setValidation — the snapshot's validations grid is the undo
    snapshot = snapshotRange_(sheet, range);
    const rule = op.rule || {};
    if (rule.type === 'none') {
      range.clearDataValidations();
    } else {
      let builder = SpreadsheetApp.newDataValidation();
      if (rule.type === 'list') builder = builder.requireValueInList(rule.values.map(String), true);
      else if (rule.type === 'numberBetween') builder = builder.requireNumberBetween(rule.min, rule.max);
      else if (rule.type === 'numberGreaterThan') builder = builder.requireNumberGreaterThan(rule.min);
      else if (rule.type === 'checkbox') builder = builder.requireCheckbox();
      else builder = builder.requireDate();
      builder = builder.setAllowInvalid(rule.allowInvalid !== false);
      if (rule.help) builder = builder.setHelpText(String(rule.help));
      range.setDataValidation(builder.build());
    }
  }

  SpreadsheetApp.flush();
  const recorded = recordHistory_(opId, op.type, target, snapshot, turnId, extra);
  return {
    ok: true,
    opId: opId,
    type: op.type,
    applied: target,
    restorable: recorded.restorable,
    newContextHash: hashValues_(sanitizeGrid_(range.getValues())),
  };
}

/**
 * Apply one layout op, recording just enough prior state to undo it exactly.
 *
 * renameSheet additionally rewrites every history entry's sheetName from the
 * old name to the new one. Without that, the rename orphans the whole history:
 * every earlier entry points at a name that no longer exists, and every undo
 * on this sheet fails. Coordinates are untouched by a rename, so the rewrite
 * is lossless — and undoing the rename rewrites them back.
 */
function applyLayout_(ss, op, turnId) {
  const opId = op.opId || newOpId_();
  const sheet = opSheet_(ss, op);
  let entrySheetName = sheet.getName();
  const count = Math.max(1, op.count || 1);
  const span = count > 1 ? op.index + '-' + (op.index + count - 1) : String(op.index);
  let target, inverse, layout;

  if (op.type === 'setColumnWidth') {
    const widths = [];
    for (let c = op.index; c < op.index + count; c++) {
      widths.push({ index: c, width: sheet.getColumnWidth(c) });
      sheet.setColumnWidth(c, op.width);
    }
    target = entrySheetName + '!cols ' + span + ' → ' + op.width + 'px';
    inverse = { type: 'layout', kind: 'colwidth', widths: widths };
    layout = { kind: 'colwidth', index: op.index, count: count };
  } else if (op.type === 'setRowHeight') {
    const heights = [];
    for (let r = op.index; r < op.index + count; r++) {
      heights.push({ index: r, height: sheet.getRowHeight(r) });
      sheet.setRowHeight(r, op.height);
    }
    target = entrySheetName + '!rows ' + span + ' → ' + op.height + 'px';
    inverse = { type: 'layout', kind: 'rowheight', heights: heights };
    layout = { kind: 'rowheight', index: op.index, count: count };
  } else if (op.type === 'freezePanes') {
    inverse = { type: 'layout', kind: 'freeze',
                rows: sheet.getFrozenRows(), cols: sheet.getFrozenColumns() };
    if (op.rows !== undefined) sheet.setFrozenRows(op.rows);
    if (op.cols !== undefined) sheet.setFrozenColumns(op.cols);
    target = entrySheetName + '!frozen: ' + sheet.getFrozenRows() + ' row' +
      (sheet.getFrozenRows() === 1 ? '' : 's') + ', ' + sheet.getFrozenColumns() + ' col' +
      (sheet.getFrozenColumns() === 1 ? '' : 's');
    layout = { kind: 'freeze' };
  } else if (op.type === 'renameSheet') {
    const from = entrySheetName;
    sheet.setName(op.newName);
    const index = readIndex_();
    index.forEach(function (e) { if (e.sheetName === from) e.sheetName = op.newName; });
    writeIndex_(index);
    entrySheetName = op.newName;
    target = "sheet '" + from + "' → '" + op.newName + "'";
    inverse = { type: 'layout', kind: 'rename', to: from };
    layout = { kind: 'rename' };
  } else if (op.type === 'hideSheet' || op.type === 'showSheet') {
    inverse = { type: 'layout', kind: 'sheetvis', hidden: sheet.isSheetHidden() };
    if (op.type === 'hideSheet') sheet.hideSheet(); else sheet.showSheet();
    target = "sheet '" + entrySheetName + "'";
    layout = { kind: 'sheetvis' };
  } else if (op.type === 'setConditionalFormat' || op.type === 'clearConditionalFormats') {
    // Rules are whole-sheet state through the API, so the inverse is the
    // sheet's prior rule list, stored as the API's own JSON and restored
    // verbatim. SpreadsheetApp cannot read a rule's format back; the Advanced
    // Sheets service round-trips it untouched.
    const prior = condRules_(ss, sheet);
    if (op.type === 'setConditionalFormat') {
      const range = sheet.getRange(op.a1);
      const rule = condRuleFromSpec_(sheet, range, op.rule);
      setCondRules_(ss, sheet, prior.concat([rule]));
      target = entrySheetName + '!' + range.getA1Notation() + ' rule';
    } else {
      setCondRules_(ss, sheet, []);
      target = entrySheetName + ' conditional formats (' + prior.length + ' rule' +
        (prior.length === 1 ? '' : 's') + ' removed)';
    }
    inverse = { type: 'layout', kind: 'condfmt', rules: prior };
    layout = { kind: 'condfmt' };
  } else if (op.type === 'setNamedRange' || op.type === 'deleteNamedRange') {
    const existing = namedRange_(ss, op.name);
    const priorA1 = existing
      ? { sheetName: existing.getRange().getSheet().getName(),
          a1: existing.getRange().getA1Notation() }
      : null;
    if (op.type === 'setNamedRange') {
      const targetSheet = opSheet_(ss, op);
      ss.setNamedRange(op.name, targetSheet.getRange(op.a1));
      entrySheetName = targetSheet.getName();
      target = "named range '" + op.name + "' → " + entrySheetName + '!' + op.a1;
    } else {
      existing.remove();
      entrySheetName = priorA1.sheetName;
      target = "named range '" + op.name + "'";
    }
    // key scopes the conflict: edits to DIFFERENT named ranges never block
    // each other's undo; edits to the same one do.
    inverse = { type: 'layout', kind: 'namedrange', name: op.name, prior: priorA1 };
    layout = { kind: 'namedrange', key: op.name };
  } else {  // hideRows / showRows / hideColumns / showColumns
    const rows = /Rows$/.test(op.type);
    const spans = [];
    for (let i = op.index; i < op.index + count; i++) {
      spans.push({ index: i,
        hidden: rows ? sheet.isRowHiddenByUser(i) : sheet.isColumnHiddenByUser(i) });
    }
    if (op.type === 'hideRows') sheet.hideRows(op.index, count);
    else if (op.type === 'showRows') sheet.showRows(op.index, count);
    else if (op.type === 'hideColumns') sheet.hideColumns(op.index, count);
    else sheet.showColumns(op.index, count);
    target = entrySheetName + '!' + (rows ? 'rows ' : 'cols ') + span;
    inverse = { type: 'layout', kind: rows ? 'rowshidden' : 'colshidden', spans: spans };
    layout = { kind: rows ? 'rowhidden' : 'colhidden', index: op.index, count: count };
  }

  SpreadsheetApp.flush();
  const recorded = recordHistory_(opId, op.type, target, null, turnId,
    { sheetName: entrySheetName, layout: layout, inverse: inverse });
  return { ok: true, opId: opId, type: op.type, applied: target, restorable: recorded.restorable };
}

/** Apply one already-gated op. Assumes inspection and confirmation happened. */
function applyOne_(ss, op, turnId) {
  if (STRUCTURAL_OPS.indexOf(op.type) !== -1) return applyStructural_(ss, op, turnId);
  if (LAYOUT_OPS.indexOf(op.type) !== -1) return applyLayout_(ss, op, turnId);
  if (RANGE_OPS.indexOf(op.type) !== -1) return applyRangeOp_(ss, op, turnId);
  const sheet = opSheet_(ss, op);
  const range = opRange_(sheet, op);
  const opId = op.opId || newOpId_();

  // Snapshot before writing — this is the entire undo guarantee, and it captures
  // formats as well as values so a restore does not leave the sheet visibly wrong.
  const snapshot = snapshotRange_(sheet, range);

  if (op.type === 'setValues') {
    if (!Array.isArray(op.values) || !Array.isArray(op.values[0])) {
      return { ok: false, opId: opId, error: { code: 'BAD_PAYLOAD', message: 'values must be a 2-D array.' } };
    }
    range.setValues(op.values);
  } else if (op.type === 'setFormulas') {
    if (!Array.isArray(op.formulas) || !Array.isArray(op.formulas[0])) {
      return { ok: false, opId: opId, error: { code: 'BAD_PAYLOAD', message: 'formulas must be a 2-D array.' } };
    }
    range.setFormulas(op.formulas);
  } else if (op.type === 'setFormats') {
    const f = op.format || {};
    if (f.background) range.setBackground(f.background);
    if (f.fontColor) range.setFontColor(f.fontColor);
    if (f.bold !== undefined) range.setFontWeight(f.bold ? 'bold' : 'normal');
    if (f.italic !== undefined) range.setFontStyle(f.italic ? 'italic' : 'normal');
    if (f.numberFormat) range.setNumberFormat(f.numberFormat);
    if (f.align) range.setHorizontalAlignment(f.align);
    if (f.fontSize) range.setFontSize(f.fontSize);
    if (f.fontFamily) range.setFontFamily(f.fontFamily);
    if (f.wrap !== undefined) range.setWrap(Boolean(f.wrap));
    if (f.verticalAlign) range.setVerticalAlignment(f.verticalAlign);
    if (f.fontLine) range.setFontLine(f.fontLine);
  } else if (op.type === 'clear') {
    const what = op.what || 'all';
    if (what === 'values') range.clearContent();
    else if (what === 'formats') range.clearFormat();
    else range.clear();
  } else {
    return { ok: false, opId: opId,
      error: { code: 'NOT_IMPLEMENTED', message: 'Unsupported op type: ' + op.type } };
  }

  SpreadsheetApp.flush();

  const target = sheet.getName() + '!' + range.getA1Notation();
  const recorded = recordHistory_(opId, op.type, target, snapshot, turnId);

  return {
    ok: true,
    opId: opId,
    type: op.type,
    applied: target,
    restorable: recorded.restorable,
    newContextHash: hashValues_(sanitizeGrid_(range.getValues())),
  };
}

/**
 * Execute a turn's ops in order.
 *
 * @param {{ops: Array, guard?: {sheetName, a1, hash}, confirmed?: string[],
 *          prompt?: string}} request
 *
 * Stops at the first failure rather than pressing on: later ops in a turn are
 * usually planned against the state the earlier ones were meant to produce, so
 * continuing past a failure applies them to a sheet that never reached it.
 * Everything already applied stays applied, and each carries its own history
 * entry, so the user can walk it back one step at a time.
 */
function applyOps(request) {
  request = request || {};
  const ops = request.ops || [];
  if (!Array.isArray(ops) || !ops.length) {
    return { ok: false, error: { code: 'BAD_PAYLOAD', message: 'No ops supplied.' } };
  }

  const ss = writeSpreadsheet_();

  const stale = checkGuard_(ss, request.guard);
  if (stale) return { ok: false, error: stale };

  const turnId = 'turn_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  const confirmed = request.confirmed || [];
  const level = askLevel_(request);
  const results = [];

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (!op.opId) op.opId = newOpId_();

    // Re-inspect at apply time. The sidebar's inspection is a UI convenience;
    // this is the check that actually governs, and it runs against the sheet as
    // it is now — including whatever the previous op in this turn just changed.
    const check = inspectOp_(ss, op, level);
    if (!check.ok) {
      results.push({ ok: false, opId: op.opId, type: op.type, error: check.error });
      break;
    }
    if (check.destructive && confirmed.indexOf(op.opId) === -1) {
      results.push({ ok: false, opId: op.opId, type: op.type, needsConfirmation: true,
        target: check.target, reason: check.reason,
        error: { code: 'NEEDS_CONFIRMATION', message: 'This op ' + check.reason + '.' } });
      break;
    }

    let res;
    try {
      res = applyOne_(ss, op, turnId);
    } catch (e) {
      res = { ok: false, opId: op.opId, type: op.type,
        error: { code: 'APPLY_FAILED', message: String(e && e.message || e) } };
    }
    results.push(res);
    if (!res.ok) break;
  }

  return {
    ok: results.every(function (r) { return r.ok; }),
    turnId: turnId,
    results: results,
    // Hand the caller a guard that accounts for what we just did, so the next
    // write in this turn is not rejected because of our own edit.
    guard: refreshedGuard_(ss, request.guard),
  };
}

// ======================================================================
// Code.gs
// ======================================================================

/**
 * Do NOT add the OnlyCurrentDoc annotation here — see the note in Sheet.gs.
 * It breaks undo across the whole add-on.
 *
 * Entry points. Thin by design — sheet access lives in Sheet.gs, and the
 * sidebar orchestrates. Apps Script's only jobs are hosting the sidebar and
 * executing sheet operations; it never talks to a model.
 *
 * Sheet reads live in Sheet.gs, multi-op execution in Ops.gs, and the undo
 * history in History.gs. Apps Script never talks to a model — the sidebar does
 * that, and hands back ops to run.
 */

const SIDEBAR_TITLE = 'Claude';

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu(SIDEBAR_TITLE)
    .addItem('Open sidebar', 'showSidebar')
    .addSeparator()
    .addItem('Diagnostic', 'showDiagnostic')
    .addToUi();
}

function showSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('Sidebar').setTitle(SIDEBAR_TITLE);
  SpreadsheetApp.getUi().showSidebar(html);
}

function showDiagnostic() {
  const html = HtmlService.createHtmlOutputFromFile('Diagnostic').setTitle('Diagnostic');
  SpreadsheetApp.getUi().showSidebar(html);
}

/**
 * Records that a *person* touched the sheet.
 *
 * A simple trigger fires for human edits and never for programmatic ones, which
 * makes it the one unambiguous signal we have: if this timestamp moves during a
 * turn, someone typed. Our own writes go through `openById` and never land here.
 *
 * This is the secondary check — it catches an edit anywhere in the file, where
 * the range hash only covers what Claude actually read. Wrapped in try/catch
 * because a simple trigger runs unauthorized and must never break the user's
 * ability to type in their own spreadsheet.
 */
function onEdit(e) {
  try {
    const range = e && e.range;
    PropertiesService.getDocumentProperties().setProperty(EDIT_MARK_KEY, JSON.stringify({
      at: Date.now(),
      sheetName: range ? range.getSheet().getName() : null,
      a1: range ? range.getA1Notation() : null,
    }));
  } catch (err) {
    // Nothing to do and nothing worth failing over. The range hash still covers
    // the region Claude read, which is the common case.
  }
}

/**
 * Transport check. Returns a primitive and touches nothing — if this does not
 * round trip, the problem is google.script.run itself, not any payload.
 */
function ping() {
  return 'pong ' + Date.now();
}

/**
 * Manifest without cell data. Sits between ping() and getContext(): if this
 * returns but getContext() does not, the culprit is in the values/formulas grid.
 */
function getManifest() {
  return {
    spreadsheetId: readSpreadsheet_().getId(),
    spreadsheetName: readSpreadsheet_().getName(),
    sheets: sheetManifest_(),
  };
}

/**
 * Gather what the model needs to reason about the sheet, plus the context hash
 * that a later write will be checked against.
 *
 * Two tiers on purpose: the manifest is cheap and always included; full cell
 * data is only for the tab in play. Dumping every tab into a prompt does not
 * scale, and the same problem arrives with one large tab anyway.
 *
 * @param {{sheetName?: string, a1?: string}} opts
 */
function getContext(opts) {
  opts = opts || {};
  const started = Date.now();

  const context = {
    spreadsheetId: readSpreadsheet_().getId(),
    spreadsheetName: readSpreadsheet_().getName(),
    sheets: sheetManifest_(),
    active: readRange_(opts.sheetName, opts.a1),
    // Carried back on every write this turn, so a human edit made after this
    // read is detected even if it lands outside the range above.
    editWatermark: editWatermark_(),
  };

  context.elapsedMs = Date.now() - started;
  return context;
}

/**
 * Execute one operation. Kept because a single op is the common case and a
 * one-element turn reads badly at the call site; everything real happens in
 * Ops.gs, so there is exactly one write path and one confirmation gate.
 *
 * @param {Object} op  See shared/protocol.md
 */
function applyOp(op) {
  const res = applyOps({ ops: [op], guard: op && op.guard, confirmed: op && op.confirmed });
  if (res.results && res.results.length) return res.results[0];
  return res;
}
