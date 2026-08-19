/**
 * On-disk state: paired spreadsheets and the cross-spreadsheet activity index.
 *
 * The activity index is what makes the dashboard work across files without any
 * Google scope — the daemon served every turn, so it already knows what it did
 * and where. See ARCHITECTURE.md §6.
 *
 * Snapshot payloads are deliberately NOT here. They live in a hidden sheet
 * inside the user's own spreadsheet so restore works with the daemon closed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.homedir(), '.claude-sheets');
const FILE = path.join(DIR, 'state.json');

const DEFAULTS = {
  version: 1,
  paired: {},   // spreadsheetId -> { name, pairedAt, instructions, sessionId }
  activity: [], // newest first; capped
  settings: {
    maxActivity: 500,
    // Applies to every spreadsheet. The equivalent of Claude for Excel's
    // Instructions field — ours, not inherited from any coding project.
    globalInstructions: '',
    // Claude Code's default is whatever the user set for coding, which may be a
    // premium model. A spreadsheet edit rarely needs one — and every turn pays
    // ~25k tokens of CLI baseline overhead, so model choice dominates cost.
    model: 'claude-sonnet-5',
  },
};

/**
 * Read-through, deliberately uncached.
 *
 * An in-memory cache plus whole-file writes means any second process — or a
 * stale one that outlives a restart — silently overwrites newer state with its
 * own snapshot. That shows up in the wild as pairings vanishing for no visible
 * reason, which is miserable to diagnose. The file is a few KB; just read it.
 *
 * `settings` is merged key-by-key so that a state file written by an older
 * version does not erase defaults added since.
 */
function load() {
  let parsed = {};
  try {
    parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch { /* first run, or unreadable — fall back to defaults */ }

  return {
    ...DEFAULTS,
    ...parsed,
    settings: { ...DEFAULTS.settings, ...(parsed.settings || {}) },
  };
}

/** Write atomically — a crash mid-write must not truncate the state file. */
function save(next) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, FILE);
}

/** Read → mutate → write, so every caller works from current disk state. */
function update(fn) {
  const s = load();
  const result = fn(s);
  save(s);
  return result;
}

function isPaired(spreadsheetId) {
  return Boolean(load().paired[spreadsheetId]);
}

function pair(spreadsheetId, name) {
  update((s) => {
    s.paired[spreadsheetId] = {
      name: name || '(unnamed)',
      pairedAt: new Date().toISOString(),
      instructions: (s.paired[spreadsheetId] || {}).instructions || '',
      sessionId: (s.paired[spreadsheetId] || {}).sessionId || null,
    };
  });
}

function unpair(spreadsheetId) {
  update((s) => { delete s.paired[spreadsheetId]; });
}

function listPaired() {
  const p = load().paired;
  return Object.keys(p).map((id) => ({ spreadsheetId: id, ...p[id] }));
}

/** Newest first, per the vault-wide convention for dated logs. */
function recordActivity(entry) {
  update((s) => {
    s.activity.unshift({ at: new Date().toISOString(), ...entry });
    if (s.activity.length > s.settings.maxActivity) {
      s.activity.length = s.settings.maxActivity;
    }
  });
}

function listActivity(limit = 50) {
  return load().activity.slice(0, limit);
}

/**
 * Instructions are this product's own memory layer, deliberately separate from
 * Claude Code's projects, CLAUDE.md, and auto-memory. A coding project's context
 * is noise in a spreadsheet; sheet-scoped preferences are what actually help.
 */
function getInstructions(spreadsheetId) {
  const s = load();
  return {
    global: s.settings.globalInstructions || '',
    sheet: (s.paired[spreadsheetId] || {}).instructions || '',
  };
}

/**
 * The Claude Code session backing this spreadsheet's conversation.
 *
 * One session per spreadsheet, not per daemon run: the conversation should
 * survive closing the app, the same way the edit history does. Only the ID is
 * kept — the transcript itself is Claude Code's, in the project bucket for the
 * neutral workspace cwd, and is not read by this process.
 */
function getSessionId(spreadsheetId) {
  return (load().paired[spreadsheetId] || {}).sessionId || null;
}

function setSessionId(spreadsheetId, sessionId) {
  return update((s) => {
    if (!s.paired[spreadsheetId]) return false;
    s.paired[spreadsheetId].sessionId = sessionId || null;
    return true;
  });
}

/** Start a new conversation for this spreadsheet, keeping it paired. */
function clearSessionId(spreadsheetId) {
  return setSessionId(spreadsheetId, null);
}

function getSettings() {
  return load().settings;
}

function setGlobalInstructions(text) {
  update((s) => { s.settings.globalInstructions = String(text || ''); });
}

function setSheetInstructions(spreadsheetId, text) {
  return update((s) => {
    if (!s.paired[spreadsheetId]) return false;
    s.paired[spreadsheetId].instructions = String(text || '');
    return true;
  });
}

module.exports = {
  DIR, FILE,
  isPaired, pair, unpair, listPaired,
  recordActivity, listActivity,
  getInstructions, setGlobalInstructions, setSheetInstructions, getSettings,
  getSessionId, setSessionId, clearSessionId,
};
