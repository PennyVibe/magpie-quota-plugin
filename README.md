# Magpie 额度看板

本地 STDIO MCP 插件，ID 为 `magpie-quota-local`。用户在本机浏览器连接页填写服务器地址与服务器分配的 Gateway key；看板只读远端 Magpie 的个人额度，以及用户开启后的共享供应商缓存卡片。看板不展示或自动读取可用模型；保留独立的 `list_available_models` 工具供主动查询。本机不需要安装 Magpie，不需要远端后台登录 Key、供应商 Key 或 SSH。

## 从 GitHub 添加市场

仓库根目录提供 `.agents/plugins/marketplace.json` 和已构建的 `plugins/magpie-quota-local/server/`。安装者不需要下载源码后运行 npm 或自行构建，但电脑须有兼容的 Node.js（要求见下一节）。

在宿主插件页选择「添加插件市场」：

| 字段 | 内容 |
| --- | --- |
| 来源 | `PennyVibe/magpie-quota-plugin` |
| Git 引用 | `main`，或指定已发布版本标签 |
| 稀疏路径 | 留空 |

添加后在「Magpie 额度看板」市场安装插件。私有仓库需要当前用户的 Git 已配置该仓库的读取权限；不要在来源地址或聊天中填写访问令牌。

支持插件命令的 Codex CLI 也可安装：

```sh
codex plugin marketplace add PennyVibe/magpie-quota-plugin --ref main
codex plugin add magpie-quota-local@magpie-local
codex plugin list --marketplace magpie-local --json
```

`magpie-local` 是市场标识，`magpie-quota-local` 是插件 ID；`local` 表示后台运行在本机，与市场来源是否为 GitHub 无关。界面名称为「Magpie 额度看板」。若同名市场已从本地目录注册，请继续沿用原来源；新增 Git 来源不会迁移原注册，也不要重复添加同名来源。已保存连接位于当前用户目录，仓库与插件包不包含 Gateway key。

## 开发者更新市场文件

运行完整构建和打包后，同步预构建文件到仓库：

```sh
npm run build
npm run local:package
npm run marketplace:sync
npm run marketplace:check
npm run marketplace:verify
```

同步仅更新插件的生成 README、契约/验证文档和 `server/` 文件；未知插件文件会阻止同步，不会被删除或覆盖。两种 manifest、两份 MCP 配置及图标继续由源码维护。`marketplace:check` 拒绝版本相同但内容陈旧的产物；`marketplace:verify` 用临时 Git 树验证隐藏文件、忽略规则、跨平台字节一致性，并实际启动 Git 导出的后台。验证不读取用户凭证、不创建提交或推送。

`dist/private-marketplace/` 是额外生成的独立分发目录；`dist/` 继续被 Git 忽略。提交源代码时必须同时包含根市场清单、隐藏配置、`plugins/magpie-quota-local/server/` 以及同步的文档。后台是自包含 JavaScript，无原生 helper；`runtime.json` 记录构建平台，不限制安装平台。CI 在 macOS 和 Windows 分别验证。

## 运行与本地包

支持 macOS 13+（Apple Silicon / Intel）与 Windows 11 x64，需要已安装 Node.js 22.13.0+。Windows 的 Node 还需内置 libuv 1.51.0+，例如 Node.js 22.17.0。启动器会寻找现有兼容 Node，不下载运行时、不修改宿主设置。Windows 实机验收状态见验证记录。

```sh
npm ci
npm test
npm run typecheck
npm run lint
npm run build
npm run local:package
npm run local:verify
```

构建产物为 `dist/local/`。本地插件来源为 `dist/local-plugin/plugins/magpie-quota-local/`，包含 portable manifest、Codex 兼容 manifest、两份 MCP 配置、自包含 JavaScript 和图标；`dist/local-plugin` 另含本地 marketplace 索引。macOS 生成 `dist/Magpie-0.1.0-Mac-Apple-Silicon.tar.gz` 或 `Mac-Intel.tar.gz`，Windows 构建生成 `Windows-x64.zip`。归档中保留隐藏文件。不包含 node_modules、源码测试或任何已保存连接。

这些构建命令不会安装到宿主、注册 marketplace、创建 Git 提交、推送或发布。除了 GitHub 市场，也可使用宿主支持的本地来源流程。需要手工 STDIO 配置时，命令为 `node`，参数为解包目录中 `magpie-quota-local/server/launch.cjs` 的绝对路径。

## 配置、打开与切换

1. 在宿主的插件 global 入口打开「Magpie 额度看板」，或请求 `open_quota_dashboard`。
2. 点击「连接管理」，插件请求在本机默认浏览器打开受保护的连接页。若系统未打开，使用面板提供的链接在这台电脑的浏览器打开。
3. 自行填写连接名称、远端地址、Gateway key。点击「验证 /limit 并保存连接」。验证成功才保存；连接时不会读取模型或共享账号信息。
4. 可勾选「开启共享供应商额度展示」，或在已保存连接上点击开启并确认共享范围。开关按连接分别保存，默认关闭，关闭后不读取共享接口。
5. 返回面板，点击「完成，读取当前连接」。之后可在连接管理中查看保存的连接、切换连接或移除连接及 Key。移除当前连接后不会自动选择另一个连接。

地址允许 HTTP 和 HTTPS，保持输入协议。地址规范化到 OpenAI Base URL：

| 输入 | 保存与请求规则 |
| --- | --- |
| `https://example.com/magpie-gateway` | 保存为 `https://example.com/magpie-gateway/v1` |
| `https://example.com/magpie-gateway/v1` | 保持原路径，不再追加 `/v1` |
| `http://example.com:9123/a/v1/` | 去掉尾部斜杠，协议和端口保持不变 |

拒绝 URL 用户名、密码、所有查询参数、片段和编码路径分隔符。拒绝所有重定向，Key 不发送到重定向目标；请配置最终地址。HTTP 会以原协议传输 Key，仅在可信网络使用。

页面可见时每 60 秒读取远端，支持手动刷新，不重叠请求。隐藏、关闭或宿主 teardown 后停止；丢弃先前读取结果。开始连接管理立即清空旧数据。若在其他页面或实例切换连接，面板每秒检查一次本机连接版本并清空旧数据，该检查不访问远端。后台每次返回前再次核对持久连接版本。

## 数据含义与兼容性

个人额度区域只展示当前 Gateway key 自身额度，共享供应商卡片位于单独区域。已核对的 Magpie 版本每个 Key 配置一个日、周或月窗口，所以只显示服务器实际返回的一个窗口，不虚构三个同时生效的窗口。采用服务器返回的剩余值和带时区偏移的重置时间；倒计时只计算与该时间的差值，不按本机时区生成窗口。

Token 和估算费用各自展示上限、已用、剩余与进度。Token 使用十进制 K / M / B（千 / 百万 / 十亿），缩写值保留两位小数，例如 `65.66M`、`1.20B`；小于 1,000 保留整数，悬停可查看完整数值。进度按原始精确值计算，接口结果保留原数值。金额不使用缩写，保留现有 USD 格式与精度。费用为 USD 估算值，不是实际账单或充值余额；未知定价调用可能没有计入费用。Token 口径包括未缓存输入、输出、缓存写入，缓存读取是否计入由服务器配置决定。

在已确认契约中，一个维度的上限为 0 或省略表示该维度未设限；并不表示零余额。真实零用量、零剩余正常展示。其他缺失、负数、非有限值、超出安全整数范围的 Token 数值显示「未提供」，不补零。`limited:false` 表示 Key 未设置限额，该接口也不会返回此 Key 的个人用量。

Token 与费用的上限分别可选，用量展示不由是否设置上限决定。只设置 Token 上限时，费用上限与剩余显示「未设限」；只设置费用上限时，Token 同样处理。未设限的维度不生成额度进度；服务器仍返回用量时保留显示，缺失用量则显示「未提供」。

两个上限均未配置时，仍保留 Token 与估算费用的用量区域，并独立显示「未设置限额」。截至补充核对的公开源码 `27e69702e1a6c150622377a1bc48229376375bc8`，`/limit` 对此 Key 只返回 `limited:false` 与名称，网关没有独立的个人用量查询接口。页面因此显示「用量暂不可读取」，不把用量填零、不猜统计窗口。Web 后台 `/api/usage` 使用另一套 Web 登录认证，并包含服务器汇总及其他 Key 数据，不能作为当前 Gateway key 的个人用量来源。本地插件无法单方面提供完全不限额 Key 的真实个人用量；需要远端支持相应的只读接口，本次不修改远端。

401、403、接口不支持（404/405/501）、超时、不可达、无效 JSON、未知契约分别返回固定安全错误。404 也可能是部署路径错误，不能仅凭 404 确认版本过旧。一个来源失败不妨碍另一个来源显示；同一连接的失败可保留上次成功数据，但标明过期和原成功读取时间。连接切换会清空所有缓存。接口缺失不会降级成“无限额”。

Magpie 的 loopback 路径可能接受无效 Key，却返回 `limited:false,key:""`。插件拒绝把无 Key 归属的结果当成个人无限额；请使用能够识别该 Gateway key 的网关连接路径。

开启后，供应商共享额度区域和 `get_upstream_quota_cards` 只读取 `/v1/magpie/quotas/cards`。已核对源码的 `/quotas` 与 `/quotas/cards` 不按此 Key 的账号权限过滤，可能覆盖多个账号。插件不转发 `user`、原始错误、供应商 Key 或额外管理字段，使用卡片序号区分供应商多卡片。窗口 `used` 为百分比，剩余比例按已确认的 `max(0,100-used)` 规则计算；真实 0 正常显示，缺失/无效比例不填零。显示服务器 `readAt/asOf` 与带偏移的 `resetsAt`；只有相对 `resetSecs` 时保留原值，不按本机时间猜绝对重置时刻。服务器的余额原文单独标为共享供应商报告，不当作个人充值余额。

`/quotas/cards` 返回空列表表示服务器尚无缓存卡片；需要服务器自身先读取供应商数据。插件不主动调用供应商。共享接口不支持、失败或没有数据时个人看板仍可用；不会 fallback 到可能问供应商的 `/quotas`，也不会发送 POST refresh。没有按当前 Key 隔离的已核实历史聚合接口，因此不提供近 7/30 日历史、请求数统计或模型费用分布。不包含推理、配额重置、Key 管理和 POST 供应商刷新。

## 凭证与本机边界

Gateway key 仅由本机浏览器输入并提交给插件后台，模型工具没有地址或 Key 参数，没有通用 HTTP 代理。持久文件：

- macOS：`~/Library/Application Support/MagpieQuota/connections.json`
- Windows：`%LOCALAPPDATA%\MagpieQuota\connections.json`

独立于 Sub2API 的会话和配置。新建目录 0700，临时文件与最终文件 0600，同目录原子替换，写入前同步文件。Windows 权限还受该用户目录的 NTFS ACL 控制；Node 的 POSIX mode 不等于 Windows ACL，未宣称能隔离同一系统用户的程序。

文件采用**明文 JSON**，未加密。有读取权限的本机程序可以取得 Key。Key 不进入模型 content/structuredContent、日志、错误详情或进程参数。上游错误正文被丢弃；模型 ID 中直接回显完整 Key 的项目会被排除，额度返回中的服务器 Key 名称与额外共享字段也不会进入结果。持久文件不进入源码、生成 UI、Git 或插件包。

连接 HTTP 服务只监听 `127.0.0.1` 的随机端口。一次性 bootstrap URL 只放在 MCP 宿主 `_meta`，120 秒有效；兑换短期 HttpOnly / SameSite=Strict Cookie，页面地址随后去掉 bootstrap。页面授权 10 分钟有效，检查 Host、Origin、CSRF；新入口撤销旧页面授权。页面 CSP 不允许第三方脚本、资源或远端直接读取。

多个进程使用独立 revision 与排他目录锁保护持久连接。冲突要求重新载入页面，不覆盖后来写入的数据。若崩溃留下 `connections.lock`，先确认所有该插件后台已关闭，再手工移除该锁目录；不会按锁年龄擅自强抢。仅测试或自定义用户存储时可用 `MAGPIE_QUOTA_DATA_DIR` 指定独立目录，勿指向其他插件存储。

## 开发文件与验收

- `lib/gateway.ts`：固定 GET allowlist（limit、models、quotas/cards）、地址规则、安全错误、真实契约解析。
- `local/`：独立持久存储、连接管理、后台与两平台启动器。
- `widget/`：全屏 App，`autoResize:false`、刷新与生命周期处理。
- `generated/`：构建生成的自包含 HTML，不手改压缩产物。
- `scripts/`：构建、打包与隔离存储的 STDIO 验证。
- `tests/`：合成凭证、mock 上游、真实 SDK 的模拟宿主握手。

接口核对、版本兼容限制见 [Magpie 接口契约](docs/upstream-contract.md)。实际执行结果与待验收步骤见 [验证记录](docs/validation.md)。模拟宿主与 mock 成功不等于真实 Magpie 或真实宿主面板已经通过；本次不读取用户已有凭证、不访问真实远端服务。

结构参考 Sub2API 项目当前 0.1.20 的本地启动器、浏览器打开、安全连接入口、MCP Apps / global 元数据和构建打包方式；没有复制固定上游、登录续期或管理员重置功能。运行依赖固定为 MCP SDK 1.32.0、MCP Apps 1.7.5、MCP Extensions 0.1.0 与 Zod 4.2.0；不引入 React 或原项目的业务依赖。

模型可见工具均无参数：`open_quota_dashboard`、`get_my_gateway_quota`、`list_available_models`、`get_upstream_quota_cards`。另外两个仅面板可见工具用于本机连接管理和连接版本检查，不接收地址、路径或凭证。
