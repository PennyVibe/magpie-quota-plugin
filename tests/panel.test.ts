import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import { localWidgetHtml } from '../generated/local-widget';
import { parseQuota } from '../lib/gateway';
import { quotaFixture } from './fixtures';
import type { Snapshot } from '../lib/types';
import { renderSnapshot } from '../widget/view';
const delay = () => new Promise(resolve => setTimeout(resolve, 25));
const snapshot: Snapshot = {
  revision: 'alpha-revision', connection: { id: 'a', name: 'Alpha', baseUrl: 'https://gateway.example.test/prefix/v1' },
  quota: parseQuota(quotaFixture()), models: ['provider/model-a'], quotaReadAt: '2026-10-10T10:00:00Z', modelsReadAt: '2026-10-10T10:00:00Z',
  quotaError: null, modelsError: null, stale: false,
};
function mount(options: { hold?: boolean; hidden?: boolean } = {}) {
  const messages: any[] = [], errors: unknown[] = [], intervals = new Map<number, { callback: () => void; delay: number }>();
  let win: any, intervalId = 0, visibility = options.hidden ? 'hidden' : 'visible', held = options.hold ?? false, current = snapshot;
  const respond = (payload: any) => queueMicrotask(() => win.dispatchEvent(new win.MessageEvent('message', { source: host, data: { jsonrpc: '2.0', ...payload } })));
  const host = { postMessage(message: any) {
    messages.push(message);
    if (message.method === 'ui/initialize') respond({ id: message.id, result: {
      protocolVersion: '2026-01-26', hostInfo: { name: 'Synthetic Desktop', version: '1' },
      hostCapabilities: { serverTools: {}, openLinks: {} }, hostContext: { displayMode: 'fullscreen', availableDisplayModes: ['fullscreen'] },
    } });
    if (message.method === 'tools/call') {
      if (message.params.name === 'open_quota_dashboard') { if (!held) respond({ id: message.id, result: { content: [], structuredContent: current } }); }
      else if (message.params.name === 'get_connection_state') respond({ id: message.id, result: { content: [], _meta: { 'magpie/revision': current.revision } } });
      else respond({ id: message.id, result: { content: [], _meta: { 'magpie/connectUrl': `http://127.0.0.1:40123/connect?bootstrap=${'a'.repeat(43)}`, 'magpie/browserOpen': 'requested' } } });
    }
  } };
  const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e));
  const dom = new JSDOM(localWidgetHtml, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://widget.example.test', virtualConsole: vc,
    beforeParse(window: any) {
      win = window; Object.defineProperty(window, 'parent', { value: host });
      Object.defineProperty(window.document, 'visibilityState', { get: () => visibility });
      window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
      window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      window.setInterval = (callback: () => void, delay: number) => { intervals.set(++intervalId, { callback, delay }); return intervalId; };
      window.clearInterval = (id: number) => intervals.delete(id);
    },
  });
  const calls = () => messages.filter(m => m.method === 'tools/call' && m.params.name === 'open_quota_dashboard');
  return { dom, messages, errors, respond, calls,
    setHeld: (value: boolean) => { held = value; },
    change: (value: Snapshot) => { current = value; },
    tick: (delay: number) => { for (const timer of [...intervals.values()]) if (timer.delay === delay) timer.callback(); },
    visibility: (value: 'visible' | 'hidden') => { visibility = value; win.document.dispatchEvent(new win.Event('visibilitychange')); },
    teardown: () => respond({ id: 900, method: 'ui/resource-teardown', params: {} }),
    intervals,
    close: () => { dom.window.dispatchEvent(new dom.window.Event('pagehide')); dom.window.close(); },
  };
}
test('真实 SDK 面板握手、刷新不重叠、60 秒节奏与 autoResize 关闭', async () => {
  const m = mount({ hold: true });
  try {
    await delay(); assert.equal(m.calls().length, 1);
    m.tick(60000); m.tick(60000); m.dom.window.document.querySelector<HTMLButtonElement>('#refresh')!.click(); await delay();
    assert.equal(m.calls().length, 1);
    m.setHeld(false); m.respond({ id: m.calls()[0].id, result: { content: [], structuredContent: snapshot } }); await delay();
    assert.match(m.dom.window.document.body.textContent!, /Alpha/);
    m.tick(60000); await delay(); assert.equal(m.calls().length, 2);
    assert.equal(m.messages.filter(msg => msg.method === 'ui/notifications/size-changed').length, 0);
    assert.equal(m.messages.filter(msg => msg.method === 'ui/request-display-mode').length, 0);
    assert.deepEqual(m.errors, []);
  } finally { m.close(); }
});
test('隐藏时停止刷新，隐藏中挂载不读取；恢复可见后才读取', async () => {
  const m = mount({ hidden: true });
  try {
    await delay(); assert.equal(m.calls().length, 0); assert.equal(m.intervals.size, 0);
    m.visibility('visible'); await delay(); assert.equal(m.calls().length, 1);
    m.visibility('hidden'); m.tick(60000); await delay(); assert.equal(m.calls().length, 1); assert.equal(m.intervals.size, 0);
    m.visibility('visible'); await delay(); assert.equal(m.calls().length, 2);
  } finally { m.close(); }
});
test('连接管理立即清空视图，迟到旧额度不能重新显示', async () => {
  const m = mount();
  try {
    await delay(); assert.match(m.dom.window.document.body.textContent!, /Alpha/);
    m.setHeld(true); m.dom.window.document.querySelector<HTMLButtonElement>('#refresh')!.click(); await delay();
    const pending = m.calls().at(-1);
    m.dom.window.document.querySelector<HTMLButtonElement>('#manage')!.click(); await delay();
    assert.doesNotMatch(m.dom.window.document.body.textContent!, /Alpha|model-a/);
    m.respond({ id: pending.id, result: { content: [], structuredContent: snapshot } }); await delay();
    assert.doesNotMatch(m.dom.window.document.body.textContent!, /Alpha|model-a/);
    m.setHeld(false); m.change({ ...snapshot, revision: 'beta', connection: { ...snapshot.connection!, name: 'Beta' }, models: ['beta/model'] });
    m.dom.window.document.querySelector<HTMLButtonElement>('#return')!.click(); await delay();
    assert.match(m.dom.window.document.body.textContent!, /Beta/); assert.doesNotMatch(m.dom.window.document.body.textContent!, /Alpha|model-a/);
  } finally { m.close(); }
});
test('浏览器外部连接变更轮询清空旧数据并丢弃正在返回的旧快照', async () => {
  const m = mount();
  try {
    await delay(); m.setHeld(true); m.tick(60000); await delay(); const old = m.calls().at(-1);
    m.change({ ...snapshot, revision: 'removed', connection: null, quota: null, models: null });
    m.tick(1000); await delay(); assert.doesNotMatch(m.dom.window.document.body.textContent!, /Alpha|model-a/);
    m.setHeld(false); m.respond({ id: old.id, result: { content: [], structuredContent: snapshot } }); await delay();
    assert.doesNotMatch(m.dom.window.document.body.textContent!, /Alpha|model-a/);
  } finally { m.close(); }
});
test('teardown 先响应宿主，关闭后无计时器、迟到快照或尺寸通知', async () => {
  const m = mount({ hold: true });
  try {
    await delay(); const pending = m.calls()[0]; m.teardown(); await delay();
    assert.deepEqual(JSON.parse(JSON.stringify(m.messages.find(msg => msg.id === 900)?.result)), {});
    const before = m.dom.window.document.body.textContent;
    m.respond({ id: pending.id, result: { content: [], structuredContent: snapshot } }); await delay();
    m.tick(60000); m.tick(1000); await delay();
    assert.equal(m.dom.window.document.body.textContent, before); assert.equal(m.calls().length, 1); assert.equal(m.intervals.size, 0);
    assert.equal(m.messages.filter(msg => msg.method === 'ui/notifications/size-changed').length, 0); assert.deepEqual(m.errors, []);
  } finally { m.close(); }
});
test('渲染保留真实零值、标明缺失/过期/估算费用，并转义服务器文本', () => {
  const s = { ...snapshot, stale: true, quota: parseQuota(quotaFixture({ tokens: 0, tokensLeft: 0, cost: undefined, costLeft: 0 })),
    connection: { ...snapshot.connection!, name: '<img src=x onerror=alert(1)>' },
    quotaError: { code: 'invalid_key', message: 'Key 无效' } };
  const dom = new JSDOM(renderSnapshot(s));
  try {
    assert.equal(dom.window.document.querySelector('img,script'), null);
    assert.match(dom.window.document.body.textContent!, /0已用/); assert.match(dom.window.document.body.textContent!, /未提供/);
    assert.match(dom.window.document.body.textContent!, /估算费用/); assert.match(dom.window.document.body.textContent!, /已过期/);
  } finally { dom.window.close(); }
});
test('看板不展示模型列表，也不显示与独立模型查询有关的失败状态', () => {
  const html = renderSnapshot({ ...snapshot, modelsError: { code: 'unsupported', message: '模型查询专属错误' } });
  assert.doesNotMatch(html, /当前 Key 可用模型|provider\/model-a|模型查询专属错误/);
});
test('Token 的已用、上限和剩余按 K/M/B 两位小数显示，完整值和费用精度保留', () => {
  for (const [used, expected, progress] of [[0, '0', '0.0'], [999, '999', '0.0'], [1000, '1.00K', '0.0'],
    [65660000, '65.66M', '2.2'], [1200000000, '1.20B', '40.0'], [1234567890, '1.23B', '41.2']] as const) {
    const dom = new JSDOM(renderSnapshot({ ...snapshot, quota: parseQuota(quotaFixture({
      tokens: used, tokenLimit: 3000000000, tokensLeft: 1800000000, cost: 1680.123456,
    })) }));
    try {
      const token = dom.window.document.querySelector('.metric')!;
      assert.equal(token.querySelector('.used')?.textContent, `${expected}已用`);
      if (used >= 1000) {
        assert.equal(token.querySelector('.used data')?.getAttribute('value'), String(used));
        assert.match(token.querySelector('.used data')?.getAttribute('title') ?? '', /Token/);
      }
      assert.deepEqual([...token.querySelectorAll('dd')].map(el => el.textContent), ['3.00B', '1.80B']);
      assert.equal(token.querySelector('.hint')!.textContent, `已用 ${progress}%`);
      assert.equal(dom.window.document.querySelectorAll('.metric .used')[1].textContent, '$1,680.123456已用');
    } finally { dom.window.close(); }
  }
});
test('Token 与费用上限分别可选，未设限不显示零余额或虚构进度，缺失用量不补零', () => {
  for (const [overrides, uncappedIndex, cappedIndex, used] of [
    [{ costLimit: undefined, cost: undefined, costLeft: undefined }, 1, 0, '未提供已用'],
    [{ tokenLimit: undefined, tokens: undefined, tokensLeft: undefined }, 0, 1, '未提供已用'],
    [{ costLimit: undefined }, 1, 0, '$0.125已用'],
    [{ tokenLimit: undefined }, 0, 1, '30已用'],
  ] as const) {
    const dom = new JSDOM(renderSnapshot({ ...snapshot, quota: parseQuota(quotaFixture(overrides)) }));
    try {
      const metrics = dom.window.document.querySelectorAll('.metric'), uncapped = metrics[uncappedIndex], capped = metrics[cappedIndex];
      assert.equal(uncapped.querySelector('.used')?.textContent, used);
      assert.deepEqual([...uncapped.querySelectorAll('dd')].map(el => el.textContent), ['未设限', '未设限']);
      assert.equal(uncapped.querySelector('.track div'), null);
      assert.match(uncapped.querySelector('.hint')!.textContent!, /未设限/);
      assert.ok(capped.querySelector('.track div'));
      assert.doesNotMatch(capped.textContent!, /未设限/);
    } finally { dom.window.close(); }
  }
  const dom = new JSDOM(renderSnapshot({ ...snapshot, quota: parseQuota({ limited: false, key: 'Synthetic' }) }));
  try {
    assert.match(dom.window.document.body.textContent!, /当前 Gateway key 未设置限额/);
    assert.equal(dom.window.document.querySelectorAll('.metric').length, 2);
    assert.deepEqual([...dom.window.document.querySelectorAll('.used')].map(el => el.textContent), ['未提供已用', '未提供已用']);
    assert.deepEqual([...dom.window.document.querySelectorAll('.metric dd')].map(el => el.textContent), ['未设限', '未设限', '未设限', '未设限']);
    assert.match(dom.window.document.body.textContent!, /用量暂不可读取/);
    assert.equal(dom.window.document.querySelector('.track div, #countdown'), null);
  } finally { dom.window.close(); }
});
