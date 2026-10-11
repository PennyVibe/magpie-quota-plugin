import type { Metric, Snapshot } from '../lib/types';
import { usagePeriods, type UsagePeriod } from '../lib/types';
import { icon } from './icons';
export const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const number = (v: number | null, cost: boolean) => v === null ? '未提供' : cost ? `$${v.toLocaleString('en-US', { maximumFractionDigits: 6 })}` : v.toLocaleString('zh-CN');
function time(value: string | null | undefined, missing = '未提供') {
  if (!value) return escape(missing);
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return escape(missing);
  // 时间展示统一北京时间，datetime 保留原始瞬间与精度。
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === name)!.value;
  const text = `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
  return `<time datetime="${escape(value)}" title="${text} 北京时间">${text} <span class="timezone">北京时间</span></time>`;
}
function tokens(v: number | null) {
  if (v === null) return '未提供';
  const [scale, unit]: [number, string] = v >= 1e9 ? [1e9, 'B'] : v >= 1e6 ? [1e6, 'M'] : v >= 1e3 ? [1e3, 'K'] : [1, ''];
  const text = unit ? (v / scale).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + unit : v.toLocaleString('en-US');
  const exact = `${v.toLocaleString('en-US')} Token`;
  return `<data value="${v}" title="完整数值：${exact}" aria-label="${exact}">${text}</data>`;
}
export type UsageViewState = { sort: 'tokens' | 'cost'; period?: UsagePeriod; loading?: boolean };
const periodLabels: Record<UsagePeriod, string> = { today: '今天', '7d': '近 7 天', '30d': '近 30 天', all: '全部' };
function renderUsage(snapshot: Snapshot, state: UsageViewState) {
  if (!snapshot.connection) return '';
  const period = state.period ?? snapshot.usage?.period ?? 'today';
  const usage = snapshot.usage?.period === period ? snapshot.usage : null;
  const heading = `<div class="section-title usage-heading"><div><h2>个人模型用量</h2><p class="hint">当前 Key 的请求、Token 与估算费用</p></div><div class="usage-segment usage-periods" role="group" aria-label="模型用量时间范围">${usagePeriods.map(p =>
    `<button data-usage-period="${p}" aria-pressed="${p === period}">${periodLabels[p]}</button>`).join('')}</div></div>`;
  if (state.loading) return `<section class="model-usage">${heading}<div class="usage-unavailable" role="status">正在读取${periodLabels[period]}用量…</div></section>`;
  if (!usage) return `<section class="model-usage">${heading}<div class="usage-unavailable" role="status"><p>个人模型用量暂不可用</p><p class="hint">${escape(snapshot.usageError?.message ?? '服务器尚未提供当前 Key 的模型用量统计。')}</p></div></section>`;
  const models = [...usage.models].sort((a, b) => (b[state.sort] ?? -1) - (a[state.sort] ?? -1) || a.id.localeCompare(b.id));
  const total = usage.totals;
  const share = (value: number | null) => value === null || total.tokens === null ? null : total.tokens === 0 ? 0 : value / total.tokens * 100;
  return `<section class="model-usage">${heading}
    ${snapshot.usageError ? `<div class="notice" role="alert">模型用量未更新。${escape(snapshot.usageError.message)}</div>` : ''}
    <div class="usage-context"><span class="badge">已应用：${periodLabels[period]}</span><span class="hint">${models.length} 个模型</span></div>
    <div class="usage-overview"><div class="usage-stat"><h3>${icon('calls')}调用次数</h3><div class="usage-total">${number(total.calls, false)}</div></div>
      <div class="usage-stat usage-stat-tokens"><h3>${icon('tokens')}Token 总用量</h3><div class="usage-total">${tokens(total.tokens)}</div></div>
      <div class="usage-stat"><h3>${icon('cost')}估算费用 · USD</h3><div class="usage-total">${number(total.cost, true)}</div></div></div>
    ${total.calls === 0 && models.length === 0 ? `<div class="usage-unavailable"><p>${period === 'today' ? '今天' : '所选范围'}暂无用量</p></div>` : `
    <div class="usage-toolbar"><div><h3>模型分布</h3><p class="hint">Token 占比</p></div><div class="usage-segment" role="group" aria-label="模型排序">
      <button data-usage-sort="tokens" aria-pressed="${state.sort === 'tokens'}">Token</button><button data-usage-sort="cost" aria-pressed="${state.sort === 'cost'}">金额</button></div></div>
    <ul class="usage-models" aria-label="各模型用量">${models.map(model => {
      const percent = share(model.tokens);
      return `<li class="usage-model"><div class="model-heading"><h4 class="model-name">${escape(model.id || '未标注模型')}</h4>
        <p class="model-tokens">Token ${tokens(model.tokens)} <span class="model-percent">· ${percent === null ? '占比未知' : `占比 ${percent.toFixed(1)}%`}</span></p></div>
        <div class="model-share"><div class="${percent === null ? 'track-placeholder' : 'track'}" aria-hidden="true">${percent === null ? '' : `<div style="width:${Math.min(100, percent)}%"></div>`}</div></div>
        <div class="model-details"><p class="model-calls">调用 <span>${number(model.calls, false)}</span></p><p class="model-cost">估算费用 <span>${number(model.cost, true)}</span></p></div></li>`;
    }).join('')}</ul>`}
    ${total.unpriced === null ? '<p class="usage-foot hint">未定价调用：未提供</p>' : total.unpriced > 0 ? `<p class="usage-foot hint">未定价调用：${total.unpriced} 次</p>` : ''}</section>`;
}
function metric(m: Metric, cost: boolean) {
  const progress = m.limit !== null && m.limit > 0 && m.used !== null ? Math.min(100, m.used / m.limit * 100) : null;
  const value = (v: number | null) => cost ? number(v, true) : tokens(v);
  return `<div class="metric"><div class="metric-heading"><h3>${cost ? '估算费用 · USD' : 'Token'}</h3><p class="hint metric-progress${progress === null ? ' metric-progress-unknown' : ''}">${m.uncapped ? '未设限' : progress === null ? '进度未提供' : `已用 ${progress.toFixed(1)}%`}</p></div>
    ${progress === null ? '<div class="track-placeholder" aria-hidden="true"></div>' : `<div class="track"><div style="width:${progress}%"></div></div>`}
    <div class="metric-details"><div class="used${m.used === null ? ' unknown' : ''}"><div class="metric-value">${value(m.used)}</div><span>已用</span></div>
      <dl><div><dt>上限</dt><dd>${m.uncapped ? '未设限' : value(m.limit)}</dd></div><div><dt>剩余</dt><dd>${m.uncapped ? '未设限' : value(m.remaining)}</dd></div></dl></div></div>`;
}
function upstream(snapshot: Snapshot) {
  if (!snapshot.connection) return '';
  return `<section class="shared" aria-label="共享供应商额度"><div class="section-title shared-heading"><h2>共享供应商额度</h2><span class="badge neutral">服务器缓存</span></div>
    ${snapshot.upstreamError ? `<div class="notice" role="alert">${escape(snapshot.upstreamError.message)}</div>` : ''}
    ${snapshot.upstreamCards === null || snapshot.upstreamCards === undefined ? '<div class="empty"><p>共享额度暂不可用。</p></div>' : snapshot.upstreamCards.length === 0 ? '<div class="empty"><p>暂无供应商额度数据。</p></div>' :
      snapshot.upstreamCards.map(card => `<article class="upstream-card"><div class="provider-heading"><div class="card-identity"><span class="card-icon provider-icon">${icon('provider')}</span><div><h3>${escape(card.name)}</h3>
        <p class="hint">${{ subscription: '供应商订阅', plan: '供应商计划', balance: '供应商额度', unknown: '类型未提供' }[card.kind as 'subscription'] ?? '类型未提供'}${card.plan ? ` · ${escape(card.plan)}` : ''}</p></div></div><span class="provider-tag">卡片 ${card.cardNumber}<br>${escape(card.provider)}</span></div>
        ${card.asOf || card.unavailable ? '<p class="hint">数据未更新</p>' : ''}
        ${card.balance ? `<p class="balance">Credits：${escape(card.balance.replace(/\s*credits?\s*$/i, ''))}</p>` : ''}
        ${card.windows.length ? `<div class="upstream-windows">${card.windows.map(w => `<div class="upstream-window"><div class="window-heading"><strong>${escape(w.name)}</strong>
          <p class="window-usage${w.unlimited || w.usedPercent === null ? ' window-usage-unknown' : ''}">${w.unlimited ? '此供应商窗口未设限' : `已用 ${w.usedPercent === null ? '未提供' : `${w.usedPercent.toFixed(1)}%`}`}</p></div>
          ${!w.unlimited && w.usedPercent !== null ? `<div class="track"><div style="width:${Math.min(100, w.usedPercent)}%"></div></div>` : '<div class="track-placeholder" aria-hidden="true"></div>'}
          ${w.unlimited ? '' : `<p class="hint window-remaining">剩余 ${w.remainingPercent === null ? '未提供' : `${w.remainingPercent.toFixed(1)}%`}</p>`}
          ${w.amount !== null || w.limit !== null ? `<p class="hint">服务器计数：${number(w.amount, false)} / ${number(w.limit, false)} ${escape(w.unit ?? '单位未提供')}</p>` : ''}
          <p class="hint window-reset">${icon('clock')}<span>${!w.reset && w.resetSeconds !== null ? `报告重置间隔：${w.resetSeconds} 秒` : `重置时间：${time(w.reset)}`}</span></p></div>`).join('')}</div>` : '<p class="hint">暂无额度窗口。</p>'}</article>`).join('')}
    </section>`;
}
export function countdown(reset: string | null, now = Date.now()) {
  if (!reset) return '服务器未提供重置时间';
  const seconds = Math.max(0, Math.ceil((Date.parse(reset) - now) / 1000));
  if (!seconds) return '已到重置时间，等待更新';
  return `${Math.floor(seconds / 86400)}天 ${Math.floor(seconds / 3600) % 24}小时 ${Math.floor(seconds / 60) % 60}分 ${seconds % 60}秒后重置`;
}
export function renderSnapshot(snapshot: Snapshot | null, transportError = false, usageState: UsageViewState = { sort: 'tokens' }) {
  if (!snapshot) return `<div class="empty"><h2>连接你的 Magpie 网关</h2><p>${transportError ? '插件读取失败，请重试。' : '通过本机连接管理页添加服务器与 Gateway key。'}</p></div>`;
  const q = snapshot.quota, c = snapshot.connection;
  const errors = [snapshot.quotaError].filter(Boolean);
  let quota = '';
  if (q) {
    const title = q.limited ? `${q.period === 'days' ? `每 ${q.days} 天` : { day: '每日', week: '每周', month: '每月' }[q.period!]}用量与限额` : '个人用量与限额';
    quota = `<article class="quota-card"><div class="card-title"><div class="card-identity"><span class="card-icon">${icon('quota')}</span><div><h2>${title}</h2><p class="hint">当前 Key</p></div></div><span class="badge${q.spent === true ? ' exhausted' : ''}">${!q.limited ? '未设置限额' : q.spent === true ? '额度耗尽' : q.spent === false ? '尚未耗尽' : '耗尽状态未提供'}</span></div>
      <div class="metrics">${metric(q.tokens, false)}${metric(q.cost, true)}</div>
      ${q.limited ? `<div class="reset"><dl class="time-details"><div><dt>窗口开始</dt><dd>${time(q.start)}</dd></div><div><dt>服务器重置</dt><dd>${time(q.reset)}</dd></div></dl><strong id="countdown">${escape(countdown(q.reset))}</strong></div>
      ${q.cacheReads !== null || q.unpriced !== null ? `<p class="hint quota-note">${q.cacheReads === null ? '' : `缓存读取：${q.cacheReads ? '计入' : '不计入'}`}${q.cacheReads !== null && q.unpriced !== null ? ' · ' : ''}${q.unpriced === null ? '' : `未定价调用：${q.unpriced} 次`}</p>` : ''}` :
        ''}
      </article>`;
  } else quota = '<div class="empty"><h2>个人用量与限额暂不可用</h2></div>';
  return `<section class="connection"><div class="connection-identity"><span class="hint">当前网关</span><h2>${escape(c?.name ?? '尚未选择连接')}</h2><span class="badge${errors.length || transportError || !c ? ' neutral' : ''}">${errors.length || transportError ? '读取失败' : c ? '已连接' : '未连接'}</span></div><p class="connection-address" title="${escape(c?.baseUrl ?? '')}">${escape(c?.baseUrl ?? '')}</p><p class="connection-read hint">额度读取：${time(snapshot.quotaReadAt, '尚未成功')}</p></section>
    ${errors.map(e => `<div class="notice" role="alert">${escape(e!.message)}</div>`).join('')}
    ${snapshot.stale || transportError ? '<div class="notice" role="alert">读取失败，显示上次数据。</div>' : ''}
    <div class="dashboard-layout"><div class="section-title dashboard-section-title"><h2>额度</h2><span class="hint">当前 Key 与共享供应商</span></div>
      <div class="quota-layout">${quota}${upstream(snapshot)}</div>${renderUsage(snapshot, usageState)}</div>`;
}
