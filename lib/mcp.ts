import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { OpenAIExtensions } from '@openai/mcp-extensions/server';
import { z } from 'zod';
import { problem } from './gateway';
import type { Runtime } from '../local/runtime';
import type { ConnectServer } from '../local/connect-server';
import { openConnectionBrowser } from '../local/browser';
export const RESOURCE_URI = 'ui://magpie/quota-dashboard';
export function createQuotaServer(runtime: Runtime, connector: ConnectServer, widgetHtml: string) {
  const server = new McpServer({ name: 'Magpie 额度看板', version: '0.1.0' });
  new OpenAIExtensions(server);
  registerAppResource(server, 'Magpie 额度看板', RESOURCE_URI, {}, async () => ({
    contents: [{ uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: widgetHtml,
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } },
        'openai/ui': { preferredDisplayMode: 'fullscreen', availableDisplayModes: ['fullscreen'] } } }],
  }));
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  const run = async (include: 'all' | 'dashboard' | 'quota' | 'models' | 'cards') => {
    try {
      const data = await runtime.snapshot(include);
      // Host connection URL belongs to this result object only.
      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data,
        _meta: { 'magpie/connectUrl': connector.issueConnectionUrl() } };
    } catch (e) {
      const data = { ok: false, error: problem(e) };
      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data, isError: true,
        _meta: { 'magpie/connectUrl': connector.issueConnectionUrl() } };
    }
  };
  registerAppTool(server, 'open_quota_dashboard', {
    title: 'Magpie 额度看板', description: '打开看板，只读查询已保存连接的 Gateway key 自身额度，以及用户开启后的共享供应商额度。不自动读取模型列表。首次或切换连接请在本机连接页亲自填写地址和 Key。',
    inputSchema: z.object({}).strict(), annotations,
    _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ['app', 'model'] }, 'openai/ui': { entrypoints: [{ type: 'global' }] } },
  }, () => run('dashboard'));
  server.registerTool('get_my_gateway_quota', {
    title: '查询我的 Gateway key 额度', description: '只读取当前已保存连接 Key 的限额。美元费用是估算值；未设限与接口不支持分别显示。',
    inputSchema: z.object({}).strict(), annotations,
  }, () => run('quota'));
  server.registerTool('list_available_models', {
    title: '查询可用模型', description: '只读取当前已保存连接 Key 的可用模型，不发起推理。',
    inputSchema: z.object({}).strict(), annotations,
  }, () => run('models'));
  server.registerTool('get_upstream_quota_cards', {
    title: '查询远端共享供应商额度', description: '只读服务器缓存的共享供应商额度卡片，仅在用户于连接页开启后可读取。未按当前 Gateway key 的账号权限过滤，不代表个人使用量；不主动刷新供应商。',
    inputSchema: z.object({}).strict(), annotations,
  }, () => run('cards'));
  registerAppTool(server, 'manage_connections', {
    title: '打开本机连接管理', description: '仅供用户在看板打开连接管理页；地址和 Key 由用户亲自填写。',
    inputSchema: z.object({}).strict(), annotations,
    _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ['app'] } },
  }, async () => {
    const url = connector.issueConnectionUrl();
    const opened = await openConnectionBrowser(url, connector.origin);
    return { content: [{ type: 'text', text: '本机连接管理入口已准备。请在浏览器中亲自管理连接。' }],
      _meta: { 'magpie/connectUrl': url, 'magpie/browserOpen': opened ? 'requested' : 'failed' } };
  });
  // Local identity polling clears a mounted view after changes in another browser/instance.
  registerAppTool(server, 'get_connection_state', {
    title: '读取本机连接状态', description: '仅供面板检查本机连接版本；不读取远端。',
    inputSchema: z.object({}).strict(), annotations, _meta: { ui: { visibility: ['app'], resourceUri: RESOURCE_URI } },
  }, async () => {
    try { const state = await runtime.store.read(); return { content: [], _meta: { 'magpie/revision': state.revision } }; }
    catch { return { content: [], isError: true }; }
  });
  return server;
}
