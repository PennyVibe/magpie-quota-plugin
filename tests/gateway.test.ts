import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewayError, normalizeAddress, parseModels, parseQuota, readGateway } from '../lib/gateway';
import { keyA, quotaFixture, mockServer, json } from './fixtures';

for (const [input, expected] of [
  ['https://example.com/magpie-gateway', 'https://example.com/magpie-gateway/v1'],
  ['https://example.com/magpie-gateway/v1', 'https://example.com/magpie-gateway/v1'],
  ['http://example.com:4567/a/b/v1/', 'http://example.com:4567/a/b/v1'],
  ['https://example.com/', 'https://example.com/v1'],
  ['http://[::1]:9123/deploy/', 'http://[::1]:9123/deploy/v1'],
]) test(`地址规范化保留协议和路径: ${input}`, () => assert.equal(normalizeAddress(input), expected));
for (const input of ['ftp://example.com', 'https://user:pass@example.com', 'https://example.com?key=secret',
  'https://example.com#key', '/v1', 'https://example.com/a%2fb', 'http://example.com\\evil', 'https://example.com/a b']) {
  test(`拒绝含凭证或模糊地址: ${input}`, () => assert.throws(() => normalizeAddress(input), GatewayError));
}
test('真实 contract 映射单窗口、服务器剩余和带偏移时间', () => {
  const q = parseQuota(quotaFixture({ tokensLeft: 51 }));
  assert.equal(q.period, 'week'); assert.equal(q.tokens.used, 30); assert.equal(q.tokens.limit, 100);
  assert.equal(q.tokens.remaining, 51); assert.equal(q.reset, '2026-10-12T00:00:00+08:00');
  assert.equal(q.cost.remaining, 1.875);
});
test('无限额、零上限的无 cap 语义与实际零用量/零剩余分别保留', () => {
  assert.equal(parseQuota({ limited: false, key: 'Synthetic' }).limited, false);
  const q = parseQuota(quotaFixture({ tokenLimit: 0, tokens: 0, cost: 0, costLeft: 0, spent: true }));
  assert.equal(q.tokens.uncapped, true); assert.equal(q.tokens.limit, null); assert.equal(q.tokens.used, 0);
  assert.equal(q.cost.used, 0); assert.equal(q.cost.remaining, 0); assert.equal(q.spent, true);
  const omitted = parseQuota(quotaFixture({ tokenLimit: undefined }));
  assert.equal(omitted.tokens.uncapped, true);
});
for (const value of [undefined, null, -1, NaN, Infinity, '0', Number.MAX_SAFE_INTEGER + 1, 0.5]) {
  test(`Token 非法或缺失数值不是零: ${String(value)}`, () => {
    const q = parseQuota(quotaFixture({ tokens: value, tokenLimit: value === undefined ? -1 : value, tokensLeft: value }));
    assert.equal(q.tokens.used, null); assert.equal(q.tokens.remaining, null);
    if (value !== undefined) assert.equal(q.tokens.limit, null);
  });
}
test('费用缺失/非有限值不生成余额或进度；未知日期不推断', () => {
  const q = parseQuota(quotaFixture({ cost: undefined, costLimit: Infinity, costLeft: '0', reset: 'tomorrow', start: '2026-10-05' }));
  assert.equal(q.cost.used, null); assert.equal(q.cost.remaining, null); assert.equal(q.cost.limit, null);
  assert.equal(q.reset, null); assert.equal(q.start, null);
});
for (const value of [{}, { limited: true, key: 'User', limit: { period: 'hour' } },
  { limited: true, key: 'User', limit: { period: 'day', renamedTokenCap: 100 } }, { limited: false, key: '' }, { limited: false }]) {
  test(`接口版本差异不能误判无限额: ${JSON.stringify(value)}`, () => assert.throws(() => parseQuota(value), GatewayError));
}
test('模型仅提取 ID，过滤凭证回显且不复制共享元数据', () => {
  assert.deepEqual(parseModels({ object: 'list', data: [
    { id: 'provider/model-a', account: 'private@example.test' }, { id: keyA }, { id: 'provider/model-a' }, { id: null },
  ] }, keyA), ['provider/model-a']);
  assert.throws(() => parseModels({ data: [] }, keyA), GatewayError);
});
for (const [status, code] of [[401, 'invalid_key'], [403, 'forbidden'], [404, 'unsupported'], [405, 'unsupported'], [501, 'unsupported'], [429, 'rate_limited'], [500, 'server_error']] as const) {
  test(`HTTP ${status} 使用固定安全错误且丢弃上游响应正文`, async () => {
    const server = await mockServer((_req, res) => json(res, { error: `${keyA} private@example.test` }, status));
    try {
      await assert.rejects(readGateway(`${server.origin}/v1`, keyA, 'limit'), (e: GatewayError) => {
        assert.equal(e.code, code); assert.ok(!e.message.includes(keyA)); assert.ok(!e.message.includes('private')); return true;
      });
    } finally { await server.close(); }
  });
}
test('实际 HTTP 请求只读并保留部署路径与 Bearer；模型同样保留前缀', async () => {
  const paths: string[] = [];
  const server = await mockServer((req, res) => {
    assert.equal(req.method, 'GET'); assert.equal(req.headers.authorization, `Bearer ${keyA}`);
    paths.push(req.url!); json(res, quotaFixture());
  });
  try {
    await readGateway(normalizeAddress(`${server.origin}/deployment`), keyA, 'limit');
    await readGateway(normalizeAddress(`${server.origin}/deployment/v1`), keyA, 'models');
    assert.deepEqual(paths, ['/deployment/v1/magpie/limit', '/deployment/v1/models']);
  } finally { await server.close(); }
});
test('跨来源和同来源重定向均不产生第二次请求或转发 Key', async () => {
  let targetCalls = 0, sourceCalls = 0;
  const target = await mockServer((_req, res) => { targetCalls++; json(res, {}); });
  let location = `${target.origin}/steal`;
  const source = await mockServer((_req, res) => { sourceCalls++; res.writeHead(302, { Location: location }); res.end(); });
  try {
    for (const next of [`${target.origin}/steal`, `${source.origin}/steal`]) {
      location = next;
      await assert.rejects(readGateway(`${source.origin}/v1`, keyA, 'limit'), (e: GatewayError) => e.code === 'redirect');
    }
    assert.equal(targetCalls, 0); assert.equal(sourceCalls, 2);
  } finally { await source.close(); await target.close(); }
});
test('无效 JSON、超时、不可达分别返回可辨认固定错误', async () => {
  const server = await mockServer((req, res) => { if (req.url?.includes('models')) return; res.end(`invalid ${keyA}`); });
  try {
    await assert.rejects(readGateway(`${server.origin}/v1`, keyA, 'limit'), (e: GatewayError) => e.code === 'invalid_json');
    await assert.rejects(readGateway(`${server.origin}/v1`, keyA, 'models', 30), (e: GatewayError) => e.code === 'timeout');
  } finally { await server.close(); }
  await assert.rejects(readGateway(`${server.origin}/v1`, keyA, 'limit'), (e: GatewayError) => e.code === 'unreachable');
});
