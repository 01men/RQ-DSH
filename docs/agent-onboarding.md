# Agent 接入宿主平台指引

> 面向对象：以机器身份接入平台的企业 Agent（注册 → 机器凭证 → 接入验证 → 计量对齐）。
> 适用版本：2026-08-26 接入加固落地后（Agent 凭证默认含 usage.write；计量键错误明确报 400 并给出期望键；
> 凭证支持轮换；机器身份访问 Agent 台账记审计 agent.verify）。加固清单见 `docs/dev-plan-access-hardening.md`。
> 2026-08-30 NAS 数据权限上线：新增 4.5 节（文件网关接入、X-On-Behalf-User 身份红线、
> 越权/分享审批/降级语义），需文件能力的 Agent 必读。设计全文见 `docs/nas-authz.md`。
> 本文档随服务发布，可直接访问 `http://<平台地址>/docs/agent-onboarding.md`。

【任务】接入宿主平台 http://192.168.0.7:7300，完成 Agent 注册、机器身份打通与计量对齐。

0. 环境：所有 dshctl 命令前先设置平台地址（CLI 默认指向 127.0.0.1，必须覆盖）：
   export DSHCTL_URL=http://192.168.0.7:7300
   （Windows PowerShell 用 $env:DSHCTL_URL="http://192.168.0.7:7300"，cmd 用 set DSHCTL_URL=...）
   机器令牌放 DSHCTL_TOKEN；管理员账号走 DSHCTL_USER / DSHCTL_PASS。

1. 注册（资源管理员账号，需 agent.write 权限）：
   dshctl agent create --name=<全局唯一名称> --model=<deepseek-chat|deepseek-reasoner|deepseek-coder> --riskLevel=<low|medium|high>
   （或 POST /api/agents）。成功后平台一次性下发机器凭证：clientId（mc- 前缀）/ clientSecret（cs_ 前缀）。
   secret 只出现一次：立即安全保存，不打印到公开输出、不写入代码或提示词；
   丢失或疑似泄露立即告诉我，由我执行凭证轮换（dshctl credential rotate，clientId 不变、旧 secret 立即失效、
   存量令牌全部吊销），不要重新注册。
   若返回 400「已存在」：用 dshctl agent list 按名称找到既有 Agent 复用，不要换名重复注册。
   attrs 是白名单制：白名单外字段（含 version，放 attrs 或请求顶层都一样）静默丢弃——返回 200 但不落库，
   不要以 200 判定字段生效。平台无通用 version 字段；提示词版本用 systemPromptVersion（上线必填），
   通用版本写进 description 和 tags（dshctl 不支持，需直接 POST /api/agents 或注册后 PATCH）。
   记下该 Agent 的 orgId（dshctl agent get <agt_...> 可查），第 4 步要用。

2. 登录打通（机器身份，不走 OIDC/SSO）：
   POST /api/auth/client-credentials  { "clientId": "mc-...", "clientSecret": "cs_..." } → 取 data.token。
   令牌有效期 2 小时，可重复换取；之后所有请求带 Authorization: Bearer <token>，
   用 dshctl 则 export DSHCTL_TOKEN=<token>。
   收到 401（令牌过期/无效）：重新换牌一次再重试原请求，不要反复硬试
   （换牌连续失败 5 次会锁定该 clientId 15 分钟，且逐次升级，最高 24 小时）。
   Agent 是机器身份，没有 redirect_uri，也不需要 SSO 客户端签发和用户授权页。

3. 接入验证（"发一句话"：首次运营数据提报）：带上一步令牌
   POST /api/agents/<本Agent的agt_...>/metrics-report  body {"dau":1,"sessions":1,"uniqueUsers":1}
   返回 200 且 GET /api/agents/<agt_...> 中 metrics.sessions ≥ 1 即接入完成（提报动作记入平台审计）。
   【接入义务（强制，不是倡导）】此后必须每日定时提报运营数据（与 AI 应用同级）：
   - dau：日活跃用户数（同日多次上报取最大）；sessions：对话会话数（同日累加）；
     uniqueUsers：对话去重用户数；有用户明细时随报 userIds 列表（平台侧即刻哈希脱敏去重，不落明文）。
   - 重复上报安全，可带 date（YYYY-MM-DD）补录历史；漏报导致平台运营数据失真，接入验收以本接口 200 为准。
   - 同时必须提报交互界面地址：PATCH /api/agents/<agt_...>  body {"attrs":{"entryUrl":"https://<真实交互入口>"}}
     （白名单内字段）——平台控制台据此在 Agent 卡片与详情页提供直达入口与授权访问，PATCH 后 GET 复核。
   - 调用量/成功率/Token 由平台经网关自动统计（dshctl agent metrics <agt_...> 可查），
     与上述提报口径互补，不能互相替代。

3.5 平台授权直达（交互界面建议支持的免登通道）：
   控制台「打开交互界面 / 带平台身份打开」不再裸跳转：平台先签发一次性入场票据，再以
   <entryUrl>#entry_ticket=<票据> 打开交互界面。交互界面侧只需两步：
   - 从 URL fragment 读取 entry_ticket（fragment 不进服务端日志，优于 query）；
   - POST /api/authn/entry-tickets/redeem  body {"ticket":"<票据>"}
     → 响应 data.identity 即平台用户身份：sub / username / name / org{id,name,tenantId} / roles / tenant；
       另返回 refType=agent、refId=<agt_...> 供校验票据确系发给本 Agent。
   票据一次性（重放被拒）、默认 120 秒过期（ENTRY_TICKET_TTL_SECONDS 可调 30~600）、
   兑换时实时校验账号状态；签发与兑换均入审计（agent.entry.ticket.*）。
   票据无效/过期时引导用户回控制台重新点击打开即可，不要缓存重试。
   注：签发侧授权=负责人/绑定用户/管理员（使用即授权留痕）；标准 OIDC 应用仍走 /oauth/authorize。

4. 计量口径（防漏计与双计）：
   - 经平台 MCP 网关 / 模型网关的调用，平台已自动计量——禁止再手动推送，否则同一消耗双计费。
   - 仅当绕过平台网关直连外部资源（直连模型 API、直连 MCP 服务）时才手动推送：
     dshctl usage record --org=<orgId> --subject=agent:<agt_...> --principal=org:<orgId>
       --resource=model:<slug>|mcp:<slug> --meter=<key>:<数量>:<key> --idempotency-key=<本Agent名>:<业务单号>
   - meter key 必须与价格簿一致：mcp:* 用 tokens；model:<slug> 用 output_tokens（v1 只按输出 tokens 计费）。
     用错键会被 400 拒绝且错误信息直接给出期望键，按提示改键重报即可，不要编造计量键。
   - resource 无计价规则同样 400，届时向我报告，不要自行换 resource 或编造 meter。
   - 幂等键 <Agent名>:<业务单号>：同键同内容重放安全（返回原事件），同键不同内容会被拒绝，业务单号须稳定。

4.5 NAS 文件能力与数据权限（Agent 需要文件读写能力时必读）：
   NAS 文件操作全部经平台文件网关（MCP，synology-filestation-mcp 形态）统一执法，
   平台侧按「组织位置 + 角色层级 RBAC（P/D/T/M + C 跨域只读叠加）+ 资源级例外」判定，全链 fail-closed。
   - 接入：向管理员申请文件网关令牌（已绑定目标 NAS 与 DSM 账户，并确认 allowedOnBehalf 标记），
     MCP 配置 url = http://<网关地址>/mcp，Authorization: Bearer <网关令牌>；
     设备路由与 DSM 凭据由令牌绑定决定，不要自行传 X-NAS-* 凭据头。
   - 身份红线（P0-2 教训）：真实用户身份一律经请求头 X-On-Behalf-User: <平台 userId 或钉钉 userId>
     透传，禁止放进工具参数/arguments。令牌未被标记 allowedOnBehalf 时携带该头一律
     403 FORGED_ON_BEHALF（防伪造，伪造行为留痕）。无用户上下文的纯机器调用可不带头，
     由令牌绑定的默认身份判定。
   - 越权语义：被拒操作返回 JSON-RPC error -32403「数据权限拒绝：<reasons>」。reasons 前缀可归因：
     path.out-of-scope（超出授权作用域）/ matrix.deny（角色矩阵无此操作权限，share 类会提示走审批）/
     org.*（组织位置异常，如挂根无负责人）/ account.*（账号特殊状态，如外部账号白名单只读）/
     degraded.*（平台判定服务不可达，已降级）。把原文透传给用户，不要变形重试硬闯。
   - 分享审批闭环：share 被拒且理由含「需走审批」时，代表用户发起申请：
     POST /api/nas/authz/exceptions
     body {"status":"pending","nasId":"<资产ID>","userId":"<用户ID>","path":"<路径>","reason":"<事由>"}
     → 平台自动生成审批单，审批人沿用户组织链自动路由（最近非空负责人，找不到升级 resource_admin 兜底）；
     通过后自动写入默认 7 天的 share 例外（到期自动失效，可先 POST /api/nas/authz/check 自查），全程留痕。
   - 降级语义：平台判定不可达时，网关按「最后已知作用域快照（仅只读）→ 全局只读 → 一律拒绝」降级；
     收到 degraded.* 前缀理由说明是平台短暂不可达而非用户越权——提示用户稍后重试即可，
     不要连续重试（网关有熔断：连续 5 次超时进入降级态，平台恢复后自动退出并留痕）。
   - 观察期语义：平台 observeOnly 灰度开关开启期间，越权操作仍放行但全部留痕并触发告警
     （网关 OBSERVE-DENY 日志、平台判定留痕可查）——放行是灰度设计，不代表越权合法。

5. 权限自检与护栏：接入完成后先试跑一次换牌（步骤2）和一次 usage record（步骤4）。
   403 = 缺权限点（响应体会指明缺哪个），向我报告，不要换账号或重试硬闯；
   403 本身不触发锁定，触发锁定的是登录/换牌类连续失败（按用户名或 clientId 计，5 次/15 分钟窗口起）。
   不做上线/下线等审批操作；若任务明确要求"正式上线"或"可被应用编排"，
   先补齐治理属性（systemPromptVersion、dataClass；试运行还需 trialGroups），再走平台 L4 审批流，不得绕过。

【完成后回报】Agent id（agt_ 前缀）、clientId、首次运营数据提报（metrics-report）与 entryUrl 提报的
状态码与关键证据（响应片段 + 控制台「Agent 本体 → 监控」页运营数据、审计页 agent.metrics.report 记录）、
控制台查看路径（http://192.168.0.7:7300/ →「Agent 本体」页）。
