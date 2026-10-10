# Magpie 接口契约与兼容性

核对日期：2026-10-10。官方仓库 `yetone/magpie`，源码快照 commit `3a1ade9729996d81b67beaf4570250f9772fa10b`，通过公开 Git clone 获取并核对 `HEAD`，不使用已有服务器凭证。初次在线网页读取未返回内容，公开 Git 与 raw 文档下载成功；后续在线读取也成功核对固定 commit 的关键处理函数。GitHub API tree 请求返回 403，未影响最终源码核对。

官方文档：
<https://github.com/yetone/magpie/blob/3a1ade9729996d81b67beaf4570250f9772fa10b/docs/reference.md>

关键源码（以下路径均相对该 commit）：

- `internal/gateway/key_limit.go`：`keyLimit` 与 GET 放行规则。
- `internal/budget/budget.go`：`Status`、`status`、`Of`，剩余与耗尽计算。
- `internal/access/limit.go`：`Limit`、`Limited`、`Valid`、`Window`。
- `internal/gateway/lan.go`：`lanGuard`、`identifyCaller`、`callerKeys`、`sharedWith`。
- `internal/gateway/gateway.go`：`models`、`modelObject`、`catalogFor`、`quotas`、`quotaCards`。
- `internal/gateway/key_models.go`：`keyAllowed` 及模型/账号限制。
- `internal/provider/quotas.go`：`QuotaReport` 与账号/计划额度数据。
- `internal/provider/remote_quotas.go`：`CachedCards`。
- `internal/provider/subscription_usage.go`：`SubscriptionQuota`、`QuotaWindow`。
- `internal/gateway/key_limit_test.go`、`quotas_lan_test.go`、`quotas_remote_test.go`：上游契约的回归证据。

## 认证与权限

插件仅发送 `Authorization: Bearer <Gateway key>`。官方还接受 `x-api-key`、`x-goog-api-key` 与 `?key=`；插件不使用这些替代入口，用户输入的连接 URL 查询参数全部拒绝；用量请求参数仅由后台按固定 allowlist 生成。

远端请求需要网关允许远程访问且 Key 启用。缺少、禁用或无效 Key 返回 401；网关不允许远程访问时可能 403。反向代理头、绑定地址、LAN 设置会影响上游对远端的判定。loopback 是特别情况：可以接受无效 token，但仅有效启用 Key 会被归属到 named identity。因此 `limited:false` 本身不能独立证明有效 Gateway key。插件要求 `/limit` 的 `key` 为非空字符串，否则报 `key_unattributed` 并拒绝保存。

GET 状态查询不执行模型推理，也不被个人额度 POST 限制阻止。真实远端的代理认证、TLS、具体权限或版本尚未验证。

## GET /v1/magpie/limit

无配置限额（或者未归属到 Key）的真实 shape：

```json
{"limited":false,"key":"Gateway key 的名称"}
```

其中 `key` 是名称，不是密钥值；未归属时通常为空字符串。插件不复制服务器 Key 名称到模型结果。

### 个人模型用量与限额分开读取

`/limit` 仍只在有限额时返回当前预算窗口的计数；`limited:false` 不代表零用量。2026-10-10 新增网关用量接口，核对当前官方快照 `8d95ebc8c307b4363f6731b688b1014a1958524d` 的 `internal/gateway/usage_api.go`、`internal/usageapi/usageapi.go`、`internal/usage/request_page.go`、`internal/usage/usage.go`、`internal/access/access.go`。以下用量节描述新接口与个人隔离限制，替代先前“网关没有用量 GET”的版本结论。既有限额和共享卡片契约同时重新核对。

有限额真实 shape 示意，数值为合成示例：

```json
{
  "limited": true,
  "key": "Synthetic user",
  "limit": {
    "period": "week",
    "start": "2026-10-05T00:00:00+08:00",
    "reset": "2026-10-12T00:00:00+08:00",
    "calls": 3,
    "tokens": 30,
    "cost": 0.125,
    "tokenLimit": 100,
    "costLimit": 2,
    "tokensLeft": 70,
    "costLeft": 1.875,
    "spent": false
  }
}
```

| 字段 | 已确认含义 | 插件处理 |
| --- | --- | --- |
| `limited` | Key 是否有非零 Token 或费用 cap | 必须为 boolean，缺失不视作 unlimited |
| `period` | 一个窗口，`day` / `week` / `month` | 展示实际一个窗口，未知值报契约不支持 |
| `start` / `reset` | Go time.Time JSON 的 RFC3339 时间 | 保留原始瞬间；页面转为北京时间，缺失不推断 |
| `tokens` | 已结算未缓存输入、输出、缓存写入，配置开启时还包括缓存读取 | 非负安全整数；缺失或无效显示未知 |
| `cost` | 服务器 Usage 价格的 USD 估算费用 | 非负有限数；不标实际账单 |
| `tokenLimit` / `costLimit` | 大于 0 为 cap；0 省略（omitempty） | 省略或合法 0 表示本维度没有 cap |
| `tokensLeft` / `costLeft` | 有 cap 时 `max(cap-used,0)`；无 cap 时输出 0 | 优先原值；无 cap 的 0 不能标零余额 |
| `spent` | 任一有 cap 维度达到上限 | 原值展示，缺失则 unknown |
| `cacheReads` | 是否计入缓存读取，false 省略 | UI 保守显示缺省口径未提供，不自行改计数 |
| `unpriced` | 无已知价格的调用数，0 省略 | 有值才显示，不推断费用 |
| `inFlight` / `reserved` / `reservedCost` | 在途请求与额度预留，0 省略 | 第一版不显示、不加入已结算值 |
| `calls` | 本窗口该 Key 的调用计数 | 第一版不提供请求数统计 |

cap 为 0 表示无 cap，源码 `Limited()` 只有 `Tokens > 0 || Cost > 0` 才有配置。因此“零额度”在当前版本主要是实际已用 0 或剩余 0；不能把配置 cap=0 宣称为禁止使用。插件用合成 mock 验证真实零值、缺失、负数、非有限值和溢出，未捏造另一种上游配置语义。

窗口由服务器自身 time.Location 计算：日从午夜、周从周一午夜、月从月初。调用计入开始时所在窗口，重启后从 usage log 恢复。插件不使用本机时区补窗口。费用未定价调用不加成本；总费用不是充值余额。

## GET /v1/magpie/usage 与 /v1/magpie/usage/requests

官方源码链接：<https://github.com/yetone/magpie/blob/8d95ebc8c307b4363f6731b688b1014a1958524d/internal/gateway/usage_api.go>。

两个接口均要求 `local(r) || sharedWith(r)`。服务器 `heldKey` 在 Key 有预算、模型规则或账号限制时为 true。`usage/requests` 对此类 Key 强制使用 `who.KeyID` 作为 `CallerKey`，再经过 `OwnPage` 投影；插件因此可确认个人统计。未受限的 Key 可以读到全服务器汇总与请求，不能直接标为个人用量。

插件只接受四个预设 `period=today|7d|30d|all`，默认 `today`，日期由服务器时区解释；不推断客户端午夜，不开放任意筛选参数或 URL。重新核对官方固定快照 `8d95ebc8c307b4363f6731b688b1014a1958524d` 的 `usage.Periods`、`Period.Since` 和 `usageapi.PeriodOf`：7d 从服务器今天午夜往前六天、30d 往前二十九天，all 为全部记录。页面保留的绝对时间全部转换为 `Asia/Shanghai`。

- `/limit limited:true` 已确认预算限制，直接读取 `/usage/requests?period=<枚举>&via=through&limit=1&offset=0`。
- `/limit limited:false` 无法区分模型/账号限制与完全未受限。先读取 `/usage?period=<枚举>`，只在 HTTP 403 且 `error.message` 与官方固定的 held-key 拒绝信息完全一致时确认个人范围，再请求明细汇总。普通 403 不足以证明范围，不继续读取。
- summary 成功代表没有确认个人范围，响应内容全部丢弃，显示固定 `usage_scope_unknown`。服务器 Key 名称不保证唯一，不能按 `/limit.key` 匹配 summary 的 callerKeys 推断 ID。
- 旧接口 404/405/501 或其他错误只影响模型用量区，保留独立限额与共享卡片。

`usage/requests` 顶层嵌入 `Totals`，`by.model` 是整个筛选范围的模型汇总，与分页 `rows` 数量无关。固定 `limit=1` 避免读取大量敏感请求行，不逐页抓取；`via=through` 只统计网关请求。根 `through/direct` 字段在官方代码中清除了来源筛选，不能替代当前根汇总，不能据此推断 direct 必须为零。

| 字段 | 插件处理 |
| --- | --- |
| `period/offset/total/rows/by.model` | 核对响应与所选范围一致、第一页和封闭响应尺寸；不复制请求行 |
| `calls` | 计入用量的调用数（服务器拒绝的记录不计入），非负安全整数；模型合计须与总量一致 |
| `input/output/cache_read/cache_write` | 四个 Token 细分，非负安全整数；缺失或非法显示未知 |
| Token 总量与占比 | 四项相加，含缓存读写；任一未知或总和溢出则总量/占比未知 |
| `cache_write_1h/reasoning` | 不重复计入 Token 总量，不转发 |
| `cost` | 原始非负有限 USD 估算金额，不按模型价格补算 |
| `unpriced` | 未定价调用数，缺失未知；大于零注明未计入费用 |
| `by.model[].id` | 唯一模型 ID，限制长度与控制字符，拒绝包含完整 Key 的回显；不复制 name/icon 或 provider/modelAt |
| callerKeys/accounts/providers/agents/computers/series/rows/path | 不进入快照、模型结果、UI 或日志 |

合计校验适用于完整合法整数的 calls 与四项 Token；费用直接采用服务器值，不用浮点精确相等判断。真实总量零且无模型时显示“今天暂无用量”；未知值不得伪造零、占比或空调用。范围/身份拒绝后立即清空旧个人用量；同连接同范围暂时读取失败保留上次成功数据并标过期。范围切换清空旧个人统计，缓存不跨范围复用；范围或连接变更均丢弃迟到统计。模型概览以静态表格展示，支持 Token/金额排序，不提供模型点击展开或细分面板；四项 Token 仍用于后台总量计算，不查询可用模型列表。

范围探测只解析最多 4 KiB 的错误 JSON，将官方固定拒绝消息映射为内部信号，不传播任何错误原文。两次用量读取合计最多 10 秒；成功 JSON 仍遵循 2 MiB 上限、拒绝重定向、Bearer 仅发向已保存地址。

## GET /v1/models

顶层 OpenAI shape 为 `{"object":"list","data":[...]}`。每条至少是一个 object，模型 ID 为 `id`。当前 `modelObject` 还返回 `object/type/created/created_at/owned_by/display_name/reasoning/supported_reasoning_levels` 等字段，版本与模型类型可能扩展字段。

处理路径为 `catalogFor` / `keyAllowed`，根据 caller 的模型规则和账号限制筛选。路由组、provider 通配与账号权限会改变结果；空规则代表 unrestricted。插件只返回去重的字符串 ID，不复制账号、供应商额外信息，不将列表等同于可对话模型分类，也不发起推理验收。此接口仅由独立的 `list_available_models` 工具主动查询；看板不展示或自动查询可用模型列表，也不将该缓存或查询失败放入看板快照。模型用量区域的模型 ID 来自个人调用汇总。

## GET /v1/magpie/quotas 与 /v1/magpie/quotas/cards

两个接口均检查 `local(r) || sharedWith(r)`。在所核对 commit 中：

- `quotas`：`{"object":"list","data":provider.QuotaReport(ctx,time.Now())}`，12 秒 context，可读取远端供应商/订阅报告。
- `quotaCards`：`{"object":"list","data":provider.CachedCards(time.Now())}`，返回本机服务器已读缓存，不主动问 vendor。
- `Quota` / `SubscriptionQuota` 可能包含 `user`、账号/计划标识、provider、状态、窗口、历史或最近服务元数据。`QuotaReport` 枚举服务器 provider，而 `CachedCards` 没有 request/caller 参数。
- 处理路径没有调用 `keyAllowed`、Key account filter 或当前 Key 的 personal budget。共享访问授权不等于按 Key 隔离账号信息。

已经确认的是共享访问与不按 Key 筛选的边界；没有将这些共享信息转换为个人额度。用户于 2026-10-10 明确要求共享供应商额度默认展示，不提供选择开关。新旧连接统一只读取 `quotas/cards` 缓存接口；旧连接的 `upstreamEnabled` 字段保持文件读取兼容，但不再控制行为，无需重写凭证文件。`get_upstream_quota_cards` 也直接查询当前连接的缓存卡片。本次重新下载并核对固定快照 `27e69702e1a6c150622377a1bc48229376375bc8` 的 `Server.quotaCards` 与 `CachedCards`，接口和解析契约未变。区域独立标为共享，不混入个人限额。没有 GET `/quotas`、POST refresh、历史、重置或账号管理路径。

卡片顶层为 `object:list,data:SubscriptionQuota[]`，每条按实际契约投影 `provider/name/kind/plan/windows/balance/readAt/asOf`。`user`、AccessSKU、reset credits、history/daily/checkin/balanceTrend/holds/管理字段均丢弃；上游 `error` 仅转换成 unavailable boolean，不传播 raw 详情。

窗口为 `QuotaWindow`：`name`、`used`（已用百分比）、可选 `unlimited/resetsAt/resetSecs/amount/limit/unit`。cards 无 `remaining`，同一源码的 `quotaReport` 将其转换为 `max(0,100-used)`，插件采用这条已确认规则计算剩余百分比。超额时保留原使用百分比，进度条限制为 100%；缺失或无效值为 unknown。`resetsAt` 为服务器绝对时间；只提供 `resetSecs` 时显示原相对值，不以抓取时刻或本机窗口猜绝对时间。

`CachedCards` 可返回很旧的缓存或空数组；插件显示缓存来源，后台保留读取时间，页面不展示接口读取时间和供应商数据读取时间。`asOf` 或 raw error 存在时标注服务器卡片可能过期。接口 HTTP 失败保留当前连接上次成功卡片并标明过期；切换或移除连接清空旧卡片。新版本字段未知时不猜测；旧版本 404/405/501 时报告共享区域不支持，不回退到其他共享接口。

## 错误与兼容性

插件不返回上游错误 body/header 内的动态详情，只返回固定中文错误。用量范围探测仅识别官方固定 403 消息并转换成内部范围信号。未读入服务器日志或真实凭证。

| 情况 | 表达与降级 |
| --- | --- |
| 401 | `invalid_key`；可能无效、禁用或撤销 |
| 403 | `forbidden`；服务器策略或权限拒绝 |
| 404 | `unsupported`；也可能部署路径错误，需要用户核对 |
| 405 / 501 | `unsupported`；接口缺失/未实现 |
| 429 | `rate_limited`；稍后用户/正常周期重试，无推理请求 |
| 其他非 2xx | 固定 `server_error`，丢弃 raw body |
| 任何 3xx | `redirect`，完全不 follow |
| 超过 10 秒 / 网络失败 | `timeout` / `unreachable` |
| 非法 JSON / 超过 2 MiB | `invalid_json` / `contract` |
| 非 boolean limited、未知 period、未归属 Key | 不误标无限额，报告契约/归属异常 |
| 缺失或无效数值/时间 | unknown，不从 local timezone、用量或模型价格补算 |

个人额度、个人模型用量、共享卡片与可用模型列表单独处理错误。连接验证要求 `/limit` 支持；旧版本缺少此接口时不保存尚无法确认身份的连接，也不降级去读取共享 `/quotas`。

仅核对上述 commit，尚未实测多个历史 tag、用户的实际部署版本、真实服务器响应或 Gateway key 权限。兼容性测试使用源码契约的合成 fixture 和接口缺失/变形 mock；不宣称所有 Magpie 版本已兼容。
