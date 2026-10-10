import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import { OpenAIExtensions } from '@openai/mcp-extensions/app';
import type { Snapshot } from '../lib/types';
import { PanelController } from './controller';
import { countdown, escape, renderSnapshot } from './view';
const root = document.getElementById('app')!;
const app = window.parent !== window ? new App({ name: 'Magpie 额度看板', version: '0.1.0' },
  { availableDisplayModes: ['fullscreen'] }, { autoResize: false }) : null;
if (app) new OpenAIExtensions(app);
let alive = true, ready = false, busy = false, managing = false, transportError = false, snapshot: Snapshot | null = null;
let revision: string | null = null, connectUrl = '', note = '', polling = false;
let pollTimer: ReturnType<typeof setInterval> | null = null, tickTimer: ReturnType<typeof setInterval> | null = null;
let manageAbort: AbortController | null = null, pollAbort: AbortController | null = null, uiEpoch = 0;
const visible = () => document.visibilityState !== 'hidden';
function urlFromMeta(meta: Record<string, unknown> | undefined) {
  const value = meta?.['magpie/connectUrl'];
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && url.pathname === '/connect' &&
        !url.username && !url.password && !url.hash && url.searchParams.size === 1 && /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('bootstrap') ?? '')) connectUrl = url.href;
  } catch { /* Invalid host metadata is ignored. */ }
}
function isSnapshot(v: unknown): v is Snapshot {
  return Boolean(v && typeof v === 'object' && 'revision' in v && typeof v.revision === 'string' && 'quota' in v && 'connection' in v && 'models' in v);
}
function render() {
  root.innerHTML = `<header><div><p class="eyebrow">MAGPIE / PERSONAL ALLOWANCE</p><h1>额度看板</h1></div><div class="actions"><button id="refresh" ${!ready || busy || managing ? 'disabled' : ''}>${busy ? '读取中…' : '刷新'}</button><button id="manage" ${!ready || managing ? 'disabled' : ''}>连接管理 ↗</button></div></header>
    ${!app ? '<div class="notice">请从 Magpie 插件的全屏入口打开看板。</div>' : ''}
    ${note ? `<div class="notice" role="status">${escape(note)}${connectUrl && managing ? `<p><a href="${escape(connectUrl)}" target="_blank" rel="noopener noreferrer">在本机浏览器打开连接页</a></p>` : ''}</div>` : ''}
    ${managing ? '<div class="empty"><h2>正在管理连接</h2><p>旧数据已清空。完成后返回此页面并点击刷新。</p><button id="return">完成，读取当前连接</button></div>' : renderSnapshot(snapshot, transportError)}`;
  root.querySelector('#refresh')?.addEventListener('click', () => { void controller.refresh(); });
  root.querySelector('#manage')?.addEventListener('click', () => { void manage(); });
  root.querySelector('#return')?.addEventListener('click', resume);
}
const controller = new PanelController(async signal => {
  busy = true; render();
  try { return await app!.callServerTool({ name: 'open_quota_dashboard', arguments: {} }, { signal, timeout: 25000 }); }
  finally { busy = false; if (alive) render(); }
}, value => {
  const result = value as { structuredContent?: unknown; _meta?: Record<string, unknown>; transportError?: boolean };
  urlFromMeta(result._meta);
  if (isSnapshot(result.structuredContent)) {
    snapshot = result.structuredContent; revision = snapshot.revision; transportError = false;
  } else transportError = true;
  render();
});
function clearData() { uiEpoch++; controller.invalidate(); snapshot = null; transportError = false; render(); }
async function manage() {
  if (!ready || !alive || managing) return;
  managing = true; clearData(); controller.setVisible(false); manageAbort = new AbortController();
  const epoch = uiEpoch, abort = manageAbort;
  connectUrl = ''; note = '正在准备本机连接入口…'; render();
  try {
    const result = await app!.callServerTool({ name: 'manage_connections', arguments: {} }, { signal: abort.signal, timeout: 10000 });
    if (!alive || epoch !== uiEpoch) return;
    urlFromMeta(result._meta);
    note = result._meta?.['magpie/browserOpen'] === 'requested' ? '已请求打开默认浏览器。完成连接后返回看板。' : '请使用链接在这台电脑的浏览器打开连接页。';
  } catch { if (alive && epoch === uiEpoch) note = '连接入口准备失败，请返回并重试。'; }
  finally { if (alive && epoch === uiEpoch) render(); }
}
function resume() {
  if (!alive || !ready || document.visibilityState === 'hidden') return;
  if (managing) {
    managing = false; manageAbort?.abort(); clearData(); note = ''; controller.setVisible(true);
  } else void controller.refresh();
  render();
}
async function poll() {
  if (polling || !alive || !ready || managing || document.visibilityState === 'hidden') return;
  polling = true; const epoch = uiEpoch, abort = new AbortController(); pollAbort = abort;
  try {
    const result = await app!.callServerTool({ name: 'get_connection_state', arguments: {} }, { signal: abort.signal, timeout: 5000 });
    if (!alive || epoch !== uiEpoch || !visible()) return;
    const next = result._meta?.['magpie/revision'];
    if (result.isError) { clearData(); note = '无法确认连接状态，旧数据已清空。'; render(); }
    else if (typeof next === 'string' && revision !== null && revision !== next) {
      revision = next; clearData(); note = '连接已变化，正在读取当前连接。'; void controller.refresh();
    }
  } catch { /* Quota transport failures are reported by the read owner. */ }
  finally { polling = false; if (pollAbort === abort) pollAbort = null; }
}
function activity() {
  if (pollTimer) clearInterval(pollTimer); if (tickTimer) clearInterval(tickTimer);
  pollTimer = tickTimer = null;
  const visible = document.visibilityState !== 'hidden';
  if (!visible) { pollAbort?.abort(); manageAbort?.abort(); uiEpoch++; controller.setVisible(false); return; }
  if (alive && ready) {
    if (!managing) controller.setVisible(true);
    pollTimer = setInterval(() => { void poll(); }, 1000);
    tickTimer = setInterval(() => { const el = root.querySelector('#countdown'); if (el) el.textContent = countdown(snapshot?.quota?.reset ?? null); }, 1000);
  }
}
function stop() {
  if (!alive) return; alive = false; uiEpoch++; controller.stop(); pollAbort?.abort(); manageAbort?.abort();
  if (pollTimer) clearInterval(pollTimer); if (tickTimer) clearInterval(tickTimer);
  document.removeEventListener('visibilitychange', activity); window.removeEventListener('focus', resume);
}
window.addEventListener('pagehide', () => { stop(); void app?.close(); }, { once: true });
window.addEventListener('beforeunload', stop, { once: true });
window.addEventListener('pageshow', e => { if (e.persisted) window.location.reload(); });
document.addEventListener('visibilitychange', activity); window.addEventListener('focus', resume);
render();
if (app) {
  app.onteardown = async () => { stop(); return {}; };
  const theme = (context: ReturnType<App['getHostContext']>) => {
    try { if (context?.theme) applyDocumentTheme(context.theme); if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables); } catch { /* Host presentation is optional. */ }
  };
  app.onhostcontextchanged = theme;
  void app.connect().then(() => {
    if (!alive) return; ready = true;
    theme(app.getHostContext()); controller.start(false); activity(); render();
    const context = app.getHostContext();
    if (context?.displayMode === 'inline' && context.availableDisplayModes?.includes('fullscreen')) void app.requestDisplayMode({ mode: 'fullscreen' }).catch(() => {});
  }).catch(() => { if (alive) { note = '宿主连接失败，请重新打开面板。'; render(); } });
}
