import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectionStore } from '../local/store';
export const keyA = 'synthetic-gateway-alpha', keyB = 'synthetic-gateway-beta';
export const quotaFixture = (overrides: Record<string, unknown> = {}) => ({
  limited: true, key: 'Synthetic user', limit: {
    period: 'week', start: '2026-10-05T00:00:00+08:00', reset: '2026-10-12T00:00:00+08:00',
    calls: 3, tokens: 30, cost: 0.125, tokenLimit: 100, costLimit: 2, tokensLeft: 70, costLeft: 1.875, spent: false, ...overrides,
  },
});
export const usageFixture = () => {
  const totals = { calls: 3, errors: 0, input: 1000, output: 200, cache_read: 600, cache_write: 100,
    cache_write_1h: 50, reasoning: 80, cost: .25, unpriced: 1 };
  return { ...totals, period: 'today', offset: 0, total: 3, rows: [{ account: 'private-account', session: 'private-session', error: keyA }],
    through: totals, direct: { ...totals, input: 99999 }, callerKeys: [{ id: 'private-key-id', name: 'Private name' }],
    accounts: [{ id: 'private-account' }], by: { model: [
      { id: 'model-alpha', ...totals, calls: 2, input: 800, output: 150, cache_read: 500, cache_write: 100, cost: .1 },
      { id: 'model-beta', ...totals, calls: 1, input: 200, output: 50, cache_read: 100, cache_write: 0, cost: .15, unpriced: 0 },
    ] } };
};
export function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
export async function mockServer(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error();
  return { origin: `http://127.0.0.1:${address.port}`, close: async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
export function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data));
}
export async function temporaryStore() {
  const directory = await mkdtemp(join(tmpdir(), 'magpie-quota-test-'));
  const store = new ConnectionStore(join(directory, 'data'));
  return { store, directory, close: () => rm(directory, { recursive: true, force: true }) };
}
