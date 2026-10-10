import type { Metric, Snapshot } from '../lib/types';
export const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const number = (v: number | null, cost: boolean) => v === null ? '未提供' : cost ? `$${v.toLocaleString('en-US', { maximumFractionDigits: 6 })}` : v.toLocaleString('zh-CN');
function tokens(v: number | null) {
  if (v === null) return '未提供';
  const [scale, unit]: [number, string] = v >= 1e9 ? [1e9, 'B'] : v >= 1e6 ? [1e6, 'M'] : v >= 1e3 ? [1e3, 'K'] : [1, ''];
  const text = unit ? (v / scale).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + unit : v.toLocaleString('en-US');
  const exact = `${v.toLocaleString('en-US')} Token`;
  return `<data value="${v}" title="完整数值：${exact}" aria-label="${exact}">${text}</data>`;
}
function metric(m: Metric, cost: boolean) {
  const progress = m.limit !== null && m.limit > 0 && m.used !== null ? Math.min(100, m.used / m.limit * 100) : null;
  const value = (v: number | null) => cost ? number(v, true) : tokens(v);
  return `<div class="metric"><h3>${cost ? '估算费用 · USD' : 'Token'}</h3><div class="used">${value(m.used)}<span>已用</span></div>
    ${progress === null ? '' : `<div class="track"><div style="width:${progress}%"></div></div>`}
    <dl><div><dt>上限</dt><dd>${m.uncapped ? '未设限' : value(m.limit)}</dd></div><div><dt>剩余</dt><dd>${m.uncapped ? '未设限' : value(m.remaining)}</dd></div></dl>
    <p class="hint">${m.uncapped ? '未设限，不计算额度进度' : progress === null ? '无可计算的进度' : `已用 ${progress.toFixed(1)}%`}</p></div>`;
}
function upstream(snapshot: Snapshot) {
  if (!snapshot.upstreamEnabled) return `<section class="models shared"><h2>远端共享供应商额度</h2><p class="hint">尚未开启。在连接管理中明确开启后才会读取。共享额度未按当前 Key 账号权限过滤。</p></section>`;
  return `<section class="models shared"><div class="section-title"><h2>远端共享供应商额度</h2><span>服务器缓存 · 非个人用量</span></div>
    <p class="hint">可覆盖服务器多个账号，不代表当前 Gateway key 的个人消耗。未请求供应商主动刷新。</p>
    <p class="hint">接口最后读取：${escape(snapshot.upstreamReadAt ?? '尚未成功')}${snapshot.upstreamError && snapshot.upstreamCards ? ' · 卡片已过期' : ''}</p>
    ${snapshot.upstreamError ? `<div class="notice" role="alert">${escape(snapshot.upstreamError.message)}</div>` : ''}
    ${snapshot.upstreamCards === null || snapshot.upstreamCards === undefined ? '<p>共享额度暂不可用。</p>' : snapshot.upstreamCards.length === 0 ? '<p>服务器尚无缓存卡片。需要服务器自身先读取供应商额度，插件不会触发主动刷新。</p>' :
      snapshot.upstreamCards.map(card => `<article class="upstream-card"><h3>${escape(card.name)} <span class="hint">卡片 ${card.cardNumber} · ${escape(card.provider)}</span></h3>
        <p class="hint">${{ subscription: '供应商订阅', plan: '供应商计划', balance: '供应商额度', unknown: '类型未提供' }[card.kind as 'subscription'] ?? '类型未提供'}${card.plan ? ` · ${escape(card.plan)}` : ''}</p>
        <p class="hint">供应商数据读取时间：${escape(card.readAt ?? card.asOf ?? '未提供；数据可能较旧')}</p>
        ${card.asOf || card.unavailable ? '<div class="notice">服务器保存了旧数据或尚无法读取此供应商；卡片可能过期。</div>' : ''}
        ${card.balance ? `<p>供应商报告原文：${escape(card.balance)} <span class="hint">共享数据，不是个人充值余额</span></p>` : ''}
        ${card.windows.length ? card.windows.map(w => `<div class="upstream-window"><strong>${escape(w.name)}</strong>
          <p>${w.unlimited ? '此供应商窗口未设限' : `已用 ${w.usedPercent === null ? '未提供' : `${w.usedPercent.toFixed(1)}%`} · 剩余 ${w.remainingPercent === null ? '未提供' : `${w.remainingPercent.toFixed(1)}%`}`}</p>
          <div class="track">${!w.unlimited && w.usedPercent !== null ? `<div style="width:${Math.min(100, w.usedPercent)}%"></div>` : ''}</div>
          ${w.amount !== null || w.limit !== null ? `<p class="hint">服务器计数：${number(w.amount, false)} / ${number(w.limit, false)} ${escape(w.unit ?? '单位未提供')}</p>` : ''}
          <p class="hint">重置时间：${escape(w.reset ?? '未提供')}${!w.reset && w.resetSeconds !== null ? `；服务器报告相对 ${w.resetSeconds} 秒（未转换为本机推断时间）` : ''}</p></div>`).join('') : '<p class="hint">服务器没有返回可展示的额度窗口。</p>'}</article>`).join('')}
    </section>`;
}
export function countdown(reset: string | null, now = Date.now()) {
  if (!reset) return '服务器未提供重置时间';
  const seconds = Math.max(0, Math.ceil((Date.parse(reset) - now) / 1000));
  if (!seconds) return '已到重置时间，等待下一次服务器读取';
  return `${Math.floor(seconds / 86400)}天 ${Math.floor(seconds / 3600) % 24}小时 ${Math.floor(seconds / 60) % 60}分 ${seconds % 60}秒后重置`;
}
export function renderSnapshot(snapshot: Snapshot | null, transportError = false) {
  if (!snapshot) return `<div class="empty"><h2>连接你的 Magpie 网关</h2><p>${transportError ? '插件读取失败，请重试。' : '通过本机连接管理页添加服务器与 Gateway key。'}</p></div>`;
  const q = snapshot.quota, c = snapshot.connection;
  const errors = [snapshot.quotaError].filter(Boolean);
  let quota = '';
  if (q) {
    const title = q.limited ? `${{ day: '每日', week: '每周', month: '每月' }[q.period!]}用量与限额` : '个人用量与限额';
    quota = `<article class="quota-card"><div class="card-title"><h2>${title}</h2><span class="badge">${!q.limited ? '未设置限额' : q.spent === true ? '额度耗尽' : q.spent === false ? '尚未耗尽' : '耗尽状态未提供'}</span></div>
      <div class="metrics">${metric(q.tokens, false)}${metric(q.cost, true)}</div>
      ${q.limited ? `<div class="reset"><p>窗口开始：${escape(q.start ?? '未提供')}</p><p>服务器重置时间：${escape(q.reset ?? '未提供')}</p><strong id="countdown">${escape(countdown(q.reset))}</strong></div>
      <p class="hint">按服务器窗口统计。${q.cacheReads === null ? '缓存读取计费口径未提供。' : q.cacheReads ? 'Token 包含缓存读取。' : 'Token 不含缓存读取。'}${q.unpriced !== null ? ` 未定价调用 ${q.unpriced} 次未计入估算费用。` : ''}</p>` :
        `<p class="hint">当前 Gateway key 未设置限额。</p>${q.tokens.used === null && q.cost.used === null ? '<div class="notice" role="status">用量暂不可读取：当前网关接口未返回此 Key 的个人 Token 和估算费用用量。未设限不代表零用量。</div>' : ''}`}
      </article>`;
  } else quota = '<div class="empty"><h2>个人用量与限额暂不可用</h2><p>未将缺失值显示为零；请检查连接或接口兼容性。</p></div>';
  return `<section class="connection"><span class="eyebrow">CURRENT GATEWAY</span><h2>${escape(c?.name ?? '尚未选择连接')}</h2><p>${escape(c?.baseUrl ?? '')}</p><p>${errors.length || transportError ? '读取失败' : c ? '已连接' : '未连接'} · 个人额度最后读取：${escape(snapshot.quotaReadAt ?? '尚未成功')}</p></section>
    ${errors.map(e => `<div class="notice" role="alert">${escape(e!.message)}</div>`).join('')}
    ${snapshot.stale || transportError ? '<div class="notice" role="alert">显示的是上次成功数据，已过期；当前读取失败。</div>' : ''}
    <div class="section-title"><h2>我的 Gateway key 用量与限额</h2><p>独立于远端订阅与供应商账号</p></div>${quota}
    ${upstream(snapshot)}
    <footer>个人美元金额是服务器估算费用，不是实际账单或充值余额。共享供应商额度单独展示，未按当前 Key 隔离；不提供历史统计。</footer>`;
}
