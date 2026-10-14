# Magpie 额度看板开发说明

- 默认中文交流。独立插件 ID `magpie-quota-local`，不要修改 Sub2API 插件或远端 Magpie。
- `local/` 是 STDIO 后台、浏览器连接页和独立持久存储；`lib/` 是固定 GET 接口解析与 MCP 注册；`widget/` 是 MCP Apps 全屏 UI。
- `generated/` 与 `dist/` 通过构建生成，不手改压缩文件。只使用合成 Key / mock 验证，不读取用户已有凭证。
- Gateway key 与 URL 不能进入模型工具参数。Key 不进入模型结果、宿主元数据、日志或启动参数；连接 URL 只走 `_meta`。
- 上游 GET allowlist 仅 `/v1/magpie/limit`、`/v1/models`，以及 `period=today|7d|30d|all` 的 `/v1/magpie/usage` 范围探测与 `/v1/magpie/usage/requests?period=<枚举>&via=through&limit=1&offset=0`。禁止任意查询、推理、POST refresh、重置、Key 管理与通用代理。
- 模型用量只使用服务器确认隔离到当前 Key 的汇总；不得按非唯一 Key 名称推断 ID，不得将全局汇总标为个人统计。只投影总量、调用质量计数与 `by.model`，不转发请求行、账号、会话、路径或原始错误。
- 看板不展示或自动读取可用模型；`/v1/models` 仅供独立 `list_available_models` 工具主动查询，模型缓存与错误不进入看板快照。
- 用量与限额分别展示，不因未设限隐藏用量区域。有服务器用量就显示；没有可靠个人用量接口时明确未知，不填零。Token 用十进制 K/M/B 两位小数，金额不缩写，原值和进度精度保留。
- 不查询或展示共享供应商额度；旧 `upstreamEnabled` 字段仅保留存储读取兼容。原始账号标识、错误正文及管理字段不转发。接口适配前重新检查 `docs/upstream-contract.md` 和官方源码。
- Magpie 接口适配以最新版本的官方契约为准，不增加旧版本回退逻辑。
- 保持 `autoResize:false`，可见时远端每 60 秒读取，不重叠；关闭、隐藏、切换后丢弃旧响应。切换或移除连接后清空旧数据。
- 模型时间范围切换清空旧统计并丢弃迟到响应，不跨范围复用缓存。页面绝对时间统一转换为 `Asia/Shanghai`，不展示模型用量的读取时间。
- 完成变更后执行 `npm test`、`npm run typecheck`、`npm run lint`、`npm run build`、`npm run local:package`、`npm run local:verify`、`node scripts/verify-package.mjs`。真实宿主/远端和 Windows 实机验证另行说明。
- GitHub 市场入口为根 `.agents/plugins/marketplace.json`。`plugins/magpie-quota-local/server/` 是须随仓库交付的生成文件；通过 `npm run marketplace:sync` 同步，不手改。分发变更还须运行 `marketplace:check` 和 `marketplace:verify`。
- 未明确授权不创建 Git 提交、推送、发布、安装插件或注册 marketplace。
