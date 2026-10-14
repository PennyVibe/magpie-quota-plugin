import type { Metric, Problem, Quota } from './types';
import { isUsagePeriod, type UsagePeriod } from './types';

export class GatewayError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export function problem(error: unknown): Problem {
  return error instanceof GatewayError ? { code: error.code, message: error.message } :
    { code: 'unavailable', message: '服务不可达或本机存储不可用，请检查连接后重试。' };
}
export function normalizeAddress(input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new GatewayError('address', '请输入完整 HTTP 或 HTTPS 网关地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      /[\\\s]/.test(input.trim()) || /%(?:2f|5c|00)/i.test(url.pathname)) {
    throw new GatewayError('address', '地址不能包含用户信息、查询参数、片段或编码路径分隔符。');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/v1') ? path : `${path}/v1`;
  return url.href.replace(/\/$/, '');
}
export function validateKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{8,256}$/.test(value)) {
    throw new GatewayError('key', 'Gateway key 必须为 8 至 256 个非空白 ASCII 字符。');
  }
  return value;
}
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new GatewayError('contract', '接口 JSON 结构与已确认契约不符。');
  return v as Record<string, unknown>;
};
const number = (v: unknown, integer = false): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && (!integer || Number.isSafeInteger(v)) ? v : null;
const instant = (v: unknown): string | null =>
  typeof v === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v)) ? v : null;
function metric(o: Record<string, unknown>, cap: string, used: string, left: string, integer: boolean): Metric {
  const limit = number(o[cap], integer);
  // Magpie omits a zero cap; it means this dimension has no cap, not zero allowance.
  const uncapped = o[cap] === undefined || limit === 0;
  return { limit: uncapped ? null : limit, used: number(o[used], integer), remaining: uncapped ? null : number(o[left], integer), uncapped };
}
export function parseQuota(value: unknown): Quota {
  const o = object(value);
  if (typeof o.limited !== 'boolean') throw new GatewayError('contract', '接口缺少 limited 状态，无法判定是否设置限额。');
  // Loopback Magpie permits invalid tokens and answers limited:false with an empty key.
  if (typeof o.key !== 'string' || !o.key.trim()) throw new GatewayError('key_unattributed', '服务器未将请求归属到 Gateway key；无法确认 Key 身份或个人额度。');
  if (!o.limited) return { limited: false, period: null, days: null, start: null, reset: null,
    tokens: { limit: null, used: null, remaining: null, uncapped: true }, cost: { limit: null, used: null, remaining: null, uncapped: true },
    spent: null, cacheReads: null, unpriced: null, calls: null, inFlight: null, reservedTokens: null, reservedCost: null };
  const s = object(o.limit);
  if (typeof s.period !== 'string' || !['day', 'week', 'month', 'days'].includes(s.period)) throw new GatewayError('contract', '服务器返回了未支持的额度窗口。');
  const days = s.period === 'days' ? number(s.days, true) : null;
  if (s.period === 'days' && (days === null || days < 1 || days > 3650)) {
    throw new GatewayError('contract', '服务器返回的额度周期天数必须是 1 至 3650 的整数。');
  }
  const tokens = metric(s, 'tokenLimit', 'tokens', 'tokensLeft', true), cost = metric(s, 'costLimit', 'cost', 'costLeft', false);
  if (tokens.uncapped && cost.uncapped) throw new GatewayError('contract', 'limited 状态与额度上限矛盾，无法确认此版本的限额结构。');
  return { limited: true, period: s.period as Quota['period'], days, start: instant(s.start), reset: instant(s.reset),
    tokens, cost,
    spent: typeof s.spent === 'boolean' ? s.spent : null, cacheReads: typeof s.cacheReads === 'boolean' ? s.cacheReads : null,
    unpriced: number(s.unpriced, true), calls: number(s.calls, true),
    // These fields are omitted for zero in the current budget.Status contract.
    inFlight: number(s.inFlight === undefined ? 0 : s.inFlight, true),
    reservedTokens: number(s.reserved === undefined ? 0 : s.reserved, true),
    reservedCost: number(s.reservedCost === undefined ? 0 : s.reservedCost) };
}
export function parseModels(value: unknown, key: string): string[] {
  const o = object(value);
  if (o.object !== 'list' || !Array.isArray(o.data) || o.data.length > 10000) throw new GatewayError('contract', '模型列表结构与已确认契约不符。');
  return [...new Set(o.data.map(item => object(item).id).filter((id): id is string =>
    typeof id === 'string' && id.length > 0 && id.length <= 300 && !id.includes(key) && !/[\x00-\x1f]/.test(id)))];
}
/** Closed GET allowlist; every redirect is refused before a second request. */
export async function readGateway(baseUrl: string, key: string, endpoint: 'limit' | 'models' | 'usageScope' | 'usageRequests', timeoutMs = 10000, period: UsagePeriod = 'today'): Promise<unknown> {
  if (!isUsagePeriod(period)) throw new GatewayError('usage_period', '请选择支持的用量时间范围。');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const path = { limit: 'magpie/limit', models: 'models',
      usageScope: `magpie/usage?period=${period}`, usageRequests: `magpie/usage/requests?period=${period}&via=through&limit=1&offset=0` }[endpoint];
    const response = await fetch(`${baseUrl}/${path}`, {
      method: 'GET', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      redirect: 'manual', signal: controller.signal,
    });
    if (!response.ok) {
      // 只识别官方固定的隔离范围信号，不向快照传播错误正文。
      if (endpoint === 'usageScope' && response.status === 403) {
        try {
          const body = await readJson(response, 4096);
          if (object(object(body).error).message === 'this gateway key is held to a budget, models or accounts, so it is told its own calls alone: GET /v1/magpie/usage/requests') {
            throw new GatewayError('usage_key_scoped', '服务器已确认仅允许读取当前 Key 的调用。');
          }
        } catch (error) {
          if (error instanceof GatewayError && error.code === 'usage_key_scoped') throw error;
        }
      }
      await response.body?.cancel();
      const codes: Record<number, [string, string]> = {
        401: ['invalid_key', 'Gateway key 无效、已禁用或被撤销。'],
        403: ['forbidden', '服务器拒绝访问，请检查网关共享设置和 Key 权限。'],
        404: ['unsupported', '接口不支持，或地址的部署路径不正确。'],
        405: ['unsupported', '此版本不支持该读取接口。'],
        429: ['rate_limited', '服务器限制读取频率，请稍后重试。'],
        501: ['unsupported', '服务器尚未实现该接口。'],
      };
      if (response.status >= 300 && response.status < 400) throw new GatewayError('redirect', '网关返回重定向；请直接配置最终地址，Key 未向重定向目标发送。');
      const [code, message] = codes[response.status] ?? ['server_error', '服务器返回错误，请稍后重试。'];
      throw new GatewayError(code, message);
    }
    return await readJson(response, 2 * 1024 * 1024);
  } catch (e) {
    if (e instanceof GatewayError) throw e;
    throw new GatewayError(controller.signal.aborted ? 'timeout' : 'unreachable',
      controller.signal.aborted ? '读取超时，请检查服务器后重试。' : '服务不可达，请检查地址、网络和 TLS 配置。');
  } finally { clearTimeout(timeout); }
}
async function readJson(response: Response, maxSize: number): Promise<unknown> {
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = response.body?.getReader();
  if (reader) try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxSize) throw new GatewayError('contract', '响应超过安全读取大小。');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new GatewayError('invalid_json', '服务器没有返回有效 JSON。'); }
}
