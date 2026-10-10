import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, readFile, readdir, symlink, mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Runtime } from '../local/runtime';
import { ConnectionStore } from '../local/store';
import { temporaryStore, mockServer, json, quotaFixture, keyA, keyB, deferred, usageFixture } from './fixtures';

test('独立原子持久存储、文件权限与多个实例冲突保护', async () => {
  const t = await temporaryStore();
  try {
    const a = await t.store.update('empty', s => { s.connections.push({ id: 'a', name: 'Alpha', baseUrl: 'https://alpha.example.test/v1', key: keyA }); s.activeId = 'a'; });
    if (process.platform !== 'win32') {
      assert.equal((await lstat(t.store.directory)).mode & 0o777, 0o700);
      assert.equal((await lstat(join(t.store.directory, 'connections.json'))).mode & 0o777, 0o600);
    }
    assert.ok((await readFile(join(t.store.directory, 'connections.json'), 'utf8')).includes(keyA));
    const second = new ConnectionStore(t.store.directory);
    assert.equal((await second.read()).connections[0].key, keyA);
    await assert.rejects(second.update('empty', s => { s.connections = []; }));
    assert.equal((await second.read()).revision, a.revision);
    const attempts = await Promise.allSettled([t.store.update(a.revision, s => { s.activeId = null; }), second.update(a.revision, s => { s.activeId = null; })]);
    assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
    assert.deepEqual((await readdir(t.store.directory)).sort(), ['connections.json']);
  } finally { await t.close(); }
});
test('拒绝凭证文件符号链接，避免访问未知文件', async () => {
  const t = await temporaryStore();
  try {
    await mkdir(t.store.directory);
    const target = join(t.directory, 'unknown'), link = join(t.store.directory, 'connections.json');
    const content = JSON.stringify({ revision: 'empty', activeId: null, connections: [] });
    for (const exists of [false, true]) {
      if (exists) await writeFile(target, content);
      await symlink(target, link, 'file');
      // Both dangling and valid-target links must be rejected before reading or replacing them.
      await assert.rejects(t.store.read(), /无法安全读取/);
      await assert.rejects(t.store.update('empty', s => { s.activeId = null; }), /无法安全读取/);
      assert.ok((await lstat(link)).isSymbolicLink());
      if (exists) assert.equal(await readFile(target, 'utf8'), content);
      await unlink(link);
    }
  } finally { await t.close(); }
});
test('不同 Key 数据隔离、模型及结果没有 Gateway key 或共享标识', async () => {
  const t = await temporaryStore();
  const server = await mockServer((req, res) => {
    const alpha = req.headers.authorization === `Bearer ${keyA}`;
    json(res, req.url?.endsWith('models') ? { object: 'list', data: [{ id: alpha ? 'alpha/model' : 'beta/model', account: 'private-account' }, { id: alpha ? keyA : keyB }] } :
      quotaFixture({ tokens: alpha ? 11 : 22 }));
  });
  try {
    const state = await t.store.update('empty', s => {
      s.connections = [{ id: 'a', name: 'Alpha', baseUrl: `${server.origin}/prefix/v1`, key: keyA },
        { id: 'b', name: 'Beta', baseUrl: `${server.origin}/prefix/v1`, key: keyB }]; s.activeId = 'a';
    });
    const runtime = new Runtime(t.store);
    await runtime.snapshot('quota'); const a = await runtime.snapshot('models');
    assert.equal(a.quota?.tokens.used, 11); assert.deepEqual(a.models, ['alpha/model']);
    await t.store.update(state.revision, s => { s.activeId = 'b'; });
    await runtime.snapshot('quota'); const b = await runtime.snapshot('models');
    assert.equal(b.quota?.tokens.used, 22); assert.deepEqual(b.models, ['beta/model']); assert.equal(b.connection?.name, 'Beta');
    assert.ok(!JSON.stringify([a, b]).includes(keyA)); assert.ok(!JSON.stringify([a, b]).includes(keyB));
    assert.ok(!JSON.stringify([a, b]).includes('private-account'));
  } finally { await server.close(); await t.close(); }
});
for (const action of ['select', 'remove'] as const) test(`${action} 清空全部旧缓存和迟到响应`, { timeout: 5000 }, async () => {
  const t = await temporaryStore(), usageEntered = deferred<void>(), cardsEntered = deferred<void>(), release = deferred<void>();
  let hold = false;
  const server = await mockServer(async (req, res) => {
    if (req.url?.endsWith('/models')) json(res, { object: 'list', data: [{ id: 'old/model' }] });
    else if (req.url?.endsWith('/limit')) json(res, quotaFixture({ tokens: req.headers.authorization === `Bearer ${keyA}` ? 11 : 22 }));
    else if (req.url?.endsWith('/cards')) {
      if (hold) { cardsEntered.resolve(); await release.promise; }
      json(res, { object: 'list', data: [{ provider: 'codex', name: 'Codex', windows: [{ name: 'weekly', used: 25 }] }] });
    } else {
      if (hold) { usageEntered.resolve(); await release.promise; }
      json(res, usageFixture());
    }
  });
  try {
    const state = await t.store.update('empty', s => {
      s.connections = [{ id: 'a', name: 'Alpha', baseUrl: `${server.origin}/v1`, key: keyA },
        { id: 'b', name: 'Beta', baseUrl: `${server.origin}/v1`, key: keyB }]; s.activeId = 'a';
    });
    const runtime = new Runtime(t.store);
    assert.deepEqual((await runtime.snapshot('models')).models, ['old/model']);
    const first = await runtime.snapshot('dashboard');
    assert.ok(first.quota && first.usage && first.upstreamCards?.length);
    hold = true; const response = runtime.snapshot('dashboard');
    await Promise.all([usageEntered.promise, cardsEntered.promise]);
    await t.store.update(state.revision, s => { if (action === 'select') s.activeId = 'b'; else { s.connections = s.connections.filter(c => c.id !== 'a'); s.activeId = null; } });
    release.resolve(); const retired = await response;
    for (const field of ['connection', 'quota', 'models', 'quotaReadAt', 'modelsReadAt', 'modelsError',
      'upstreamCards', 'upstreamReadAt', 'upstreamError', 'usage', 'usageReadAt', 'usageError'] as const) assert.equal(retired[field], null, field);
    assert.equal(retired.quotaError?.code, 'connection_changed'); assert.equal(retired.upstreamEnabled, false); assert.equal(retired.stale, false);
    const next = await runtime.snapshot('dashboard');
    assert.equal(next.connection?.name ?? null, action === 'select' ? 'Beta' : null);
    assert.equal(next.quota?.tokens.used ?? null, action === 'select' ? 22 : null);
    assert.equal(next.models, null);
  } finally { release.resolve(); await server.close(); await t.close(); }
});
test('失败保留同连接上次成功数据并明确过期；切换无成功历史的连接不保留旧数据', async () => {
  const t = await temporaryStore(); let status = 200;
  const server = await mockServer((_req, res) => json(res, quotaFixture(), status));
  try {
    const state = await t.store.update('empty', s => { s.connections = [
      { id: 'a', name: 'Alpha', baseUrl: `${server.origin}/v1`, key: keyA },
      { id: 'b', name: 'Beta', baseUrl: `${server.origin}/v1`, key: keyB }]; s.activeId = 'a'; });
    const runtime = new Runtime(t.store), success = await runtime.snapshot('quota');
    status = 401; const failed = await runtime.snapshot('quota');
    assert.equal(failed.stale, true); assert.equal(failed.quotaReadAt, success.quotaReadAt); assert.equal(failed.quotaError?.code, 'invalid_key'); assert.deepEqual(failed.quota, success.quota);
    await t.store.update(state.revision, s => { s.activeId = 'b'; }); const changed = await runtime.snapshot('quota');
    assert.equal(changed.quota, null); assert.equal(changed.quotaReadAt, null); assert.equal(changed.stale, false);
  } finally { await server.close(); await t.close(); }
});
test('独立模型读取失败不会污染看板快照，看板不重复读取模型', async () => {
  const t = await temporaryStore(); let modelReads = 0;
  const server = await mockServer((req, res) => {
    if (req.url?.endsWith('/models')) {
      modelReads++;
      json(res, { object: 'list', data: [{ id: 'synthetic/model' }] }, modelReads === 1 ? 200 : 404);
    } else json(res, req.url?.endsWith('/cards') ? { object: 'list', data: [] } : quotaFixture());
  });
  try {
    await t.store.update('empty', s => {
      s.connections = [{ id: 'a', name: 'Alpha', baseUrl: `${server.origin}/v1`, key: keyA }]; s.activeId = 'a';
    });
    const runtime = new Runtime(t.store);
    assert.deepEqual((await runtime.snapshot('models')).models, ['synthetic/model']);
    const failed = await runtime.snapshot('models');
    assert.equal(failed.modelsError?.code, 'unsupported'); assert.equal(failed.stale, true);
    const dashboard = await runtime.snapshot('dashboard');
    assert.equal(dashboard.quota?.tokens.used, 30); assert.equal(dashboard.stale, false);
    assert.equal(dashboard.models, null); assert.equal(dashboard.modelsReadAt, null); assert.equal(dashboard.modelsError, null);
    assert.equal(modelReads, 2);
  } finally { await server.close(); await t.close(); }
});
