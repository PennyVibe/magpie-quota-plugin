import { parseModels, parseQuota, parseUpstreamCards, problem, readGateway } from '../lib/gateway';
import type { Snapshot } from '../lib/types';
import { ConnectionStore, publicConnection } from './store';

export class Runtime {
  private cache: Snapshot | null = null;
  private pending: { revision: string; promise: Promise<Snapshot> } | null = null;
  constructor(readonly store: ConnectionStore) {}
  invalidate() { this.cache = null; this.pending = null; }
  async snapshot(include: 'all' | 'dashboard' | 'quota' | 'models' | 'cards' = 'all'): Promise<Snapshot> {
    const state = await this.store.read(), connection = state.connections.find(c => c.id === state.activeId);
    if (this.cache?.revision !== state.revision) this.cache = null;
    if (!connection) return { revision: state.revision, connection: null, quota: null, models: null, quotaReadAt: null, modelsReadAt: null,
      quotaError: { code: 'not_connected', message: '请在本机连接页添加并选择连接。' }, modelsError: null, stale: false };
    // A single owner coalesces concurrent dashboard/model/quota calls.
    if (this.pending?.revision === state.revision) {
      await this.pending.promise;
      return this.snapshot(include);
    }
    const snapshot: Snapshot = this.cache ? structuredClone(this.cache) : { revision: state.revision,
      connection: publicConnection(connection), quota: null, models: null, quotaReadAt: null, modelsReadAt: null, quotaError: null, modelsError: null, stale: false };
    snapshot.upstreamEnabled = connection.upstreamEnabled === true;
    if (!snapshot.upstreamEnabled) { snapshot.upstreamCards = null; snapshot.upstreamReadAt = null; snapshot.upstreamError = null; }
    const read = async () => {
      const tasks: Promise<void>[] = [];
      if (include === 'all' || include === 'dashboard' || include === 'quota') tasks.push((async () => {
        try { snapshot.quota = parseQuota(await readGateway(connection.baseUrl, connection.key, 'limit')); snapshot.quotaReadAt = new Date().toISOString(); snapshot.quotaError = null; }
        catch (e) { snapshot.quotaError = problem(e); }
      })());
      if (include === 'all' || include === 'models') tasks.push((async () => {
        try { snapshot.models = parseModels(await readGateway(connection.baseUrl, connection.key, 'models'), connection.key); snapshot.modelsReadAt = new Date().toISOString(); snapshot.modelsError = null; }
        catch (e) { snapshot.modelsError = problem(e); }
      })());
      if ((include === 'all' || include === 'dashboard' || include === 'cards') && snapshot.upstreamEnabled) tasks.push((async () => {
        try { snapshot.upstreamCards = parseUpstreamCards(await readGateway(connection.baseUrl, connection.key, 'cards'), connection.key);
          snapshot.upstreamReadAt = new Date().toISOString(); snapshot.upstreamError = null; }
        catch (e) { snapshot.upstreamError = problem(e); }
      })());
      else if (include === 'cards' && !snapshot.upstreamEnabled) snapshot.upstreamError = { code: 'upstream_disabled', message: '请先在本机连接页明确开启共享供应商额度展示。' };
      await Promise.all(tasks);
      const current = await this.store.read();
      if (current.revision !== state.revision) {
        this.invalidate();
        return { ...snapshot, revision: current.revision, connection: null, quota: null, models: null, quotaReadAt: null, modelsReadAt: null,
          quotaError: { code: 'connection_changed', message: '连接已变更，旧响应已丢弃，请重新读取。' }, modelsError: null,
          upstreamEnabled: false, upstreamCards: null, upstreamReadAt: null, upstreamError: null, stale: false };
      }
      snapshot.stale = Boolean((snapshot.quotaError && snapshot.quota) || (snapshot.modelsError && snapshot.models) || (snapshot.upstreamError && snapshot.upstreamCards));
      this.cache = snapshot;
      if (include === 'dashboard') return { ...snapshot, models: null, modelsReadAt: null, modelsError: null,
        stale: Boolean((snapshot.quotaError && snapshot.quota) || (snapshot.upstreamError && snapshot.upstreamCards)) };
      return snapshot;
    };
    const pending = { revision: state.revision, promise: read() };
    this.pending = pending;
    try { return await pending.promise; } finally { if (this.pending === pending) this.pending = null; }
  }
}
