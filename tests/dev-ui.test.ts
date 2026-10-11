import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, symlink, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { json, keyA, mockServer, quotaFixture, temporaryStore, usageFixture } from './fixtures';

const { startLivePreview } = await import(new URL('../scripts/dev-ui.mjs', import.meta.url).href);
type PreviewState = { version: number; building: boolean; error: string };
async function waitForState(url: string, check: (state: PreviewState) => boolean) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const state: PreviewState = await (await fetch(`${url}status`)).json();
    if (check(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('开发预览未在期限内完成重建。');
}

test('真实开发预览隔离构建、监听重建、失败恢复、SSE 更新及只读桥接', { timeout: 60000 }, async () => {
  const temporary = await temporaryStore();
  const root = join(temporary.directory, 'source');
  const repository = fileURLToPath(new URL('../', import.meta.url));
  const calls: string[] = [], logs: string[] = [];
  const remote = await mockServer((req, res) => {
    calls.push(req.url!);
    assert.equal(req.method, 'GET');
    assert.equal(req.headers.authorization, `Bearer ${keyA}`);
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname.endsWith('/limit')) json(res, quotaFixture());
    else if (url.pathname.endsWith('/cards')) json(res, { object: 'list', data: [] });
    else if (url.pathname.endsWith('/usage/requests')) json(res, { ...usageFixture(), period: url.searchParams.get('period') });
    else { res.writeHead(404).end(); }
  });
  let preview: { url: string; close: () => Promise<void> } | undefined;
  const eventsAbort = new AbortController();
  try {
    await mkdir(root);
    const copies = await Promise.allSettled(['local', 'lib', 'widget', 'plugins/magpie-quota-local/assets', 'generated'].map(directory =>
      cp(join(repository, directory), join(root, directory), { recursive: true })));
    for (const copy of copies) if (copy.status === 'rejected') throw copy.reason;
    await cp(join(repository, 'package.json'), join(root, 'package.json'));
    await symlink(join(repository, 'node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const originalGenerated = await readFile(join(root, 'generated/local-widget.ts'), 'utf8');
    const originalCss = await readFile(join(root, 'widget/style.css'), 'utf8');
    const mainFile = join(root, 'widget/main.ts');
    const originalMain = await readFile(mainFile, 'utf8');
    await temporary.store.update('empty', state => {
      state.connections.push({ id: 'preview', name: '合成开发连接', baseUrl: `${remote.origin}/v1`, key: keyA });
      state.activeId = 'preview';
    });
    const running: NonNullable<typeof preview> = await startLivePreview({ root, dataDirectory: temporary.store.directory, log: (message: string) => logs.push(message) });
    preview = running;
    const url = running.url;
    const first = await waitForState(url, state => state.version > 0 && !state.building);
    assert.equal(calls.length, 0, '启动预览不应预先读取网关');
    const origin = new URL(url).origin;
    const headers = { Origin: origin, 'Content-Type': 'application/json' };
    const request = (params: unknown, originOverride = origin) => fetch(`${url}tool`, {
      method: 'POST', headers: { ...headers, Origin: originOverride }, body: JSON.stringify(params),
    });
    const data = await (await request({ name: 'open_quota_dashboard', arguments: { period: '7d' } })).json();
    assert.equal(data.structuredContent.connection.name, '合成开发连接');
    assert.equal(data.structuredContent.usage.period, '7d');
    assert.ok(calls.some(path => path.includes('period=7d')));
    assert.ok(!JSON.stringify(data).includes(keyA));
    const before = calls.length;
    for (const params of [
      { name: 'manage_connections', arguments: {} },
      { name: 'list_available_models', arguments: {} },
      { name: 'open_quota_dashboard', arguments: { period: 'today&via=direct' } },
      { name: 'get_connection_state', arguments: { url: remote.origin } },
      null,
    ]) assert.equal((await request(params)).status, 400);
    assert.equal((await request({ name: 'open_quota_dashboard' }, 'https://example.test')).status, 403);
    assert.equal(calls.length, before);

    const events = await fetch(`${url}events`, { signal: eventsAbort.signal });
    assert.match(events.headers.get('content-type')!, /text\/event-stream/);
    const reader = events.body!.getReader();
    let streamed = '';
    assert.match(new TextDecoder().decode((await reader.read()).value), /"version":/);
    await writeFile(join(root, 'widget/style.css'), `${originalCss}\n:root { --preview-check: first; }\n`);
    await writeFile(join(root, 'widget/style.css'), `${originalCss}\n:root { --preview-check: latest; }\n`);
    const second = await waitForState(url, state => state.version > first.version && !state.building);
    const updated = await (await fetch(`${url}widget`)).text();
    assert.match(updated, /--preview-check: latest/);
    assert.doesNotMatch(updated, /--preview-check: first/);
    while (!streamed.includes(`"version":${second.version}`)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      streamed += new TextDecoder().decode(chunk.value);
    }
    assert.match(streamed, new RegExp(`"version":${second.version}`));
    eventsAbort.abort();

    await writeFile(mainFile, `${originalMain}\nconst invalid = ;\n`);
    const failed = await waitForState(url, state => Boolean(state.error));
    assert.equal(failed.version, second.version);
    assert.equal(await (await fetch(`${url}widget`)).text(), updated);
    const retained = await (await request({ name: 'get_connection_state', arguments: {} })).json();
    assert.equal(typeof retained._meta['magpie/revision'], 'string');
    await writeFile(mainFile, originalMain.replaceAll('Magpie 额度看板', 'Magpie 开发验证'));
    const recovered = await waitForState(url, state => state.version > failed.version && !state.building && !state.error);
    assert.match(await (await fetch(`${url}widget`)).text(), /Magpie 开发验证/);
    const backendFile = join(root, 'lib/mcp.ts');
    await writeFile(backendFile, (await readFile(backendFile, 'utf8')).replace(
      "'magpie/revision': state.revision", "'magpie/revision': 'preview-backend-reloaded'"));
    await waitForState(url, state => state.version > recovered.version && !state.building && !state.error);
    const reloaded = await (await request({ name: 'get_connection_state', arguments: {} })).json();
    assert.equal(reloaded._meta['magpie/revision'], 'preview-backend-reloaded');
    assert.equal(await readFile(join(root, 'generated/local-widget.ts'), 'utf8'), originalGenerated);
    await assert.rejects(access(join(root, 'dist')), { code: 'ENOENT' });
    assert.ok(!logs.join('\n').includes(keyA));
  } finally {
    eventsAbort.abort();
    await preview?.close();
    await remote.close();
    await temporary.close();
  }
});
