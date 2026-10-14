import { GatewayError, parseModels, parseQuota, problem, readGateway } from '../lib/gateway';
import { isUsagePeriod, type Snapshot, type UsagePeriod } from '../lib/types';
import { readPersonalUsage } from '../lib/usage';
import { ConnectionStore, publicConnection } from './store';

export class Runtime {
  private cache: Snapshot | null = null;
  private pending: { revision: string; promise: Promise<Snapshot> } | null = null;
  constructor(readonly store: ConnectionStore) {}
  invalidate() { this.cache = null; this.pending = null; }
  async snapshot(include: 'dashboard' | 'quota' | 'models', period: UsagePeriod = 'today'): Promise<Snapshot> {
    if (!isUsagePeriod(period)) throw new GatewayError('usage_period', '请选择支持的用量时间范围。');
    const state = await this.store.read(), connection = state.connections.find(c => c.id === state.activeId);
    if (this.cache?.revision !== state.revision) this.cache = null;
    if (!connection) return { revision: state.revision, connection: null, quota: null, models: null, quotaReadAt: null, modelsReadAt: null,
      quotaError: { code: 'not_connected', message: '请在本机连接页添加并选择连接。' }, modelsError: null, stale: false };
    // 串行更新同一连接的缓存，避免不同读取入口相互覆盖。
    if (this.pending?.revision === state.revision) {
      await this.pending.promise;
      return this.snapshot(include, period);
    }
    const snapshot: Snapshot = this.cache ? structuredClone(this.cache) : { revision: state.revision,
      connection: publicConnection(connection), quota: null, models: null, quotaReadAt: null, modelsReadAt: null, quotaError: null, modelsError: null, stale: false };
    // 其他时间范围的缓存不能作为当前选择的旧数据。
    if (include === 'dashboard' && snapshot.usage?.period !== period) {
      snapshot.usage = null; snapshot.usageReadAt = null; snapshot.usageError = null;
    }
    const read = async () => {
      const tasks: Promise<void>[] = [];
      if (include === 'dashboard' || include === 'quota') tasks.push((async () => {
        let quota;
        try { quota = parseQuota(await readGateway(connection.baseUrl, connection.key, 'limit')); snapshot.quota = quota; snapshot.quotaReadAt = new Date().toISOString(); snapshot.quotaError = null; }
        catch (e) { snapshot.quotaError = problem(e); }
        if (include === 'dashboard') {
          if (!quota) {
            snapshot.usageError = { code: 'usage_identity_unconfirmed', message: '当前读取未确认 Key 身份，个人模型用量暂不可用。' };
            snapshot.usage = null; snapshot.usageReadAt = null;
          } else try {
            snapshot.usage = await readPersonalUsage(connection.baseUrl, connection.key, quota, period);
            snapshot.usageReadAt = new Date().toISOString(); snapshot.usageError = null;
          } catch (e) {
            snapshot.usageError = problem(e);
            if (['usage_scope_unknown', 'forbidden', 'invalid_key'].includes(snapshot.usageError.code)) {
              snapshot.usage = null; snapshot.usageReadAt = null;
            }
          }
        }
      })());
      if (include === 'models') tasks.push((async () => {
        try { snapshot.models = parseModels(await readGateway(connection.baseUrl, connection.key, 'models'), connection.key); snapshot.modelsReadAt = new Date().toISOString(); snapshot.modelsError = null; }
        catch (e) { snapshot.modelsError = problem(e); }
      })());
      await Promise.all(tasks);
      const current = await this.store.read();
      if (current.revision !== state.revision) {
        this.invalidate();
        return { ...snapshot, revision: current.revision, connection: null, quota: null, models: null, quotaReadAt: null, modelsReadAt: null,
          quotaError: { code: 'connection_changed', message: '连接已变更，旧响应已丢弃，请重新读取。' }, modelsError: null,
          usage: null, usageReadAt: null, usageError: null, stale: false };
      }
      snapshot.stale = Boolean((snapshot.quotaError && snapshot.quota) || (snapshot.modelsError && snapshot.models) || (snapshot.usageError && snapshot.usage));
      this.cache = snapshot;
      if (include === 'dashboard') return { ...snapshot, models: null, modelsReadAt: null, modelsError: null,
        stale: Boolean((snapshot.quotaError && snapshot.quota) || (snapshot.usageError && snapshot.usage)) };
      return snapshot;
    };
    const pending = { revision: state.revision, promise: read() };
    this.pending = pending;
    try { return await pending.promise; } finally { if (this.pending === pending) this.pending = null; }
  }
}
