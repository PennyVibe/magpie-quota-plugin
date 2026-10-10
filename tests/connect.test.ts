import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { ConnectServer } from '../local/connect-server';
import { Runtime } from '../local/runtime';
import { localConnectHtml } from '../generated/local-connect';
import { temporaryStore, mockServer, json, quotaFixture, keyA, keyB, deferred } from './fixtures';

async function browser(connector: ConnectServer) {
  const url = connector.issueConnectionUrl(), entry = await fetch(url), cookie = entry.headers.get('set-cookie')!.split(';')[0];
  assert.equal(entry.status, 200); assert.match(cookie, /^magpie_/); assert.match(entry.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
  assert.match(entry.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  const get = async () => {
    const r = await fetch(`${connector.origin}/api/connections`, { headers: { Cookie: cookie } });
    return { status: r.status, body: await r.json() };
  };
  const post = async (body: unknown, csrf: string, origin = connector.origin) => {
    const r = await fetch(`${connector.origin}/api/connections`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { url, cookie, get, post };
}
test('真实连接 HTTP 边界：一次性入口、Host/Origin/CSRF、只验证 limit、添加切换移除', async () => {
  const t = await temporaryStore(), paths: string[] = [];
  const remote = await mockServer((req, res) => { paths.push(req.url!); json(res, quotaFixture()); });
  const connector = await new ConnectServer(t.store, new Runtime(t.store), localConnectHtml).start();
  try {
    const b = await browser(connector); assert.equal((await fetch(b.url)).status, 401);
    assert.equal((await fetch(`${connector.origin}/api/connections`)).status, 401);
    const rebound = await new Promise<number | undefined>(resolve => {
      const req = request(`${connector.origin}/api/connections`, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
      req.end();
    });
    assert.equal(rebound, 403);
    let current = (await b.get()).body;
    const addA = { action: 'add', name: 'Alpha', address: `${remote.origin}/deploy/v1`, key: keyA };
    assert.equal((await b.post(addA, 'wrong')).status, 403);
    assert.equal((await b.post(addA, current.csrf, 'https://evil.example')).status, 403);
    assert.equal((await b.post(addA, current.csrf)).status, 200);
    current = (await b.get()).body; const a = current.connections[0].id;
    assert.equal(current.connections[0].baseUrl, `${remote.origin}/deploy/v1`);
    assert.ok(!JSON.stringify(current).includes(keyA));
    assert.equal((await b.post({ ...addA, name: 'Beta', key: keyB }, current.csrf)).status, 200);
    current = (await b.get()).body; const beta = current.connections.find((c: { name: string }) => c.name === 'Beta').id;
    assert.equal(current.activeId, beta);
    assert.equal((await b.post({ action: 'select', id: a }, current.csrf)).status, 200);
    current = (await b.get()).body; assert.equal(current.activeId, a);
    assert.equal((await b.post({ action: 'remove', id: a }, current.csrf)).status, 200);
    current = (await b.get()).body; assert.equal(current.activeId, null); assert.equal(current.connections.length, 1);
    assert.deepEqual(paths, ['/deploy/v1/magpie/limit', '/deploy/v1/magpie/limit']);
    assert.ok(!JSON.stringify(current).includes(keyB)); assert.ok(!JSON.stringify(current).includes(keyA));
  } finally { await connector.close(); await remote.close(); await t.close(); }
});
test('服务器接口不支持、无归属或 Key 回显名称输入不会保存连接', async () => {
  const t = await temporaryStore(); let response: unknown = { limited: false, key: '' }, status = 200;
  const remote = await mockServer((_req, res) => json(res, response, status));
  const connector = await new ConnectServer(t.store, new Runtime(t.store), localConnectHtml).start();
  try {
    const b = await browser(connector), current = (await b.get()).body;
    for (const scenario of ['unattributed', 'unsupported', 'secret-name']) {
      response = quotaFixture(); status = scenario === 'unsupported' ? 404 : 200;
      if (scenario === 'unattributed') response = { limited: false, key: '' };
      const r = await b.post({ action: 'add', name: scenario === 'secret-name' ? keyA : 'Alpha', address: remote.origin, key: keyA }, current.csrf);
      assert.equal(r.status, 400); assert.ok(!JSON.stringify(r.body).includes(keyA));
      assert.equal((await t.store.read()).connections.length, 0);
    }
  } finally { await connector.close(); await remote.close(); await t.close(); }
});
test('新浏览器授权撤销等待中旧页面的保存操作', async () => {
  const t = await temporaryStore(), entered = deferred<void>(), release = deferred<void>();
  const remote = await mockServer(async (_req, res) => { entered.resolve(); await release.promise; json(res, quotaFixture()); });
  const connector = await new ConnectServer(t.store, new Runtime(t.store), localConnectHtml).start();
  try {
    const b = await browser(connector), current = (await b.get()).body;
    const pending = b.post({ action: 'add', name: 'Alpha', address: remote.origin, key: keyA }, current.csrf);
    await entered.promise; await browser(connector); release.resolve();
    assert.equal((await pending).status, 400); assert.equal((await t.store.read()).connections.length, 0);
  } finally { release.resolve(); await connector.close(); await remote.close(); await t.close(); }
});
