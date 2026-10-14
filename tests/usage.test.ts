import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewayError, parseQuota, readGateway } from '../lib/gateway';
import { parsePersonalUsage, readPersonalUsage } from '../lib/usage';
import { Runtime } from '../local/runtime';
import { usagePeriods } from '../lib/types';
import { json, keyA, mockServer, quotaFixture, temporaryStore, usageFixture } from './fixtures';

const heldMessage = 'this gateway key is held to a budget, models or accounts, so it is told its own calls alone: GET /v1/magpie/usage/requests';
test('只投影完整模型汇总，Token 包含缓存读写且不重复计算一小时缓存或 reasoning', () => {
  const usage = parsePersonalUsage(usageFixture(), keyA), text = JSON.stringify(usage);
  assert.equal(usage.totals.tokens, 1900); assert.equal(usage.models[0].tokens, 1550);
  assert.equal(usage.totals.cost, .25); assert.equal(usage.totals.calls, 3);
  assert.equal(usage.totals.errors, 0); assert.equal(usage.totals.retried, 0);
  assert.equal(usage.source, 'through'); assert.equal(usage.scope, 'current-key');
  assert.doesNotMatch(text, /private-|reasoning|cache_write_1h|rows|callerKeys/); assert.ok(!text.includes(keyA));
});
test('缺失和非法数字保持未知，真实零用量可展示，不接受错误日期或不完整聚合', () => {
  const f: any = usageFixture();
  f.input = undefined; f.cost = -1; f.unpriced = Infinity;
  f.by.model[0].input = Number.MAX_SAFE_INTEGER + 1;
  const result = parsePersonalUsage(f, keyA);
  assert.equal(result.totals.input, null); assert.equal(result.totals.tokens, null);
  assert.equal(result.totals.cost, null); assert.equal(result.totals.unpriced, null);
  assert.equal(result.models[0].input, null);
  const empty = { ...usageFixture(), calls: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0, unpriced: 0, total: 0, rows: [], by: { model: [] } };
  assert.equal(parsePersonalUsage(empty, keyA).totals.tokens, 0);
  for (const patch of [{ period: 'week' }, { offset: 1 }, { rows: [1, 2] }, { by: { model: [] } }, { calls: 8 }]) {
    assert.throws(() => parsePersonalUsage({ ...usageFixture(), ...patch }, keyA), GatewayError);
  }
  assert.equal(parsePersonalUsage({ ...f, input: Number.MAX_SAFE_INTEGER }, keyA).totals.tokens, null);
});
test('调用质量仅投影汇总计数，重试省略为零，无效及矛盾数字为未知', () => {
  const active = parsePersonalUsage({ ...usageFixture(), errors: 1, retried: 2 }, keyA);
  assert.equal(active.totals.errors, 1); assert.equal(active.totals.retried, 2);
  for (const patch of [{ errors: undefined, retried: null }, { errors: -1, retried: '2' },
    { errors: 4, retried: 4 }, { errors: Infinity, retried: .5 }]) {
    const usage = parsePersonalUsage({ ...usageFixture(), ...patch }, keyA);
    assert.equal(usage.totals.errors, null); assert.equal(usage.totals.retried, null);
  }
  assert.equal(parsePersonalUsage({ ...usageFixture(), errors: 2, retried: 2 }, keyA).totals.retried, null);
});
test('模型文本转发有大小、控制字符、密钥泄露和重复保护', () => {
  for (const id of [' ', 'x'.repeat(301), 'hidden\nmodel', `model-${keyA}`, 'model-beta']) {
    const f = usageFixture(); f.by.model[0].id = id;
    assert.throws(() => parsePersonalUsage(f, keyA), GatewayError);
  }
  const unknownModel = usageFixture(); unknownModel.by.model[0].id = '';
  assert.equal(parsePersonalUsage(unknownModel, keyA).models[0].tokens, 1550);
});
test('有限额 Key 固定今天与 through，只取一行却使用全范围聚合；不探测全局接口', async () => {
  const paths: string[] = [];
  const server = await mockServer((req, res) => {
    paths.push(req.url!); assert.equal(req.method, 'GET'); assert.equal(req.headers.authorization, `Bearer ${keyA}`);
    json(res, usageFixture());
  });
  try {
    const result = await readPersonalUsage(`${server.origin}/prefix/v1`, keyA, parseQuota(quotaFixture()));
    assert.equal(result.totals.calls, 3);
    assert.deepEqual(paths, ['/prefix/v1/magpie/usage/requests?period=today&via=through&limit=1&offset=0']);
  } finally { await server.close(); }
});
test('模型或账号受限 Key 只接受官方明确的隔离信号；普通 403 不推断个人范围', async () => {
  let message = heldMessage; const paths: string[] = [];
  const server = await mockServer((req, res) => {
    paths.push(req.url!);
    if (req.url?.includes('/requests?')) json(res, usageFixture());
    else json(res, { error: { message, secret: keyA } }, 403);
  });
  try {
    const quota = parseQuota({ limited: false, key: 'Nonunique name' });
    assert.equal((await readPersonalUsage(`${server.origin}/v1`, keyA, quota)).totals.tokens, 1900);
    assert.equal(paths.length, 2);
    paths.length = 0; message = 'Some policy denied access';
    await assert.rejects(readPersonalUsage(`${server.origin}/v1`, keyA, quota), (e: any) => e.code === 'forbidden' && !e.message.includes(message));
    assert.equal(paths.length, 1);
    message = 'x'.repeat(8192);
    await assert.rejects(readPersonalUsage(`${server.origin}/v1`, keyA, quota), (e: any) => e.code === 'forbidden');
  } finally { await server.close(); }
});
test('无限制 Key 丢弃全局结果，不按非唯一名称推断身份', async () => {
  const paths: string[] = [];
  const server = await mockServer((req, res) => {
    paths.push(req.url!);
    json(res, { ...usageFixture(), callerKeys: [{ id: 'foreign-id', name: 'Nonunique name' }] });
  });
  try {
    const quota = parseQuota({ limited: false, key: 'Nonunique name' });
    await assert.rejects(readPersonalUsage(`${server.origin}/v1`, keyA, quota), (e: any) => e.code === 'usage_scope_unknown');
    assert.equal(paths.length, 1);
  } finally { await server.close(); }
});
test('用量失败独立于额度，保留过期数据；权限范围变化立即清空', async () => {
  const t = await temporaryStore(); let status = 200, limited = true;
  const server = await mockServer((req, res) => {
    if (req.url?.endsWith('/limit')) json(res, limited ? quotaFixture() : { limited: false, key: 'Synthetic' });
    else json(res, usageFixture(), status);
  });
  try {
    await t.store.update('empty', s => { s.connections.push({ id: 'a', name: 'Alpha', baseUrl: `${server.origin}/v1`, key: keyA }); s.activeId = 'a'; });
    const runtime = new Runtime(t.store), first = await runtime.snapshot('dashboard');
    assert.equal(first.usage?.totals.tokens, 1900); assert.equal(first.stale, false);
    status = 503;
    const failed = await runtime.snapshot('dashboard');
    assert.deepEqual(failed.usage, first.usage); assert.equal(failed.usageReadAt, first.usageReadAt); assert.equal(failed.stale, true);
    assert.equal(failed.quotaError, null);
    status = 200; limited = false;
    const changed = await runtime.snapshot('dashboard');
    assert.equal(changed.usage, null); assert.equal(changed.usageReadAt, null); assert.equal(changed.usageError?.code, 'usage_scope_unknown');
    assert.equal(changed.stale, false);
  } finally { await server.close(); await t.close(); }
});
test('四个时间范围封闭读取与响应核对，禁止任意查询和跨范围旧缓存', async () => {
  const t = await temporaryStore(); let failure = false;
  const paths: string[] = [];
  const server = await mockServer((req, res) => {
    paths.push(req.url!);
    if (req.url?.endsWith('/limit')) json(res, quotaFixture());
    else json(res, { ...usageFixture(), period: new URL(req.url!, 'http://localhost').searchParams.get('period') }, failure ? 503 : 200);
  });
  try {
    await t.store.update('empty', s => { s.connections.push({ id: 'a', name: 'Alpha', baseUrl: `${server.origin}/v1`, key: keyA }); s.activeId = 'a'; });
    const runtime = new Runtime(t.store);
    for (const period of usagePeriods) {
      const data = await runtime.snapshot('dashboard', period);
      assert.equal(data.usage?.period, period); assert.equal(data.usage?.totals.tokens, 1900);
      assert.ok(paths.includes(`/v1/magpie/usage/requests?period=${period}&via=through&limit=1&offset=0`));
    }
    assert.throws(() => parsePersonalUsage(usageFixture(), keyA, '7d'), GatewayError);
    const before = paths.length;
    await assert.rejects(runtime.snapshot('dashboard', 'today&via=direct' as any), GatewayError);
    await assert.rejects(readGateway(`${server.origin}/v1`, keyA, 'usageRequests', 1000, 'invalid' as any), GatewayError);
    assert.equal(paths.length, before);
    failure = true;
    const failed = await runtime.snapshot('dashboard', '7d');
    assert.equal(failed.usage, null); assert.equal(failed.usageReadAt, null);
    failure = false;
    const week = await runtime.snapshot('dashboard', '7d');
    failure = true;
    assert.deepEqual((await runtime.snapshot('dashboard', '7d')).usage, week.usage);
  } finally { await server.close(); await t.close(); }
});
