import { build } from 'esbuild';
import { watch } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const periods = ['today', '7d', '30d', 'all'];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function buildPage(root, kind) {
  const widget = kind === 'widget';
  const bundle = await build({
    absWorkingDir: root, entryPoints: [widget ? 'widget/main.ts' : 'local/connect-client.ts'],
    bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022',
    minify: true, charset: 'utf8', logLevel: 'silent', loader: { '.svg': 'text' },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const css = await readFile(join(root, widget ? 'widget/style.css' : 'local/connect-style.css'), 'utf8');
  const js = bundle.outputFiles[0].text.replaceAll('</script', '<\\/script');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Magpie ${widget ? '额度看板' : '安全连接'}</title><style>${css}</style></head><body><main id="app"></main><script>${js}</script></body></html>`;
}

function hostPage(route, version) {
  return `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Magpie · 真实数据开发预览</title><style>
body{margin:0;background:#fcfdfc;color:#243a34;font:14px sans-serif}iframe{display:block;width:100%;height:100vh;border:0}
#status{position:fixed;bottom:16px;left:16px;z-index:1;padding:10px 16px;border-radius:10px;background:#fff6e8;box-shadow:0 2px 12px #0001}
</style><div id="status" role="status" ${version ? 'hidden' : ''}>正在构建开发预览…</div><iframe src="${route}/widget" title="真实数据看板"></iframe><script>
const frame=document.querySelector('iframe'),status=document.getElementById('status');
const updates=new EventSource('${route}/events');
updates.onmessage=e=>{const state=JSON.parse(e.data);if(state.version!==${version}){location.reload();return;}
status.hidden=!state.building&&!state.error;status.textContent=state.error||'代码已变化，正在更新…';};
updates.onerror=()=>{status.hidden=false;status.textContent='开发服务连接中断，正在重连…';};
window.addEventListener('pagehide',()=>updates.close(),{once:true});
window.addEventListener('message',async e=>{
 if(e.origin!==location.origin||e.source!==frame.contentWindow||!e.data)return;
 const m=e.data;
 if(m.method==='ui/initialize'){e.source.postMessage({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2026-01-26',hostInfo:{name:'Magpie development preview',version:'1'},hostCapabilities:{serverTools:{}},hostContext:{displayMode:'fullscreen',availableDisplayModes:['fullscreen']}}},location.origin);return;}
 if(m.method!=='tools/call')return;
 try{const response=await fetch('${route}/tool',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(m.params)});
 if(!response.ok)throw Error();const result=await response.json();e.source.postMessage({jsonrpc:'2.0',id:m.id,result},location.origin);}
 catch{e.source.postMessage({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:'读取失败；连接管理请从已安装插件打开。'}},location.origin);}
});
</script></html>`;
}

export async function startLivePreview({ root = projectRoot, dataDirectory = process.env.MAGPIE_QUOTA_DATA_DIR, log = console.log } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'magpie-ui-dev-'));
  const route = `/${randomUUID()}`, events = new Set(), watchers = [];
  const state = { version: 0, building: true, error: '' };
  let active = null, origin = '', closed = false, dirty = true, timer, pending = null, attempt = 0;
  const publish = () => { for (const response of events) response.write(`data: ${JSON.stringify(state)}\n\n`); };
  const json = (res, code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };

  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) {
      res.writeHead(403).end(); return;
    }
    if (req.method === 'GET') {
      if ([route, `${route}/`].includes(req.url)) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(hostPage(route, state.version)); return;
      }
      if (req.url === `${route}/widget`) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(active?.html ?? '<!doctype html><html lang="zh-CN"><title>正在构建</title></html>'); return;
      }
      if (req.url === `${route}/status`) { json(res, 200, state); return; }
      if (req.url === `${route}/events`) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        res.write(`retry: 1000\ndata: ${JSON.stringify(state)}\n\n`);
        events.add(res); res.once('close', () => events.delete(res)); return;
      }
    }
    if (req.method !== 'POST' || req.url !== `${route}/tool` || req.headers.origin !== origin ||
        req.headers['content-type'] !== 'application/json') { res.writeHead(404).end(); return; }
    const current = active, abort = new AbortController();
    res.once('close', () => abort.abort());
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk; if (Buffer.byteLength(body) > 1024) { json(res, 413, { error: '请求过大。' }); return; }
      }
      const params = JSON.parse(body);
      if (!isObject(params)) throw Error();
      const args = params.arguments ?? {};
      if (!['open_quota_dashboard', 'get_connection_state'].includes(params.name) ||
          Object.keys(params).some(key => !['name', 'arguments', '_meta'].includes(key)) || !isObject(args)) throw Error();
      if (Object.keys(args).some(key => params.name !== 'open_quota_dashboard' || key !== 'period') ||
          (args.period !== undefined && !periods.includes(args.period))) throw Error();
      if (!current) { json(res, 503, { error: '正在构建开发预览。' }); return; }
      const result = await current.client.callTool({ name: params.name, arguments: args }, undefined, { signal: abort.signal, timeout: 25000 });
      // 重建过程中完成的旧请求不能回填新一版页面。
      if (current !== active) { json(res, 409, { error: '页面已更新，请重试。' }); return; }
      if (!res.destroyed) json(res, 200, result);
    } catch { if (!res.destroyed) json(res, 400, { error: '读取失败，请重试。' }); }
  });

  async function rebuild() {
    state.building = true; state.error = ''; publish();
    const outfile = join(directory, `server-${++attempt}.mjs`);
    let client;
    try {
      const [widget, connect] = await Promise.all([buildPage(root, 'widget'), buildPage(root, 'connect')]);
      // 虚拟模块避免改写仓库 generated/ 和 dist/，可与常规构建并行。
      await build({
        absWorkingDir: root, entryPoints: ['local/main.ts'], outfile, bundle: true,
        platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', loader: { '.svg': 'text' },
        banner: { js: "import { createRequire as __createRequire } from 'node:module';const require = __createRequire(import.meta.url);" },
        plugins: [{ name: 'preview-ui', setup(builder) {
          builder.onLoad({ filter: /[/\\]generated[/\\]local-(widget|connect)\.ts$/ }, args => ({
            contents: args.path.endsWith('local-widget.ts')
              ? `export const localWidgetHtml = ${JSON.stringify(widget)};`
              : `export const localConnectHtml = ${JSON.stringify(connect)};`,
            loader: 'ts',
          }));
        } }],
      });
      if (closed || dirty) return;
      client = new Client({ name: 'magpie-live-development', version: '1' }, { capabilities: {} });
      const transport = new StdioClientTransport({
        command: process.execPath, args: [outfile], cwd: root, stderr: 'pipe',
        ...(dataDirectory ? { env: { MAGPIE_QUOTA_DATA_DIR: dataDirectory } } : {}),
      });
      const connected = client.connect(transport, { timeout: 10000 });
      transport.stderr?.on('data', () => {});
      await connected;
      const resource = await client.readResource({ uri: 'ui://magpie/quota-dashboard' }, { timeout: 10000 });
      const html = resource.contents[0]?.text;
      if (typeof html !== 'string') throw Error();
      if (closed || dirty) return;
      const previous = active;
      active = { client, html, outfile };
      state.version++; state.building = false; state.error = '';
      publish(); log(`开发预览已更新（第 ${state.version} 版）。`);
      if (previous) { await previous.client.close().catch(() => {}); await rm(previous.outfile, { force: true }); }
    } catch (error) {
      state.building = false; state.error = '构建失败，请修复后保存重试；保留上次成功预览。';
      publish(); log(state.error);
      for (const issue of error.errors ?? []) {
        const location = issue.location;
        log(`${location ? `${location.file}:${location.line}:${location.column + 1} ` : ''}${issue.text}`);
      }
    } finally {
      if (active?.client !== client || !client) {
        await client?.close().catch(() => {}); await rm(outfile, { force: true });
      }
    }
  }
  function run() {
    if (pending || closed) return pending;
    pending = (async () => { while (dirty && !closed) { dirty = false; await rebuild(); } })()
      .finally(() => { pending = null; });
    return pending;
  }
  function changed() {
    if (closed) return;
    dirty = true; clearTimeout(timer); timer = setTimeout(() => { void run(); }, 150);
  }
  async function close() {
    if (closed) return;
    closed = true; clearTimeout(timer); watchers.forEach(watcher => watcher.close());
    for (const response of events) response.end();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await pending;
    await active?.client.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    for (const source of ['widget', 'local', 'lib', 'plugins/magpie-quota-local/assets']) watchers.push(watch(join(root, source), { recursive: true }, changed));
    watchers.push(watch(root, (_, file) => { if (['package.json', 'package-lock.json'].includes(String(file))) changed(); }));
    for (const watcher of watchers) watcher.on('error', () => { state.error = '源码监听失败，请重启开发预览。'; publish(); });
    void run();
    return { url: `${origin}${route}/`, close };
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const preview = await startLivePreview();
    console.log(`真实数据开发预览：${preview.url}`);
    console.log('监听看板、连接页、后台与图标源码；保存后自动更新。按 Ctrl+C 停止。');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void preview.close(); });
  } catch { console.error('开发预览启动失败，请检查依赖与运行环境。'); process.exitCode = 1; }
}
