import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
const entry = resolve(process.argv[2] ?? 'dist/local-plugin/plugins/magpie-quota-local/server/launch.cjs');
const directory = await mkdtemp(join(tmpdir(), 'magpie-stdio-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string'));
env.MAGPIE_QUOTA_DATA_DIR = join(directory, 'isolated-empty-store');
const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: dirname(entry), stderr: 'pipe', env });
let stderr = '';
transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
const client = new Client({ name: 'magpie-package-verification', version: '1.0.0' }, { capabilities: {} });
let remote;
try {
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.name, 'Magpie 额度看板'); assert.equal(client.getServerVersion()?.version, '0.1.1');
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(t => t.name), ['open_quota_dashboard', 'get_my_gateway_quota', 'list_available_models', 'get_upstream_quota_cards', 'manage_connections', 'get_connection_state']);
  assert.deepEqual(tools[0]._meta?.['openai/ui']?.entrypoints, [{ type: 'global' }]);
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, true); assert.equal(tool.inputSchema.additionalProperties, false);
    if (tool.name === 'open_quota_dashboard') {
      assert.deepEqual(Object.keys(tool.inputSchema.properties), ['period']);
      assert.deepEqual(tool.inputSchema.properties.period.enum, ['today', '7d', '30d', 'all']);
    } else assert.deepEqual(tool.inputSchema.properties, {});
  }
  for (const tool of tools.slice(4)) assert.deepEqual(tool._meta?.ui?.visibility, ['app']);
  for (const name of tools.slice(0, 3).map(t => t.name)) {
    const result = await client.callTool({ name, arguments: {} });
    assert.equal(result.structuredContent.connection, null); assert.equal(result.structuredContent.quotaError.code, 'not_connected');
    assert.ok(!JSON.stringify(result.content).includes('bootstrap=')); assert.ok(!JSON.stringify(result.structuredContent).includes('bootstrap='));
    assert.match(result._meta['magpie/connectUrl'], /^http:\/\/127\.0\.0\.1:\d+\/connect\?bootstrap=/);
  }
  for (const args of [{ url: 'https://evil.example' }, { key: 'synthetic-key' }, { path: '/v1/responses' }])
    assert.equal((await client.callTool({ name: 'get_my_gateway_quota', arguments: args })).isError, true);
  assert.equal((await client.callTool({ name: 'open_quota_dashboard', arguments: { period: 'today&via=direct' } })).isError, true);
  assert.equal((await client.callTool({ name: 'reset_quota', arguments: {} })).isError, true);
  const result = await client.readResource({ uri: 'ui://magpie/quota-dashboard' });
  assert.equal(result.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.match(result.contents[0].text, /Magpie 额度看板/); assert.deepEqual(result.contents[0]._meta['openai/ui'].availableDisplayModes, ['fullscreen']);
  // Exercise the packaged browser/backend path with a synthetic key only.
  const synthetic = 'synthetic-package-gateway-key';
  const paths = [];
  remote = createServer((req, res) => {
    paths.push(req.url);
    assert.equal(req.method, 'GET'); assert.equal(req.headers.authorization, `Bearer ${synthetic}`);
    res.setHeader('Content-Type', 'application/json');
    const query = new URL(req.url, 'http://localhost');
    if (query.pathname.endsWith('/magpie/usage')) {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: { message: 'this gateway key is held to a budget, models or accounts, so it is told its own calls alone: GET /v1/magpie/usage/requests' } }));
      return;
    }
    if (query.pathname.endsWith('/magpie/usage/requests')) {
      assert.deepEqual([...query.searchParams.keys()], ['period', 'via', 'limit', 'offset']);
      assert.equal(query.searchParams.get('via'), 'through');
      assert.equal(query.searchParams.get('limit'), '1'); assert.equal(query.searchParams.get('offset'), '0');
      const totals = { calls: 2, input: 2000, output: 300, cache_read: 800, cache_write: 100, cost: .125, unpriced: 0 };
      res.end(JSON.stringify({ ...totals, period: query.searchParams.get('period'), offset: 0, total: 2,
        rows: [{ account: 'synthetic-private', error: synthetic }], callerKeys: [{ id: 'private-key-id' }],
        by: { model: [{ id: 'synthetic/model', ...totals }] } }));
      return;
    }
    res.end(JSON.stringify(req.url.endsWith('/models') ? { object: 'list', data: [{ id: 'synthetic/model' }, { id: synthetic }] } :
      req.url.endsWith('/cards') ? { object: 'list', data: [{ provider: 'codex', name: 'Codex', kind: 'subscription',
        user: 'synthetic-private@example.test', windows: [{ name: '5h', used: 25 }], error: synthetic }] } :
        { limited: false, key: 'Synthetic package user' }));
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${remote.address().port}/deployment/v1`;
  const initial = await client.callTool({ name: 'open_quota_dashboard', arguments: {} });
  const bootstrap = await fetch(initial._meta['magpie/connectUrl']);
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  const origin = new URL(initial._meta['magpie/connectUrl']).origin;
  const connectionState = await (await fetch(`${origin}/api/connections`, { headers: { Cookie: cookie } })).json();
  const saved = await fetch(`${origin}/api/connections`, {
    method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': connectionState.csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'add', name: 'Synthetic package connection', address, key: synthetic }),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(paths, ['/deployment/v1/magpie/limit'], 'Connection validation must not read models or shared quotas');
  const connected = await client.callTool({ name: 'open_quota_dashboard', arguments: {} });
  assert.equal(connected.structuredContent.quota.limited, false);
  assert.equal(connected.structuredContent.models, null);
  assert.equal(connected.structuredContent.usage.totals.tokens, 3200);
  assert.equal(connected.structuredContent.usage.models[0].calls, 2);
  assert.equal(connected.structuredContent.usage.scope, 'current-key');
  assert.ok(!JSON.stringify(connected.structuredContent).includes('private-key-id'));
  assert.ok(!JSON.stringify(connected.structuredContent).includes('synthetic-private'));
  for (const period of ['7d', '30d', 'all']) {
    const ranged = await client.callTool({ name: 'open_quota_dashboard', arguments: { period } });
    assert.equal(ranged.structuredContent.usage.period, period);
    assert.equal(ranged.structuredContent.usage.totals.tokens, 3200);
  }
  assert.ok(!paths.some(path => path.endsWith('/models')), 'Dashboard must not read the hidden model list');
  const models = await client.callTool({ name: 'list_available_models', arguments: {} });
  assert.deepEqual(models.structuredContent.models, ['synthetic/model']);
  assert.equal(connected.structuredContent.connection.baseUrl, address);
  assert.ok(!JSON.stringify(connected).includes(synthetic));
  assert.ok(!JSON.stringify(connected.content).includes('bootstrap='));
  assert.equal(connected.structuredContent.upstreamEnabled, true);
  assert.equal(connected.structuredContent.upstreamCards[0].windows[0].remainingPercent, 75);
  assert.ok(paths.some(path => path.endsWith('/cards')));
  const shared = await client.callTool({ name: 'get_upstream_quota_cards', arguments: {} });
  assert.equal(shared.structuredContent.upstreamCards[0].windows[0].remainingPercent, 75);
  assert.ok(!JSON.stringify(shared).includes(synthetic));
  assert.ok(!JSON.stringify(shared).includes('synthetic-private'));
  assert.equal(stderr, '');
  console.log(JSON.stringify({ ok: true, entry, version: '0.1.1', tools: tools.length, globalFullscreen: true,
    noCredentials: true, syntheticBrowserConnection: true, prefixAndKeyRoundtrip: true, keyExcludedFromProtocol: true, sharedQuotaDefault: true,
    personalUsageRanges: true, usageMetadataExcluded: true, closedArguments: true, hostMetadataIsolated: true, stderrBytes: 0 }, null, 2));
} finally {
  await client.close();
  if (remote) { remote.closeAllConnections(); await new Promise(resolve => remote.close(resolve)); }
  await rm(directory, { recursive: true, force: true });
}
