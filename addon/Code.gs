/**
 * @OnlyCurrentDoc
 *
 * Entry points. Thin by design — sheet access lives in Sheet.gs, and the
 * sidebar orchestrates. Apps Script's only jobs are hosting the sidebar and
 * executing sheet operations; it never talks to a model.
 *
 * M1 scope: menu, sidebar, and a real google.script.run round trip that reads
 * sheet context. Writes are stubbed until M3.
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
  };

  context.elapsedMs = Date.now() - started;
  return context;
}

/**
 * Execute one operation against the sheet.
 *
 * Not implemented until M3. The signature is fixed now because shared/protocol.md
 * is the contract both halves import, and because the write path has to go
 * through writeSpreadsheet_() (see Sheet.gs) from the first line of code rather
 * than being corrected later.
 *
 * @param {Object} op  See shared/protocol.md
 */
function applyOp(op) {
  if (!op || op.type !== 'setValues') {
    return { ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'Only setValues is supported at M3.' } };
  }

  const ss = writeSpreadsheet_();   // never the bound handle — this is what keeps
  const sheet = op.sheetName        // agent writes out of the native undo stack
    ? ss.getSheetByName(op.sheetName)
    : ss.getSheets()[0];
  if (!sheet) {
    return { ok: false, error: { code: 'SHEET_NOT_FOUND', message: 'No sheet named ' + op.sheetName } };
  }

  const range = sheet.getRange(op.a1);

  // Range-scoped compare-and-swap. Sheets v4 has no ETag and LockService does
  // not cover a human typing in the UI, so this is the only primitive available.
  if (op.contextHash) {
    const current = hashValues_(sanitizeGrid_(range.getValues()));
    if (current !== op.contextHash) {
      return { ok: false, error: {
        code: 'CONTEXT_STALE',
        message: 'The sheet changed since this was planned. Re-read and try again.',
      } };
    }
  }

  const values = op.values;
  if (!Array.isArray(values) || !Array.isArray(values[0])) {
    return { ok: false, error: { code: 'BAD_PAYLOAD', message: 'values must be a 2-D array.' } };
  }

  const target = sheet.getRange(range.getRow(), range.getColumn(), values.length, values[0].length);

  // Snapshot before writing — this is the whole undo guarantee.
  const snapshot = snapshotRange_(sheet, target);
  const opId = 'op_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);

  target.setValues(values);
  SpreadsheetApp.flush();

  const recorded = recordHistory_(
    opId, 'setValues', sheet.getName() + '!' + target.getA1Notation(), snapshot);

  return {
    ok: true,
    opId: opId,
    applied: sheet.getName() + '!' + target.getA1Notation(),
    restorable: recorded.restorable,
    newContextHash: hashValues_(sanitizeGrid_(target.getValues())),
  };
}
