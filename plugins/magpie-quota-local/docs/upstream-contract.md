# Magpie 接口契约

核对日期：2026-10-14。适配官方仓库 `yetone/magpie` 的当前 HEAD `eb0d5750f86a39342f2901079f1a07bff3d06aa4`，并确认最新发布版 `v0.1.1231` 已包含受限 Key 的共享额度隔离。仅使用合成 Key / mock 验证，不读取已有服务器凭证；不增加旧版本回退逻辑。

官方文档：<https://github.com/yetone/magpie/blob/eb0d5750f86a39342f2901079f1a07bff3d06aa4/docs/reference.md>。

关键源码（相对该 commit）：`internal/gateway/key_limit.go`、`lan.go`、`usage_api.go`、`gateway.go`、`session_route.go`、`concurrency.go`、`internal/budget/budget.go`、`internal/access/limit.go`、`internal/usage/usage.go`、`request_page.go`、`internal/usageapi/usageapi.go`。

## 可查询信息与当前取舍

| 接口 | 最新契约与权限 | 插件行为 |
| --- | --- | --- |
| `GET /v1/magpie/limit` | 当前 Key 的预算窗口、已用、上限、剩余、调用数、在途与预留 | 连接验证及看板查询 |
| `GET /v1/magpie/usage/requests` | 受限 Key 强制隔离当前 Key；含全范围汇总与 `by.model` | 看板固定读取四个时间范围，仅投影个人汇总 |
| `GET /v1/magpie/usage` | 受限 Key 返回明确 403；未受限 Key 返回全局汇总 | 仅在没有预算时探测隔离范围，成功响应丢弃 |
| `GET /v1/models` | 按 Key 的模型及账号规则筛选的模型列表 | 仅独立 `list_available_models` 工具主动查询，看板不读取 |
| `/v1/magpie/quotas`、`quotas/cards`、`quotas/history` | 预算、模型或账号任意受限的 Key 返回 403 `gateway_key_held` | 完全移除共享查询、缓存、展示及 `get_upstream_quota_cards` 工具 |
| `GET /v1/magpie/concurrency` | 全局账号并发信息，受限 Key 同样返回 403 | 不查询 |
| `GET /v1/magpie/route` | 必须指定会话；受限 Key 只能读取自己的会话路由，可能含账号与错误 | 不查询、不获取会话标识 |

共享权限变更来自 2026-10-13 commit `12ecb6d8e9e5e1a115a996e7508b0d59601575f0`（#1981）。`heldKey` 判断 `KeyID != ""` 且预算、模型、账号任意限制非空。插件旧连接文件中的 `upstreamEnabled` 仅保留读取兼容性，不触发查询、不进入快照；无需重写凭证文件。

插件 GET allowlist 只有 limit、models、usage 范围探测和 usage/requests 固定分页。没有共享接口、通用代理、推理、POST refresh、重置、Key 管理或账号管理请求。

## 认证与读取边界

仅发送 `Authorization: Bearer <Gateway key>`。连接地址必须为 HTTP/HTTPS；用户信息、查询参数、片段及编码路径分隔符均拒绝。网关需要允许远程访问且 Key 启用；反向代理、LAN 与 IP allowlist 影响上游远端判定。缺少、禁用或无效 Key 可返回 401；策略拒绝可返回 403。

loopback 可以接受无效 token，但仅有效启用 Key 会被归属。因此 `limited:false` 不证明 Key 有效，`/limit.key` 必须为非空名称，否则 `key_unattributed` 并拒绝保存。不复制 Key 名称，不按名称猜 Key ID。Key 不进入结果、宿主元数据、日志或启动参数；连接管理 URL 仅放 `_meta`。

全部请求拒绝重定向，Bearer 仅发送到已保存地址；成功 JSON 上限 2 MiB，错误范围探测上限 4 KiB。个人用量两次读取总计不超过 10 秒。上游动态错误正文、header、账号与请求行不进入结果。

## GET /v1/magpie/limit

无预算时：`{"limited":false,"key":"Synthetic user"}`。不提供窗口计数，不能表示零用量或没有在途请求。

有预算时（合成示例）：

```json
{
  "limited": true,
  "key": "Synthetic user",
  "limit": {
    "period": "days", "days": 7,
    "start": "2026-10-13T15:06:42+08:00", "reset": "2026-10-20T15:06:42+08:00",
    "calls": 12, "tokens": 19300000, "cost": 127.436642,
    "costLimit": 800, "tokensLeft": 0, "costLeft": 672.563358,
    "inFlight": 2, "reserved": 4500, "reservedCost": 0.123456, "spent": false
  }
}
```

| 字段 | 已确认含义与插件处理 |
| --- | --- |
| `limited` | 必须为 boolean；有限额时至少一个合法非零 cap |
| `period/days` | `day/week/month/days`；days 周期必须提供 1–3650 的整数天数，不从起止时间猜 |
| `start/reset` | 服务器 RFC3339 绝对瞬间；统一展示为 Asia/Shanghai，保留 datetime 原精度 |
| `tokens/cost` | 已结算 Token / USD 估算费用；未知数字不补零 |
| `tokenLimit/costLimit` | 省略或合法零为本维度无 cap；非法数字为未知 |
| `tokensLeft/costLeft` | 优先服务器原值；无 cap 的零不得显示零余额 |
| `spent` | 任一有 cap 维度达到上限；缺失为未知 |
| `calls` | 当前预算窗口已结算调用数；缺失或非法为未知，与所选模型统计时间范围分开 |
| `inFlight` | 当前 Key 在途请求数；最新 Status 的 `omitempty` 省略表示零，非法为未知 |
| `reserved/reservedCost` | 在途请求预留 Token / 费用；`omitempty` 省略表示零，非法为未知；不加进已结算值或从服务器剩余值再次扣除 |
| `cacheReads` | 是否将缓存读取计入预算；false 省略，维持缺省口径未提供 |
| `unpriced` | 未定价调用数，省略为未知，有值才显示 |

Token 预算口径为 input + output + cache_write，配置 `CacheReads` 时再含 cache_read；与个人模型 Token 总量的含缓存口径不同。日、周、月使用服务器日历窗口；days 从设置或手动重置开始，周期 N×24 小时。手动重置预算不删除 usage log，不能作为模型统计清零。

## 个人模型用量与调用质量

只接受 `period=today|7d|30d|all`，默认 today。7d 是服务器今天午夜向前六天，30d 向前二十九天，all 为全部记录；不使用客户端午夜生成筛选。固定请求：

`GET /v1/magpie/usage/requests?period=<枚举>&via=through&limit=1&offset=0`

有预算的 Key 直接读取。无预算时先读取 `/usage?period=<枚举>`，仅在 HTTP 403 的固定官方消息 `this gateway key is held to a budget, models or accounts, so it is told its own calls alone: GET /v1/magpie/usage/requests` 完全匹配时确认模型/账号受限，继续读取 requests。普通 403 不证明个人范围；summary 成功返回全局数据，丢弃并显示 `usage_scope_unknown`。Key 名称不唯一，不按名称推断 ID。

requests 的根 Totals 与 `by.model` 覆盖整个筛选范围，与分页 rows 数量无关。仅取一行控制敏感响应规模，不逐页抓取。根 `through/direct` 清除了来源筛选，不作为当前根汇总的替代。

| 字段 / 展示 | 处理 |
| --- | --- |
| `period/offset/total/rows/by.model` | 核对范围、第一页及封闭尺寸；rows 不投影 |
| `calls` | 最终调用计数；交给后续重试的尝试不是独立调用，未计入日志的拒绝不包含在此 |
| `errors` | 最终向客户端返回错误的调用数；非负安全整数，缺失或大于 calls 为未知 |
| `retried` | 首次尝试失败、重试后成功的调用数；官方 omitempty 省略为零，非法或大于成功调用数为未知 |
| 成功率 | `(calls-errors)/calls`；零调用、未知计数不生成百分比 |
| `input/output/cache_read/cache_write` | 四项 Token，非负安全整数；分项未知或总和溢出则总量和占比未知 |
| Token 构成 | 展示四项及其在含缓存总量中的占比；与模型用量选择相同范围，加载及范围切换清空旧统计 |
| `cache_write_1h/reasoning` | 已含在其他项中，不重复累加、不投影 |
| `cost/unpriced` | 原始非负有限 USD 估算费用 / 未定价调用，未知不按价格补算 |
| `by.model[].id` | 唯一模型 ID，限制长度、控制字符及密钥回显；不复制账号/provider/name/icon |

完整合法 calls 及四项 Token 的模型合计须与根汇总一致；费用使用原值，不作浮点精确相等判断。仅投影 Totals 与 by.model；账号、callerKeys、会话、agents、computers、series、rows、路径和原始错误均不进入快照。

没有可靠个人接口时明确不可用，不填零。范围切换立即清空旧统计且丢弃迟到响应；同连接同范围暂时失败保留数据并标过期，权限或身份拒绝立即清空个人用量。切换、移除连接丢弃全部旧数据。可见时每 60 秒刷新，不重叠；保持 autoResize:false，隐藏、关闭后丢弃旧响应。

## 错误与验证边界

401 为 invalid_key；403 为 forbidden；404/405/501 为 unsupported；429 为 rate_limited；其他非 2xx 为 server_error；3xx 为 redirect 且不跟随。超时、网络、非法 JSON、结构或大小异常分别映射固定错误。不向用户或模型返回动态错误原文。

额度、个人用量及独立模型列表分别处理失败。连接验证要求 limit 支持且 Key 归属明确，不降级到共享或管理接口。新增展示不增加远端读取次数，不展示模型用量读取时间。

仅核对官方源码和合成 fixture；未访问实际远端、已有凭证或 Windows 实机，不宣称所有部署和历史版本兼容。
