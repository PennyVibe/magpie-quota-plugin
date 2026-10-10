import type { Connection } from '../lib/types';
const root = document.getElementById('app')!;
root.innerHTML = `<div class="shell"><p class="eyebrow">MAGPIE / LOCAL CONNECTION</p><h1>连接你的网关</h1><p>只需服务器分配给你的 Gateway key。由插件后台验证并读取个人额度。</p>
<div class="notice">Key 以明文保存在当前系统用户目录的独立 JSON 文件中（目录 0700、文件 0600）；有读取权限的本机程序可以取得 Key。HTTP 连接按原协议发送，请仅在可信网络使用。</div>
<section><h2>已保存连接</h2><div id="connections"></div></section>
<form id="add"><h2>添加连接</h2><label>连接名称<input name="name" maxlength="80" required autocomplete="off"></label><label>Magpie 网关地址<input name="address" type="url" placeholder="https://example.com/magpie-gateway/v1" required autocomplete="off"></label><p class="hint">根地址或以 /v1 结尾的 OpenAI Base URL 均可，部署路径前缀会保留。</p><label>Gateway key<input name="key" type="password" minlength="8" maxlength="256" required autocomplete="off"></label>
<label class="choice"><input name="upstream" type="checkbox">开启共享供应商额度展示</label><p class="hint">可覆盖远端所有账号，未按当前 Key 过滤。只读服务器缓存卡片，隐藏账号标识，不作为你的个人用量。</p>
<button type="submit">验证 /limit 并保存连接</button></form><p id="status" role="status"></p><p class="hint">完成后返回看板刷新。页面授权 10 分钟后过期。</p></div>`;
let csrf = '', busy = false;
const status = (text: string) => { document.getElementById('status')!.textContent = text; };
const disable = (value: boolean) => {
  busy = value;
  root.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button').forEach(el => { el.disabled = value; });
};
async function load() {
  const r = await fetch('/api/connections'); const body = await r.json();
  if (!r.ok) throw Error(body.error ?? '连接列表读取失败。');
  csrf = body.csrf; const list = document.getElementById('connections')!; list.replaceChildren();
  for (const connection of body.connections as (Connection & { upstreamEnabled: boolean })[]) {
    const row = document.createElement('article'), title = document.createElement('strong'), address = document.createElement('p');
    title.textContent = `${connection.name}${body.activeId === connection.id ? ' · 当前连接' : ''}`; address.textContent = connection.baseUrl;
    row.append(title, address);
    const toggle = document.createElement('button'); toggle.type = 'button';
    toggle.textContent = connection.upstreamEnabled ? '关闭共享供应商额度' : '开启共享供应商额度';
    toggle.addEventListener('click', () => {
      if (!connection.upstreamEnabled && !window.confirm('这会读取服务器共享供应商卡片，可能覆盖多个账号，未按你的 Key 权限过滤。确认开启？')) return;
      void mutate({ action: 'upstream', id: connection.id, enabled: !connection.upstreamEnabled });
    }); row.append(toggle);
    for (const [action, text] of [['select', '切换到此连接'], ['remove', '移除连接']]) {
      const button = document.createElement('button'); button.textContent = text; button.type = 'button';
      button.addEventListener('click', () => {
        if (action === 'remove' && !window.confirm(`移除「${connection.name}」及其保存的 Key？`)) return;
        void mutate({ action, id: connection.id });
      }); row.append(button);
    }
    list.append(row);
  }
  if (!list.children.length) list.textContent = '尚未保存连接。';
}
async function mutate(body: Record<string, unknown>) {
  if (busy) return; disable(true); status('正在处理，请稍候…');
  try {
    const r = await fetch('/api/connections', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) });
    const result = await r.json(); if (!r.ok) throw Error(result.error ?? '操作失败。');
    await load(); status('连接已更新。请返回看板；原连接的数据会清空。');
  } catch (e) {
    status(e instanceof Error ? e.message : '操作失败。');
    try { await load(); } catch { /* Preserve the operation error. */ }
  } finally { disable(false); }
}
document.getElementById('add')!.addEventListener('submit', event => {
  event.preventDefault(); if (busy) return;
  const form = event.target as HTMLFormElement, values = new FormData(form);
  const body = { action: 'add', name: values.get('name'), address: values.get('address'), key: values.get('key'), upstreamEnabled: values.get('upstream') === 'on' };
  (form.elements.namedItem('key') as HTMLInputElement).value = '';
  void mutate(body);
});
history.replaceState(null, '', '/connect');
disable(true); void load().then(() => disable(false)).catch(() => status('页面授权或本机存储不可用，请从看板重新打开。'));
