import { GatewayError, readGateway } from './gateway';
import type { PersonalUsage, Quota, UsageTotals } from './types';
import { isUsagePeriod, type UsagePeriod } from './types';

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GatewayError('contract', '用量接口结构与已确认契约不符。');
  return value as Record<string, unknown>;
};
const numeric = (value: unknown, integer = true): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && (!integer || Number.isSafeInteger(value)) ? value : null;
function totals(value: unknown): UsageTotals {
  const o = object(value);
  const input = numeric(o.input), output = numeric(o.output), cacheRead = numeric(o.cache_read), cacheWrite = numeric(o.cache_write);
  const parts = [input, output, cacheRead, cacheWrite];
  const sum = parts.every(v => v !== null) ? parts.reduce<number>((sum, v) => sum + v!, 0) : null;
  return { calls: numeric(o.calls), input, output, cacheRead, cacheWrite, tokens: numeric(sum),
    cost: numeric(o.cost, false), unpriced: numeric(o.unpriced) };
}

/** 只投影汇总与模型 ID；请求行、账号、会话、错误和路径均不进入结果。 */
export function parsePersonalUsage(value: unknown, key: string, period: UsagePeriod = 'today'): PersonalUsage {
  const o = object(value), by = object(o.by);
  if (!isUsagePeriod(period) || o.period !== period || o.offset !== 0 || numeric(o.total) === null || !Array.isArray(o.rows) || o.rows.length > 1 ||
      !Array.isArray(by.model) || by.model.length > 1000) throw new GatewayError('contract', '服务器没有返回所选时间范围的完整模型用量汇总。');
  const seen = new Set<string>();
  const models = by.model.map(value => {
    const m = object(value), id = m.id;
    if (typeof id !== 'string' || (id !== '' && !id.trim()) || id.length > 300 || id.includes(key) || /[\x00-\x1f\x7f]/.test(id) || seen.has(id)) {
      throw new GatewayError('contract', '服务器返回了无法安全展示的模型标识。');
    }
    seen.add(id);
    return { id, ...totals(m) };
  });
  const total = totals(o);
  // 完整 by.model 汇总覆盖整个筛选范围，不能将分页请求行当成总量。
  for (const field of ['calls', 'input', 'output', 'cacheRead', 'cacheWrite'] as const) {
    if (total[field] !== null && models.every(m => m[field] !== null) &&
        models.reduce((sum, m) => sum + m[field]!, 0) !== total[field]) {
      throw new GatewayError('contract', '模型汇总与总用量不一致，暂不展示不完整统计。');
    }
  }
  return { period, scope: 'current-key', source: 'through', totals: total, models };
}

export async function readPersonalUsage(baseUrl: string, key: string, quota: Quota, period: UsagePeriod = 'today'): Promise<PersonalUsage> {
  const deadline = Date.now() + 10000;
  if (!quota.limited) {
    try {
      await readGateway(baseUrl, key, 'usageScope', Math.max(1, deadline - Date.now()), period);
      // Key 名称不唯一，不能借 callerKeys 的名称反推身份。
      throw new GatewayError('usage_scope_unknown', '未受限 Key 暂不支持个人用量统计。');
    } catch (error) {
      if (!(error instanceof GatewayError) || error.code !== 'usage_key_scoped') throw error;
    }
  }
  return parsePersonalUsage(await readGateway(baseUrl, key, 'usageRequests', Math.max(1, deadline - Date.now()), period), key, period);
}
