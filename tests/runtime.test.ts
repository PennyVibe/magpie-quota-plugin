import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, readFile, readdir, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Runtime } from '../local/runtime';
import { ConnectionStore } from '../local/store';
import { temporaryStore, mockServer, json, quotaFixture, keyA, keyB, deferred } from './fixtures';

test('独立原子持久存储、文件权限与多个实例冲突保护', async () => {
  const t = await temporaryStore();
  try {
    const a = await t.store.update('empty', s => { s.connections.push({ id: 'a', name: 'Alpha', baseUrl: 'https://alpha.example.test/v1', key: keyA }); s.activeId = 'a'; });
    assert.equal((await lstat(t.store.directory)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(t.store.directory, 'connections.json'))).mode & 0o777, 0o600);
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
    await mkdir(t.store.directory); await symlink(join(t.directory, 'unknown'), join(t.store.directory, 'connections.json'));
    // A dangling symlink must not be treated as an empty store and overwritten.
    await assert.rejects(t.store.read());
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
    const runtime = new Runtime(t.store), a = await runtime.snapshot();
    assert.equal(a.quota?.tokens.used, 11); assert.deepEqual(a.models, ['alpha/model']);
    await t.store.update(state.revision, s => { s.activeId = 'b'; });
    const b = await runtime.snapshot();
    assert.equal(b.quota?.tokens.used, 22); assert.deepEqual(b.models, ['beta/model']); assert.equal(b.connection?.name, 'Beta');
    assert.ok(!JSON.stringify([a, b]).includes(keyA)); assert.ok(!JSON.stringify([a, b]).includes(keyB));
    assert.ok(!JSON.stringify([a, b]).includes('private-account'));
  } finally { await server.close(); await t.close(); }
});
for (const action of ['select', 'remove'] as const) test(`${action} 使旧连接迟到响应失效`, async () => {
  const t = await temporaryStore(), entered = deferred<void>(), release = deferred<void>();
  const server = await mockServer(async (_req, res) => { entered.resolve(); await release.promise; json(res, quotaFixture()); });
  try {
    const state = await t.store.update('empty', s => {
      s.connections = [{ id: 'a', name: 'Alpha', baseUrl: `${server.origin}/v1`, key: keyA },
        { id: 'b', name: 'Beta', baseUrl: `${server.origin}/v1`, key: keyB }]; s.activeId = 'a';
    });
    const runtime = new Runtime(t.store), response = runtime.snapshot('quota'); await entered.promise;
    await t.store.update(state.revision, s => { if (action === 'select') s.activeId = 'b'; else { s.connections = s.connections.filter(c => c.id !== 'a'); s.activeId = null; } });
    release.resolve(); const stale = await response;
    assert.equal(stale.quota, null); assert.equal(stale.models, null); assert.equal(stale.connection, null); assert.equal(stale.quotaError?.code, 'connection_changed');
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
    } else json(res, quotaFixture());
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
