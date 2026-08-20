/**
 * @OnlyCurrentDoc
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
