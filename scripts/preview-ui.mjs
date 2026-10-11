import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
// Synthetic UI preview only. No persistent connections or gateway requests.
const source = await readFile('generated/local-widget.ts', 'utf8');
const html = JSON.parse(source.slice(source.indexOf(' = ') + 3).trim().replace(/;$/, ''));
const connectSource = await readFile('generated/local-connect.ts', 'utf8');
const connectHtml = JSON.parse(connectSource.slice(connectSource.indexOf(' = ') + 3).trim().replace(/;$/, ''));
const snapshot = {
  revision: 'synthetic-preview', connection: { id: 'preview', name: '模拟连接 · 非真实数据', baseUrl: 'https://example.com/magpie-gateway/v1' },
  quota: { limited: true, period: 'week', days: null, start: '2026-10-05T00:00:00+08:00', reset: '2026-10-12T00:00:00+08:00',
    tokens: { used: 1240000000, limit: 2000000000, remaining: 760000000, uncapped: false },
    cost: { used: 2.15, limit: 5, remaining: 2.85, uncapped: false }, spent: false, cacheReads: false, unpriced: null },
  models: null,
  usage: { period: 'today', scope: 'current-key', source: 'through',
    totals: { calls: 310, input: 3600000, output: 1210000, cacheRead: 3200000, cacheWrite: 800000, tokens: 8810000, cost: 24.736694, unpriced: 2 },
    models: [
      { id: 'gpt-6.1-sol', calls: 162, input: 2100000, output: 620000, cacheRead: 1700000, cacheWrite: 390000, tokens: 4810000, cost: 14.215694, unpriced: 0 },
      { id: 'claude-opus-4-6', calls: 78, input: 900000, output: 410000, cacheRead: 1100000, cacheWrite: 310000, tokens: 2720000, cost: 8.437, unpriced: 0 },
      { id: 'gpt-6-astra', calls: 46, input: 430000, output: 150000, cacheRead: 310000, cacheWrite: 85000, tokens: 975000, cost: 1.884, unpriced: 0 },
      { id: 'gemini-3.1-pro-preview', calls: 24, input: 170000, output: 30000, cacheRead: 90000, cacheWrite: 15000, tokens: 305000, cost: .2, unpriced: 2 },
    ] },
  usageReadAt: '2026-10-10T21:00:00+08:00', usageError: null,
  quotaReadAt: '2026-10-10T18:00:00+08:00', modelsReadAt: null, quotaError: null, modelsError: null, stale: false,
  upstreamEnabled: true, upstreamReadAt: '2026-10-10T18:00:00+08:00', upstreamError: null,
  upstreamCards: [{ provider: 'codex', name: 'Codex · 模拟共享供应商', kind: 'subscription', cardNumber: 1, plan: 'Pro · 合成示例',
    readAt: '2026-10-10T17:45:00+08:00', asOf: null, balance: null, unavailable: false,
    windows: [{ name: '5h', usedPercent: 23, remainingPercent: 77, unlimited: false, reset: '2026-10-10T23:00:00+08:00',
      resetSeconds: null, amount: null, limit: null, unit: null },
    { name: 'weekly', usedPercent: 64, remainingPercent: 36, unlimited: false, reset: '2026-10-12T00:00:00+08:00',
      resetSeconds: null, amount: null, limit: null, unit: null }] }],
};
const scenarios = { both: snapshot,
  'days-cycle': { ...snapshot, quota: { ...snapshot.quota,
    period: 'days', days: 10, start: '2026-10-10T23:40:00+08:00', reset: '2026-10-20T23:40:00+08:00',
    tokens: { used: 6400000, limit: null, remaining: null, uncapped: true },
    cost: { used: 38.451569, limit: 800, remaining: 761.548431, uncapped: false } } },
  'usage-unsupported': { ...snapshot, usage: null, usageError: { code: 'unsupported', message: '此服务器版本不支持用量读取接口。' } },
  'usage-scope': { ...snapshot, usage: null, usageError: { code: 'usage_scope_unknown', message: '未受限 Key 暂不支持个人用量统计。' } },
  'usage-empty': { ...snapshot, usage: { ...snapshot.usage, totals: { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0, unpriced: 0 }, models: [] } },
  'usage-stale': { ...snapshot, usageError: { code: 'timeout', message: '读取超时，请重试。' }, stale: true },
  'usage-unknown': { ...snapshot, usage: { ...snapshot.usage,
    totals: { ...snapshot.usage.totals, tokens: null, cost: null },
    models: snapshot.usage.models.map(model => ({ ...model, tokens: null, cost: null })) } },
  'usage-few-models': { ...snapshot,
    quota: { ...snapshot.quota, tokens: { ...snapshot.quota.tokens, limit: null, remaining: null, uncapped: true } },
    upstreamCards: [{ ...snapshot.upstreamCards[0], balance: '24000.25 credits', windows: [snapshot.upstreamCards[0].windows[1]] }],
    usage: { ...snapshot.usage,
      totals: Object.fromEntries(Object.entries(snapshot.usage.totals).map(([field, value]) => [field, value - snapshot.usage.models.at(-1)[field]])),
      models: snapshot.usage.models.slice(0, 3) } },
  'usage-many-models': { ...snapshot, usage: { ...snapshot.usage,
    totals: Object.fromEntries(Object.entries(snapshot.usage.totals).map(([field, value]) => [field, value * 2])),
    models: snapshot.usage.models.flatMap(model => [model, { ...model, id: `${model.id}-synthetic-extra` }]) } },
  mixed: { ...snapshot, quota: { ...snapshot.quota,
    tokens: { used: 2560000, limit: null, remaining: null, uncapped: true },
    cost: { used: 8.525694, limit: 800, remaining: 791.474306, uncapped: false } } },
  'large-cost': { ...snapshot, quota: { ...snapshot.quota,
    cost: { used: 1680.123456, limit: 2000, remaining: 319.876544, uncapped: false } } },
  'long-values': { ...snapshot, connection: { ...snapshot.connection, name: '模拟连接 · 长名称与长金额的响应式检查' },
    quota: { ...snapshot.quota, cost: { used: 1234567890123.1235, limit: 2000000000000, remaining: 765432109876.8765, uncapped: false } },
    usage: { ...snapshot.usage, totals: { ...snapshot.usage.totals, cost: 1234567890123.1235 },
      models: snapshot.usage.models.map((model, index) => index === 0 ? { ...model,
        id: `synthetic/${'long-model-name-'.repeat(8)}preview`, cost: 1234567890100.1235 } : model) } },
  'token-only': { ...snapshot, quota: { ...snapshot.quota, cost: { used: null, limit: null, remaining: null, uncapped: true } } },
  'cost-only': { ...snapshot, quota: { ...snapshot.quota, tokens: { used: null, limit: null, remaining: null, uncapped: true } } },
  unlimited: { ...snapshot, quota: { limited: false, period: null, days: null, start: null, reset: null,
    tokens: { used: null, limit: null, remaining: null, uncapped: true }, cost: { used: null, limit: null, remaining: null, uncapped: true },
    spent: null, cacheReads: null, unpriced: null } },
};
const wrapper = data => `<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Magpie synthetic preview</title><style>body{margin:0}iframe{display:block;width:100%;height:100vh;border:0}</style><iframe src="/widget" title="合成数据看板"></iframe><script>
const data=${JSON.stringify(data)};
window.addEventListener('message',e=>{
 if(e.origin!==location.origin||e.source!==document.querySelector('iframe').contentWindow)return;
 const m=e.data;let result;
 if(m.method==='ui/initialize')result={protocolVersion:'2026-01-26',hostInfo:{name:'Synthetic browser preview',version:'1'},hostCapabilities:{serverTools:{}},hostContext:{displayMode:'fullscreen',availableDisplayModes:['fullscreen']}};
 if(m.method==='tools/call')result=m.params.name==='get_connection_state'?{content:[],_meta:{'magpie/revision':data.revision}}:{content:[],structuredContent:{...data,usage:data.usage?{...data.usage,period:m.params.arguments?.period??'today'}:null}};
 if(result)e.source.postMessage({jsonrpc:'2.0',id:m.id,result},location.origin);
});
</script></html>`;
const server = createServer((req, res) => {
  if (req.url === '/api/connections') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // 视觉预览只返回合成连接；表单不会保存凭证或访问网关。
    if (req.method !== 'GET') { res.statusCode = 400; res.end(JSON.stringify({ error: '这是合成数据预览，不保存连接。请从实际插件管理连接。' })); return; }
    res.end(JSON.stringify({ csrf: 'synthetic-preview', activeId: 'preview', connections: [snapshot.connection] })); return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url === '/connect') { res.end(connectHtml); return; }
  const scenario = new URL(req.url, 'http://localhost').searchParams.get('scenario');
  res.end(req.url === '/widget' ? html : wrapper(Object.hasOwn(scenarios, scenario ?? '') ? scenarios[scenario] : snapshot));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
console.log(`Synthetic preview: http://127.0.0.1:${server.address().port}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
