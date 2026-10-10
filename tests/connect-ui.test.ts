import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import { localConnectHtml } from '../generated/local-connect';
import { ConnectServer } from '../local/connect-server';
import { Runtime } from '../local/runtime';
import { keyA, mockServer, json, quotaFixture, temporaryStore } from './fixtures';
async function waitForUI(ready: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!ready()) {
    assert.ok(Date.now() < deadline, '连接页面未在时限内完成操作');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
test('构建连接页实际表单提交、Key 即时清空、名称安全渲染和连接切换', async () => {
  const t = await temporaryStore(), logs: unknown[] = [];
  const remote = await mockServer((_req, res) => json(res, quotaFixture()));
  const connector = await new ConnectServer(t.store, new Runtime(t.store), localConnectHtml).start();
  let dom: JSDOM | undefined;
  try {
    const entryUrl = connector.issueConnectionUrl(), entry = await fetch(entryUrl);
    const cookie = entry.headers.get('set-cookie')!.split(';')[0];
    const vc = new VirtualConsole();
    vc.on('jsdomError', value => logs.push(value));
    for (const event of ['log', 'error', 'warn'] as const) vc.on(event, value => logs.push(value));
    dom = new JSDOM(await entry.text(), {
      url: entryUrl, runScripts: 'dangerously', virtualConsole: vc,
      beforeParse(window: any) {
        window.fetch = (path: string, options: RequestInit = {}) => fetch(`${connector.origin}${path}`, {
          ...options, headers: { ...options.headers, Cookie: cookie, ...(options.method === 'POST' ? { Origin: connector.origin } : {}) },
        });
        window.confirm = () => true;
      },
    });
    const document = dom.window.document;
    const ready = () => !document.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled;
    await waitForUI(ready);
    assert.equal(dom.window.location.search, '');
    const name = document.querySelector<HTMLInputElement>('[name=name]')!, address = document.querySelector<HTMLInputElement>('[name=address]')!, key = document.querySelector<HTMLInputElement>('[name=key]')!;
    name.value = '<img src=x> Alpha'; address.value = `${remote.origin}/gateway`; key.value = keyA;
    document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(key.value, '');
    await waitForUI(() => ready() && document.getElementById('connections')!.textContent!.includes('Alpha'));
    assert.match(document.getElementById('connections')!.textContent!, /Alpha/);
    assert.equal(document.querySelector('img'), null);
    assert.equal((await t.store.read()).connections[0].baseUrl, `${remote.origin}/gateway/v1`);
    assert.ok(!document.documentElement.innerHTML.includes(keyA)); assert.deepEqual(logs, []);
    const remove = [...document.querySelectorAll<HTMLButtonElement>('#connections button')].find(b => b.textContent === '移除连接')!;
    remove.click();
    await waitForUI(() => ready() && document.getElementById('connections')!.textContent!.includes('尚未保存'));
    assert.equal((await t.store.read()).connections.length, 0);
    assert.match(document.getElementById('connections')!.textContent!, /尚未保存/);
  } finally { dom?.window.close(); await connector.close(); await remote.close(); await t.close(); }
});
