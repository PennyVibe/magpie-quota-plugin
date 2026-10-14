export type Problem = { code: string; message: string };
export type Metric = { limit: number | null; used: number | null; remaining: number | null; uncapped: boolean };
export type Quota = {
  limited: boolean; period: 'day' | 'week' | 'month' | 'days' | null; days: number | null;
  start: string | null; reset: string | null; tokens: Metric; cost: Metric;
  spent: boolean | null; cacheReads: boolean | null; unpriced: number | null;
  calls: number | null; inFlight: number | null; reservedTokens: number | null; reservedCost: number | null;
};
export type Connection = { id: string; name: string; baseUrl: string };
export type UsageTotals = {
  calls: number | null; errors: number | null; retried: number | null; input: number | null; output: number | null;
  cacheRead: number | null; cacheWrite: number | null; tokens: number | null;
  cost: number | null; unpriced: number | null;
};
export const usagePeriods = ['today', '7d', '30d', 'all'] as const;
export type UsagePeriod = typeof usagePeriods[number];
export const isUsagePeriod = (value: unknown): value is UsagePeriod => usagePeriods.some(period => period === value);
export type PersonalUsage = {
  period: UsagePeriod; scope: 'current-key'; source: 'through';
  totals: UsageTotals; models: (UsageTotals & { id: string })[];
};
export type Snapshot = {
  revision: string; connection: Connection | null;
  quota: Quota | null; models: string[] | null;
  quotaReadAt: string | null; modelsReadAt: string | null;
  quotaError: Problem | null; modelsError: Problem | null;
  stale: boolean;
  usage?: PersonalUsage | null; usageReadAt?: string | null; usageError?: Problem | null;
};
