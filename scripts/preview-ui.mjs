import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
// Synthetic UI preview only. No persistent connections or gateway requests.
const source = await readFile('generated/local-widget.ts', 'utf8');
const html = JSON.parse(source.slice(source.indexOf(' = ') + 3).trim().replace(/;$/, ''));
const snapshot = {
  revision: 'synthetic-preview', connection: { id: 'preview', name: '模拟连接 · 非真实数据', baseUrl: 'https://example.com/magpie-gateway/v1' },
  quota: { limited: true, period: 'week', start: '2026-10-05T00:00:00+08:00', reset: '2026-10-12T00:00:00+08:00',
    tokens: { used: 1240000000, limit: 2000000000, remaining: 760000000, uncapped: false },
    cost: { used: 2.15, limit: 5, remaining: 2.85, uncapped: false }, spent: false, cacheReads: false, unpriced: null },
  models: null,
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
  'token-only': { ...snapshot, quota: { ...snapshot.quota, cost: { used: null, limit: null, remaining: null, uncapped: true } } },
  'cost-only': { ...snapshot, quota: { ...snapshot.quota, tokens: { used: null, limit: null, remaining: null, uncapped: true } } },
  unlimited: { ...snapshot, quota: { limited: false, period: null, start: null, reset: null,
    tokens: { used: null, limit: null, remaining: null, uncapped: true }, cost: { used: null, limit: null, remaining: null, uncapped: true },
    spent: null, cacheReads: null, unpriced: null } },
};
const wrapper = data => `<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Magpie synthetic preview</title><style>body{margin:0}iframe{width:100%;height:100vh;border:0}</style><iframe src="/widget" title="合成数据看板"></iframe><script>
const data=${JSON.stringify(data)};
window.addEventListener('message',e=>{
 if(e.origin!==location.origin||e.source!==document.querySelector('iframe').contentWindow)return;
 const m=e.data;let result;
 if(m.method==='ui/initialize')result={protocolVersion:'2026-01-26',hostInfo:{name:'Synthetic browser preview',version:'1'},hostCapabilities:{serverTools:{}},hostContext:{displayMode:'fullscreen',availableDisplayModes:['fullscreen']}};
 if(m.method==='tools/call')result=m.params.name==='get_connection_state'?{content:[],_meta:{'magpie/revision':data.revision}}:{content:[],structuredContent:data};
 if(result)e.source.postMessage({jsonrpc:'2.0',id:m.id,result},location.origin);
});
</script></html>`;
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const scenario = new URL(req.url, 'http://localhost').searchParams.get('scenario');
  res.end(req.url === '/widget' ? html : wrapper(Object.hasOwn(scenarios, scenario ?? '') ? scenarios[scenario] : snapshot));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
console.log(`Synthetic preview: http://127.0.0.1:${server.address().port}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
