import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUpstreamCards } from '../lib/gateway';
import { Runtime } from '../local/runtime';
import { ConnectServer } from '../local/connect-server';
import { localConnectHtml } from '../generated/local-connect';
import { renderSnapshot } from '../widget/view';
import { deferred, json, keyA, keyB, mockServer, quotaFixture, temporaryStore } from './fixtures';
const cards = { object: 'list', data: [{ provider: 'codex', name: 'Codex', kind: 'subscription', plan: 'Pro',
  user: 'shared-private@example.test', readAt: '2026-10-10T08:00:00Z', windows: [
    { name: '5h', used: 0, resetsAt: '2026-10-10T20:00:00+08:00' },
    { name: 'weekly', used: 125, resetSecs: 60 }, { name: 'missing' }, { name: 'unlimited', used: 0, unlimited: true },
  ] }] };
test('已确认 cards 百分比/超额/缺失/无限额语义，排除账号标识及原始错误', () => {
  const data = parseUpstreamCards({ ...cards, data: [{ ...cards.data[0], error: `private error ${keyA}`, accountKey: 'provider-secret' }] }, keyA);
  assert.equal(data[0].windows[0].usedPercent, 0); assert.equal(data[0].windows[0].remainingPercent, 100);
  assert.equal(data[0].windows[1].remainingPercent, 0); assert.equal(data[0].windows[1].reset, null); assert.equal(data[0].windows[1].resetSeconds, 60);
  assert.equal(data[0].windows[2].usedPercent, null); assert.equal(data[0].windows[2].remainingPercent, null);
  assert.equal(data[0].windows[3].remainingPercent, null); assert.equal(data[0].unavailable, true);
  assert.ok(!JSON.stringify(data).includes('shared-private')); assert.ok(!JSON.stringify(data).includes(keyA));
  assert.ok(!JSON.stringify(data).includes('provider-secret'));
});
test('共享卡片不猜版本字段，负数/非有限百分比未知，真实空缓存保留为空', () => {
  assert.throws(() => parseUpstreamCards({ object: 'list', data: [{ ...cards.data[0], windows: undefined }] }, keyA));
  assert.throws(() => parseUpstreamCards({ cards: [] }, keyA));
  assert.deepEqual(parseUpstreamCards({ object: 'list', data: [] }, keyA), []);
  const data = parseUpstreamCards({ object: 'list', data: [{ ...cards.data[0], windows: [{ name: 'invalid', used: Infinity }, { name: 'invalid', used: -1 }] }] }, keyA);
  assert.equal(data[0].windows[0].usedPercent, null); assert.equal(data[0].windows[1].remainingPercent, null);
});
test('未开启共享区域时全部工具路径都不读 cards；连接开关可开启并关闭', async () => {
  const t = await temporaryStore(), paths: string[] = [];
  const remote = await mockServer((req, res) => {
    paths.push(req.url!); json(res, req.url?.endsWith('cards') ? cards : req.url?.endsWith('models') ? { object: 'list', data: [] } : quotaFixture());
  });
  const runtime = new Runtime(t.store), connector = await new ConnectServer(t.store, runtime, localConnectHtml).start();
  try {
    const state = await t.store.update('empty', s => { s.connections = [{ id: 'a', name: 'Alpha', baseUrl: `${remote.origin}/v1`, key: keyA }]; s.activeId = 'a'; });
    await runtime.snapshot('dashboard'); assert.equal((await runtime.snapshot('cards')).upstreamError?.code, 'upstream_disabled');
    assert.ok(!paths.some(path => path.endsWith('cards')));
    const entry = await fetch(connector.issueConnectionUrl()), cookie = entry.headers.get('set-cookie')!.split(';')[0];
    const toggle = async (enabled: boolean) => {
      const page = await (await fetch(`${connector.origin}/api/connections`, { headers: { Cookie: cookie } })).json();
      const response = await fetch(`${connector.origin}/api/connections`, { method: 'POST', headers: { Cookie: cookie, Origin: connector.origin, 'X-CSRF-Token': page.csrf, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'upstream', id: 'a', enabled }) });
      assert.equal(response.status, 200);
    };
    await toggle(true); const active = await runtime.snapshot('cards'); assert.equal(active.upstreamCards?.[0].name, 'Codex');
    assert.notEqual(active.revision, state.revision);
    await toggle(false); const disabled = await runtime.snapshot('dashboard');
    assert.equal(disabled.upstreamCards, null); assert.equal(disabled.upstreamReadAt, null); assert.equal(disabled.upstreamEnabled, false);
    assert.equal(paths.filter(path => path.endsWith('cards')).length, 1);
    assert.ok(!paths.some(path => path.endsWith('models')));
  } finally { await connector.close(); await remote.close(); await t.close(); }
});
test('cards 接口版本缺失保留个人额度，不 fallback 到其他共享接口', async () => {
  const t = await temporaryStore(), paths: string[] = [];
  const remote = await mockServer((req, res) => {
    paths.push(req.url!);
    json(res, req.url?.endsWith('models') ? { object: 'list', data: [] } : quotaFixture(), req.url?.endsWith('cards') ? 404 : 200);
  });
  try {
    await t.store.update('empty', s => { s.connections = [{ id: 'a', name: 'Alpha', baseUrl: `${remote.origin}/v1`, key: keyA, upstreamEnabled: true }]; s.activeId = 'a'; });
    const result = await new Runtime(t.store).snapshot('dashboard');
    assert.equal(result.quota?.tokens.used, 30); assert.equal(result.upstreamError?.code, 'unsupported'); assert.equal(result.upstreamCards ?? null, null);
    assert.deepEqual(paths.sort(), ['/v1/magpie/limit', '/v1/magpie/quotas/cards']);
  } finally { await remote.close(); await t.close(); }
});
test('共享卡片失败保留旧时间和 stale；关闭开关后迟到数据不能恢复', async () => {
  const t = await temporaryStore(); let failure = false, hold = false;
  const entered = deferred<void>(), release = deferred<void>();
  const remote = await mockServer(async (_req, res) => { if (hold) { entered.resolve(); await release.promise; } json(res, cards, failure ? 403 : 200); });
  try {
    const state = await t.store.update('empty', s => { s.connections = [{ id: 'a', name: 'Alpha', baseUrl: `${remote.origin}/v1`, key: keyA, upstreamEnabled: true }]; s.activeId = 'a'; });
    const runtime = new Runtime(t.store), success = await runtime.snapshot('cards');
    failure = true; const failed = await runtime.snapshot('cards');
    assert.equal(failed.upstreamReadAt, success.upstreamReadAt); assert.equal(failed.stale, true); assert.equal(failed.upstreamError?.code, 'forbidden');
    hold = true; failure = false; const pending = runtime.snapshot('cards'); await entered.promise;
    await t.store.update(state.revision, s => { s.connections[0].upstreamEnabled = false; s.connections[0].key = keyB; });
    release.resolve(); const retired = await pending;
    assert.equal(retired.upstreamCards, null); assert.equal(retired.upstreamEnabled, false);
  } finally { release.resolve(); await remote.close(); await t.close(); }
});
test('共享区域与个人额度标签分离、缓存年龄及缺失值可辨认', () => {
  const html = renderSnapshot({ revision: 'a', connection: { id: 'a', name: 'Alpha', baseUrl: 'https://example.test/v1' },
    quota: null, models: [], quotaReadAt: null, modelsReadAt: null, quotaError: null, modelsError: null, stale: false,
    upstreamEnabled: true, upstreamCards: parseUpstreamCards(cards, keyA), upstreamReadAt: '2026-10-10T10:00:00Z' });
  assert.match(html, /服务器缓存 · 非个人用量/); assert.match(html, /剩余 100\.0%/); assert.match(html, /未提供/);
  assert.match(html, /供应商数据读取时间/); assert.ok(!html.includes('shared-private'));
});
