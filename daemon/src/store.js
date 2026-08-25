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
    // Web search and fetch, each request approved in the sidebar (M5.5).
    // Defaults on because the gate is always in front of it; false removes the
    // web tools from the CLI invocation entirely.
    webAccess: true,
    /**
     * How much the confirmation gate asks about.
     *
     *   'destructive'   — anything that overwrites or deletes (the default)
     *   'unrecoverable' — only what undo cannot take back
     *
     * The split is undo, not difficulty. Every gated sheet edit is restorable
     * from the in-file history, so for those the prompt is a courtesy and
     * relaxing it is honest. Deleting a tab, and any edit too large to
     * snapshot, are different in kind and keep asking either way — as does
     * every web request, which this setting does not touch at all, because
     * data that has already left cannot be restored.
     */
    askBefore: 'destructive',
    // Start the app at login. Owned here so the dashboard can show its real
    // state; the OS-level registration is applied by the daemon (M10.6).
    autostart: false,
    // True when the logon task had to fall back to the interactive variant,
    // which shows a console window. Display only.
    autostartWindow: false,
  },
};

/** The only values `askBefore` may take. Anything else falls back to strictest. */
const ASK_LEVELS = ['destructive', 'unrecoverable'];

/**
 * The models on offer, in the order they are offered.
 *
 * One list, served to both front ends rather than written into either. The
 * dashboard used to carry its own `<option>`s, and the sidebar picker would
 * have made that two hardcoded lists to keep in step — with the sidebar's half
 * living in Apps Script, where updating it means a `clasp push` rather than a
 * restart. Adding a model is now a change to this array and nothing else.
 *
 * It is also the allowlist: `setSettings` refuses a model that is not here, so
 * a bad value cannot be written by anything, and every turn spawns with a model
 * the CLI will accept.
 */
const MODELS = [
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
];

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

/**
 * Write settings from the dashboard, one key at a time and validated here.
 *
 * Validation is deliberately at the store rather than the route: `askBefore`
 * decides how much the confirmation gate asks about, so an unrecognized value
 * must fall back to the STRICTEST setting rather than being stored verbatim
 * and later compared loosely. A typo should never quietly widen what applies
 * without asking.
 *
 * Returns the full settings object as saved, so the caller can answer with
 * exactly what is now true rather than what it hoped to write.
 */
function setSettings(patch) {
  return update((s) => {
    const p = patch || {};
    // Allowlisted, not merely non-empty. A model string reaches the CLI as an
    // argument and a wrong one fails every turn until someone notices — and now
    // that the sidebar can set this, "whatever was posted" is not good enough.
    if (typeof p.model === 'string' && MODELS.some((m) => m.id === p.model.trim())) {
      s.settings.model = p.model.trim();
    }
    if (p.webAccess !== undefined) {
      s.settings.webAccess = Boolean(p.webAccess);
    }
    if (p.askBefore !== undefined) {
      s.settings.askBefore =
        ASK_LEVELS.indexOf(p.askBefore) === -1 ? 'destructive' : p.askBefore;
    }
    if (p.autostart !== undefined) {
      s.settings.autostart = Boolean(p.autostart);
    }
    if (p.autostartWindow !== undefined) {
      s.settings.autostartWindow = Boolean(p.autostartWindow);
    }
    return s.settings;
  });
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
  DIR, FILE, ASK_LEVELS, MODELS,
  isPaired, pair, unpair, listPaired,
  recordActivity, listActivity,
  getInstructions, setGlobalInstructions, setSheetInstructions,
  getSettings, setSettings,
  getSessionId, setSessionId, clearSessionId,
};
