/**
 * The MCP seam, made real (ARCHITECTURE.md §7).
 *
 * A stdio MCP server the Claude Code CLI spawns for each turn. It owns no
 * logic: every tool call is forwarded to the daemon over loopback HTTPS, the
 * daemon relays it to the sidebar over the already-open SSE stream, the sidebar
 * executes it through Apps Script, and the result flows back the same way.
 *
 *   claude ──stdio──> this ──HTTPS──> daemon ──SSE──> sidebar ──> Apps Script
 *
 * So Claude gets a real tool loop — read, write, read back, continue — while
 * execution authority stays exactly where it was: in the sidebar, behind the
 * confirmation gate in Ops.gs. This process can not touch a spreadsheet; it can
 * only ask the sidebar to.
 *
 * Identity comes from env (set per-turn in the --mcp-config the daemon builds):
 *   SHEETS_TURN_TOKEN  proves this bridge belongs to a live turn
 *   SHEETS_DAEMON_PORT where the daemon listens
 *
 * Zero dependencies, like the rest of the daemon. MCP stdio framing is
 * newline-delimited JSON-RPC 2.0.
 */

'use strict';

const https = require('https');

const TOKEN = process.env.SHEETS_TURN_TOKEN || '';
const PORT = Number(process.env.SHEETS_DAEMON_PORT || 8443);

/**
 * The tool vocabulary. Names map 1:1 onto the op protocol
 * (shared/protocol.md) so the sidebar's translation is trivial.
 *
 * Descriptions are written for the model: they carry the rules that used to
 * live only in the system prompt, because tool descriptions survive prompt
 * edits and are re-read on every turn.
 */
const GRID = { type: 'array', items: { type: 'array' } };
const TOOLS = [
  {
    name: 'read_range',
    description: 'Read a range from the spreadsheet: values, formulas, and the '
      + 'tab manifest. Omit a1 to read the data region of the sheet; omit both '
      + 'arguments for the active sheet. Large ranges are truncated — the result '
      + 'says so. Read before you write when you are not certain what a range holds.',
    inputSchema: {
      type: 'object',
      properties: {
        sheetName: { type: 'string', description: 'Tab name. Defaults to the active sheet.' },
        a1: { type: 'string', description: 'Range like "A1:D20". Defaults to the data region.' },
      },
    },
  },
  {
    name: 'set_values',
    description: 'Write literal values. a1 is the top-left anchor; the written '
      + 'range is sized from the grid. values is always 2-D, row-major, even for '
      + 'one cell. Each call is one undoable history entry, so keep unrelated '
      + 'changes in separate calls.',
    inputSchema: {
      type: 'object',
      properties: {
        sheetName: { type: 'string' },
        a1: { type: 'string' },
        values: GRID,
      },
      required: ['sheetName', 'a1', 'values'],
    },
  },
  {
    name: 'set_formulas',
    description: 'Write formulas, e.g. [["=SUM(A1:A9)"]]. Prefer a formula over '
      + 'computing a value yourself: it keeps working as the data changes. Same '
      + 'shape rules as set_values.',
    inputSchema: {
      type: 'object',
      properties: {
        sheetName: { type: 'string' },
        a1: { type: 'string' },
        formulas: GRID,
      },
      required: ['sheetName', 'a1', 'formulas'],
    },
  },
  {
    name: 'set_formats',
    description: 'Format a range. One format object applied to the whole range: '
      + '{background, fontColor ("#rrggbb"), bold, italic, numberFormat '
      + '(e.g. "0.00", "$#,##0"), align ("left"|"center"|"right")}.',
    inputSchema: {
      type: 'object',
      properties: {
        sheetName: { type: 'string' },
        a1: { type: 'string' },
        format: { type: 'object' },
      },
      required: ['sheetName', 'a1', 'format'],
    },
  },
  {
    name: 'clear_range',
    description: 'Clear a range: what is "all", "values", or "formats". '
      + 'Clearing anything non-empty asks the user first.',
    inputSchema: {
      type: 'object',
      properties: {
        sheetName: { type: 'string' },
        a1: { type: 'string' },
        what: { type: 'string', enum: ['all', 'values', 'formats'] },
      },
      required: ['sheetName', 'a1'],
    },
  },
  {
    name: 'insert_rows',
    description: 'Insert count blank rows (default 1). index is the 1-based row '
      + 'number the new rows will occupy; existing rows shift down. Never asks.',
    inputSchema: {
      type: 'object',
      properties: {
        sheetName: { type: 'string' },
        index: { type: 'integer', minimum: 1 },
        count: { type: 'integer', minimum: 1 },
      },
      required: ['sheetName', 'index'],
    },
  },
  {
    name: 'delete_rows',
    description: 'Delete count rows (default 1) starting at the 1-based index. '
      + 'Asks the user first when the rows hold any content. Undoable.',
    inputSchema: {
      type: 'object',
      properties: {
        sheetName: { type: 'string' },
        index: { type: 'integer', minimum: 1 },
        count: { type: 'integer', minimum: 1 },
      },
      required: ['sheetName', 'index'],
    },
  },
  {
    name: 'insert_columns',
    description: 'Insert count blank columns (default 1). index is the 1-based '
      + 'column NUMBER (A=1, B=2, …) the new columns will occupy; existing '
      + 'columns shift right. Never asks.',
    inputSchema: {
      type: 'object',
      properties: {
        sheetName: { type: 'string' },
        index: { type: 'integer', minimum: 1 },
        count: { type: 'integer', minimum: 1 },
      },
      required: ['sheetName', 'index'],
    },
  },
  {
    name: 'delete_columns',
    description: 'Delete count columns (default 1) starting at the 1-based '
      + 'column NUMBER (A=1). Asks the user first when the columns hold any '
      + 'content. Undoable.',
    inputSchema: {
      type: 'object',
      properties: {
        sheetName: { type: 'string' },
        index: { type: 'integer', minimum: 1 },
        count: { type: 'integer', minimum: 1 },
      },
      required: ['sheetName', 'index'],
    },
  },
  {
    name: 'add_sheet',
    description: 'Create a new empty tab with this name. Fails if the name is taken.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'delete_sheet',
    description: 'Delete a whole tab. ALWAYS asks the user first. Undoable '
      + 'unless the sheet is too large to snapshot — the confirmation says so.',
    inputSchema: {
      type: 'object',
      properties: { sheetName: { type: 'string' } },
      required: ['sheetName'],
    },
  },
];

/**
 * Forward one tool call to the daemon and wait for the sidebar's answer.
 *
 * rejectUnauthorized:false is deliberate and scoped: the daemon's cert is
 * self-signed, the connection never leaves 127.0.0.1, and the alternative is
 * shipping cert pinning for a hop that exists inside one machine. The token is
 * what authenticates the request, not the TLS identity.
 *
 * No client-side timeout: the daemon owns the clock (a call the sidebar never
 * answers is failed there), and a second timer here could only disagree with it.
 */
function callDaemon(name, args) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ token: TOKEN, name, arguments: args || {} });
    const req = https.request({
      host: '127.0.0.1',
      port: PORT,
      path: '/bridge/call',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      rejectUnauthorized: false,
    }, (res) => {
      let raw = '';
      res.on('data', (d) => { raw += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve({ ok: false, error: 'daemon returned unparseable response' }); }
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: 'could not reach the local app: ' + err.message }));
    req.end(body);
  });
}

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

/**
 * Handle one JSON-RPC message; returns the response object, or null for
 * notifications. `call` is injectable so this layer is testable without a
 * daemon — main() supplies callDaemon and writes the response to stdout.
 */
async function handle(msg, call) {
  call = call || callDaemon;
  if (msg.method === 'initialize') {
    return { jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: (msg.params && msg.params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'sheets', version: '1.0.0' },
    } };
  }

  if (msg.method === 'tools/list') {
    return { jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } };
  }

  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params || {};
    const out = await call(name, args);
    // isError makes Claude treat it as a failed call it can react to, rather
    // than data. A user skipping a gated write arrives as ok:false too — the
    // message says so, and Claude is prompted to respect it as a decision.
    return { jsonrpc: '2.0', id: msg.id, result: {
      content: [{ type: 'text', text: JSON.stringify(out.ok ? out.result : { error: out.error }) }],
      isError: !out.ok,
    } };
  }

  if (msg.method === 'ping') {
    return { jsonrpc: '2.0', id: msg.id, result: {} };
  }

  // Notifications (no id) are consumed silently; unknown requests get an error.
  if (msg.id === undefined) return null;
  return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } };
}

/* istanbul ignore next -- wiring, exercised live rather than unit-tested */
function main() {
  let buf = '';
  process.stdin.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let msg;
      try { msg = JSON.parse(t); } catch { continue; }
      if (msg && typeof msg === 'object') {
        handle(msg).then((out) => { if (out) send(out); });
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

if (require.main === module) main();

module.exports = { handle, TOOLS, callDaemon };
