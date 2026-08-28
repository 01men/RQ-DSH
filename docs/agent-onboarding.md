# Agent 接入宿主平台指引

> 面向对象：以机器身份接入平台的企业 Agent（注册 → 机器凭证 → 接入验证 → 计量对齐）。
> 适用版本：2026-08-26 接入加固落地后（Agent 凭证默认含 usage.write；计量键错误明确报 400 并给出期望键；
> 凭证支持轮换；机器身份访问 Agent 台账记审计 agent.verify）。加固清单见 `docs/dev-plan-access-hardening.md`，
> 平台未部署该批次前，第 4 步机器令牌推送计量将 403。
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

3. 接入验证（"发一句话"）：带上一步令牌 GET /api/agents，
   返回 200 且列表中能找到自己的 agt_ 前缀 id 即接入完成。
   该调用以机器身份记入平台审计（action=agent.verify，控制台「审计」页可查），可作接入证据。
   调用量与成功率由平台经网关自动统计（dshctl agent metrics <agt_...> 可查）；
   DAU/会话数等指标提报是 AI 应用的义务，与你无关。

4. 计量口径（防漏计与双计）：
   - 经平台 MCP 网关 / 模型网关的调用，平台已自动计量——禁止再手动推送，否则同一消耗双计费。
   - 仅当绕过平台网关直连外部资源（直连模型 API、直连 MCP 服务）时才手动推送：
     dshctl usage record --org=<orgId> --subject=agent:<agt_...> --principal=org:<orgId>
       --resource=model:<slug>|mcp:<slug> --meter=<key>:<数量>:<key> --idempotency-key=<本Agent名>:<业务单号>
   - meter key 必须与价格簿一致：mcp:* 用 tokens；model:<slug> 用 output_tokens（v1 只按输出 tokens 计费）。
     用错键会被 400 拒绝且错误信息直接给出期望键，按提示改键重报即可，不要编造计量键。
   - resource 无计价规则同样 400，届时向我报告，不要自行换 resource 或编造 meter。
   - 幂等键 <Agent名>:<业务单号>：同键同内容重放安全（返回原事件），同键不同内容会被拒绝，业务单号须稳定。

5. 权限自检与护栏：接入完成后先试跑一次换牌（步骤2）和一次 usage record（步骤4）。
   403 = 缺权限点（响应体会指明缺哪个），向我报告，不要换账号或重试硬闯；
   403 本身不触发锁定，触发锁定的是登录/换牌类连续失败（按用户名或 clientId 计，5 次/15 分钟窗口起）。
   不做上线/下线等审批操作；若任务明确要求"正式上线"或"可被应用编排"，
   先补齐治理属性（systemPromptVersion、dataClass；试运行还需 trialGroups），再走平台 L4 审批流，不得绕过。

【完成后回报】Agent id（agt_ 前缀）、clientId、"发一句话"调用的状态码与关键证据
（响应片段 + 审计页 agent.verify 记录）、控制台查看路径（http://192.168.0.7:7300/ →「Agent 本体」页）。
