import type { Connection } from '../lib/types';
import { brandMark } from '../lib/brand';
const root = document.getElementById('app')!;
root.innerHTML = `<div class="shell"><header class="brand">${brandMark}<div><p class="eyebrow">Magpie · 连接管理</p><h1>连接你的网关</h1></div></header><p class="intro">添加或切换 Magpie 网关连接。</p>
<section><h2>已保存连接</h2><div id="connections"></div></section>
<form id="add"><h2>添加连接</h2><label>连接名称<input name="name" maxlength="80" required autocomplete="off"></label><label>Magpie 网关地址<input name="address" type="url" placeholder="https://example.com/magpie-gateway/v1" required autocomplete="off"></label><p class="hint">支持网关根地址或 /v1 地址。</p><label>Gateway key<input name="key" type="password" minlength="8" maxlength="256" required autocomplete="off"></label>
<button type="submit">保存连接</button></form><p id="status" role="status"></p><p class="hint">完成后返回看板。</p></div>`;
let csrf = '', busy = false;
const status = (text: string) => { document.getElementById('status')!.textContent = text; };
const disable = (value: boolean) => {
  busy = value;
  root.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button').forEach(el => { el.disabled = value || el.dataset.active === 'true'; });
};
async function load() {
  const r = await fetch('/api/connections'); const body = await r.json();
  if (!r.ok) throw Error(body.error ?? '连接列表读取失败。');
  csrf = body.csrf; const list = document.getElementById('connections')!; list.replaceChildren();
  for (const connection of body.connections as Connection[]) {
    const row = document.createElement('article'), title = document.createElement('strong'), address = document.createElement('p');
    title.textContent = connection.name; address.textContent = connection.baseUrl;
    const heading = document.createElement('div'); heading.className = 'connection-heading'; heading.append(title);
    if (body.activeId === connection.id) {
      const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = '当前连接'; heading.append(badge);
    }
    row.append(heading, address);
    const actions = document.createElement('div'); actions.className = 'connection-actions';
    for (const [action, text] of [['select', '切换到此连接'], ['remove', '移除连接']]) {
      const button = document.createElement('button'); button.textContent = text; button.type = 'button';
      if (action === 'select' && body.activeId === connection.id) { button.textContent = '正在使用'; button.disabled = true; button.dataset.active = 'true'; }
      if (action === 'remove') button.className = 'destructive';
      button.addEventListener('click', () => {
        if (action === 'remove' && !window.confirm(`移除「${connection.name}」及其保存的 Key？`)) return;
        void mutate({ action, id: connection.id });
      }); actions.append(button);
    }
    row.append(actions);
    list.append(row);
  }
  if (!list.children.length) list.textContent = '尚未保存连接。';
}
async function mutate(body: Record<string, unknown>) {
  if (busy) return; disable(true); status('正在处理，请稍候…');
  try {
    const r = await fetch('/api/connections', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) });
    const result = await r.json(); if (!r.ok) throw Error(result.error ?? '操作失败。');
    await load(); status('连接已更新。');
  } catch (e) {
    status(e instanceof Error ? e.message : '操作失败。');
    try { await load(); } catch { /* Preserve the operation error. */ }
  } finally { disable(false); }
}
document.getElementById('add')!.addEventListener('submit', event => {
  event.preventDefault(); if (busy) return;
  const form = event.target as HTMLFormElement, values = new FormData(form);
  const body = { action: 'add', name: values.get('name'), address: values.get('address'), key: values.get('key') };
  (form.elements.namedItem('key') as HTMLInputElement).value = '';
  void mutate(body);
});
history.replaceState(null, '', '/connect');
disable(true); void load().then(() => disable(false)).catch(() => status('页面授权或本机存储不可用，请从看板重新打开。'));
