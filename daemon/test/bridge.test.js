/**
 * The MCP bridge's protocol layer.
 *
 * The bridge is the piece the Claude Code CLI talks to directly, and the MCP
 * handshake is all-or-nothing: get initialize or tools/list slightly wrong and
 * the server is silently absent from the init line — no error, just a model
 * with no tools. These pin the exact frames.
 *
 * The daemon hop is injected (`call`), so nothing here needs a network.
 */

const test = require('node:test');
const assert = require('node:assert');
const { handle, TOOLS } = require('../src/mcp-bridge');

const ok = (result) => async () => ({ ok: true, result });
const fail = (error) => async () => ({ ok: false, error });

test('initialize echoes the client protocol version and offers tools', async () => {
  const res = await handle({ jsonrpc: '2.0', id: 0, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {} } });
  assert.strictEqual(res.id, 0);
  assert.strictEqual(res.result.protocolVersion, '2025-06-18');
  assert.deepStrictEqual(res.result.capabilities, { tools: {} });
  assert.strictEqual(res.result.serverInfo.name, 'sheets');
});

test('the tool vocabulary maps 1:1 onto the op protocol', async () => {
  const res = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const names = res.result.tools.map((t) => t.name);
  assert.deepStrictEqual(names,
    ['read_range', 'set_values', 'set_formulas', 'set_formats', 'clear_range',
     'insert_rows', 'delete_rows', 'insert_columns', 'delete_columns',
     'add_sheet', 'delete_sheet']);
  for (const t of res.result.tools) {
    assert.ok(t.description.length > 20, t.name + ' explains itself to the model');
    assert.strictEqual(t.inputSchema.type, 'object', t.name + ' has a schema');
  }
});

test('every write tool requires its target and payload', async () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
  assert.deepStrictEqual(byName.set_values.inputSchema.required, ['sheetName', 'a1', 'values']);
  assert.deepStrictEqual(byName.set_formulas.inputSchema.required, ['sheetName', 'a1', 'formulas']);
  assert.deepStrictEqual(byName.set_formats.inputSchema.required, ['sheetName', 'a1', 'format']);
  assert.deepStrictEqual(byName.clear_range.inputSchema.required, ['sheetName', 'a1']);
  assert.deepStrictEqual(byName.insert_rows.inputSchema.required, ['sheetName', 'index']);
  assert.deepStrictEqual(byName.delete_rows.inputSchema.required, ['sheetName', 'index']);
  assert.deepStrictEqual(byName.insert_columns.inputSchema.required, ['sheetName', 'index']);
  assert.deepStrictEqual(byName.delete_columns.inputSchema.required, ['sheetName', 'index']);
  assert.deepStrictEqual(byName.add_sheet.inputSchema.required, ['name']);
  assert.deepStrictEqual(byName.delete_sheet.inputSchema.required, ['sheetName']);
  assert.ok(!byName.read_range.inputSchema.required, 'read_range args are all optional');
});

test('a successful call returns the result as JSON text', async () => {
  const res = await handle(
    { jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'set_values', arguments: { a1: 'B2' } } },
    ok({ applied: 'Sheet1!B2', restorable: true }));
  assert.strictEqual(res.result.isError, false);
  assert.deepStrictEqual(JSON.parse(res.result.content[0].text),
    { applied: 'Sheet1!B2', restorable: true });
});

test('a failed or skipped call surfaces as a tool error Claude can react to', async () => {
  const res = await handle(
    { jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'clear_range', arguments: {} } },
    fail('The user chose not to apply this change.'));
  assert.strictEqual(res.result.isError, true);
  assert.match(res.result.content[0].text, /user chose not to apply/);
});

test('notifications get no response; unknown methods get a JSON-RPC error', async () => {
  assert.strictEqual(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const res = await handle({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
  assert.strictEqual(res.error.code, -32601);
});

test('ping pongs — the CLI health-checks the server with it', async () => {
  const res = await handle({ jsonrpc: '2.0', id: 5, method: 'ping' });
  assert.deepStrictEqual(res.result, {});
});
