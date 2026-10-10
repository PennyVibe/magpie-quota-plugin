import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createQuotaServer } from '../lib/mcp';
import { localWidgetHtml } from '../generated/local-widget';
import { localConnectHtml } from '../generated/local-connect';
import { ConnectionStore } from './store';
import { Runtime } from './runtime';
import { ConnectServer } from './connect-server';
import { compatibleRuntime, runtimeRequirement } from './runtime-support.cjs';
async function main() {
  if (!compatibleRuntime(process.platform, process.versions)) throw Error(runtimeRequirement(process.platform));
  const store = new ConnectionStore(), runtime = new Runtime(store);
  const connector = await new ConnectServer(store, runtime, localConnectHtml).start();
  const server = createQuotaServer(runtime, connector, localWidgetHtml);
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await connector.close(); await server.close(); };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void close().finally(() => process.exit(0)); });
  process.stdin.once('end', () => { void close(); });
  await server.connect(new StdioServerTransport());
}
void main().catch(() => { process.stderr.write('Magpie 额度看板无法启动，请检查运行时或本机存储。\n'); process.exitCode = 1; });
