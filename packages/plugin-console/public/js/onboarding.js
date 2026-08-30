/** 接入指引生成器：手动注册 Agent / AI 应用成功后，按平台接入规范自动生成可执行指引（附刚颁发的凭证）。 */
import { esc, openModal, copyText } from './ui.js'

const base = () => location.origin

/** Agent 接入指引全文（可直接交给执行 Agent 照做；凭证已填好）。 */
export function buildAgentOnboardingText(agent, credential) {
  const origin = base()
  return `【任务】按《榕器平台 · Agent 接入指引》完成下方 Agent 的接入验证、运营数据提报与资料更新。平台地址：${origin}

【资源与凭证】（client_secret 仅此一次展示，请立即安全保存，不落明文日志）
- Agent ID：${agent.id}
- 唯一标识：${agent.slug ?? '—'}
- client_id：${credential.clientId}
- client_secret：${credential.clientSecret}

【第 1 步 · 机器凭证换牌】（令牌 2 小时有效，可随时重复换取）
curl -s -X POST ${origin}/api/auth/client-credentials \\
  -H 'content-type: application/json' \\
  -d '{"clientId":"${credential.clientId}","clientSecret":"${credential.clientSecret}"}'
→ 取响应 data.token，后续请求头带：Authorization: Bearer <token>

【第 2 步 · 接入验证（"发一句话"：首次运营数据提报）】
curl -s -X POST ${origin}/api/agents/${agent.id}/metrics-report \\
  -H "Authorization: Bearer <token>" -H 'content-type: application/json' \\
  -d '{"dau":1,"sessions":1,"uniqueUsers":1}'
→ 返回 200 即接入成功；GET ${origin}/api/agents/${agent.id} 中 metrics.sessions ≥ 1 可复核。
【接入义务】每日定时提报运营数据是接入平台的强制要求（与 AI 应用同级），不是倡导：
- 必报字段：dau（日活跃用户数，同日取最大）、sessions（对话会话数，同日累加）、
  uniqueUsers（对话去重用户数）；有用户明细时随报 userIds 列表（平台侧哈希脱敏去重，不落明文）。
- 重复上报安全，可带 date（YYYY-MM-DD）补录历史；漏报将导致平台运营数据失真，接入验收以本接口 200 为准。
- 调用次数/成功率/Token 由平台网关自动归集，无须也无法替代上述提报，两者口径互补。

【第 3 步 · 提报更新（交互界面地址 + 自主更新资料）】
curl -s -X PATCH ${origin}/api/agents/${agent.id} \\
  -H "Authorization: Bearer <token>" -H 'content-type: application/json' \\
  -d '{"attrs":{"entryUrl":"<交互界面地址 https://…>","description":"<最新描述，可注明版本号>","tags":["<版本号，如 v1.0.0>"]}}'
→ entryUrl 是 Agent 面向用户的真实交互入口，接入后必须提报（白名单内字段）：
  平台控制台据此在 Agent 卡片与详情页提供直达入口。PATCH 后 GET 复核生效。
→ 平台授权直达（交互界面建议支持）：控制台「打开交互界面」以 #entry_ticket=<一次性票据> 打开
  entryUrl；交互界面读取该片段并回平台兑换登录身份——
  POST ${origin}/api/authn/entry-tickets/redeem  body {"ticket":"<票据>"}
  → 响应 data.identity 即平台用户身份（sub/username/name/org/roles/tenant），据此免登进入界面。
  票据一次性、约 2 分钟过期，过期/重放让用户从控制台重新打开即可。
→ attrs 为白名单制：白名单外字段（含 version，放 attrs 或请求顶层都一样）静默丢弃——返回 200 但不落库。
  版本登记：通用版本写 tags / description；提示词版本用 systemPromptVersion（上线必填）。

【第 4 步 · 计量自推（直连场景必做）】
仅绕过平台网关直连外部资源时需要：POST ${origin}/api/usage/record（凭自身凭证即可，凭证默认含 usage.write）。
经平台网关的调用已自动计量（MCP 网关经 mcp.invoked、模型网关 POST /api/modelgw/invoke 凭自身凭证可调，
计量事件 subject=agent:<id> 自动回灌调用台账），禁止双计。

【第 5 步 · NAS 文件能力与数据权限（需文件能力时必读）】
NAS 文件操作经文件网关（MCP：url=<网关地址>/mcp + Authorization: Bearer <管理员签发的网关令牌>）统一执法，
按组织位置 + 角色层级 RBAC 判定，全链 fail-closed：
- 身份红线（P0-2）：真实用户身份一律经请求头 X-On-Behalf-User: <平台或钉钉 userId> 透传，禁止进工具参数；
  令牌须由管理员标记 allowedOnBehalf 才允许携带该头，否则一律 403 FORGED_ON_BEHALF（伪造留痕）；
  无用户上下文的机器调用可不带头，由令牌绑定身份判定。
- 越权返回 JSON-RPC -32403「数据权限拒绝：<reasons>」，前缀可归因：path.out-of-scope（超作用域）/
  matrix.deny（角色无权）/ org.* / account.* / degraded.*（平台不可达已降级）——原文透传给用户，不要变形重试。
- share 被拒且提示"需走审批"时，代表用户发起申请：
  POST ${origin}/api/nas/authz/exceptions  body {"status":"pending","nasId":"<资产ID>","userId":"<用户ID>","path":"<路径>","reason":"<事由>"}
  → 审批单自动路由用户组织链最近负责人（兜底 resource_admin），通过后自动写 7 天例外，到期自动失效。
- PDP 不可达时网关按「作用域快照只读 → 全局只读 → 拒绝」降级：收到 degraded.* 理由提示用户稍后重试，
  不要连续重试。observeOnly 观察期越权放行但留痕告警，不代表越权合法。

【注意】
1. client_secret 等价口令：只在注册响应出现一次，平台不可再查询；丢失只能在「身份与凭证」轮换。
2. 幂等：重名注册返回 400「已存在」时，按名称查列表复用既有资源，不得换名重复注册。
3. 上线/下线走审批流（POST /api/agents/${agent.id}/transition → 审批中心 decision），禁止绕过审批改状态。
4. 失败锁定：换牌连续失败 5 次锁来源 IP 15 分钟，重试前先核对凭证。`
}

/** AI 应用接入指引全文（可直接交给执行 Agent 照做；凭证已填好）。 */
export function buildAppOnboardingText(app, credential) {
  const origin = base()
  return `【任务】按《榕器平台 · AI 应用接入指引》完成下方应用的接入验证与指标提报。平台地址：${origin}

【资源与凭证】（client_secret 仅此一次展示，请立即安全保存，不落明文日志）
- 应用 ID：${app.id}
- 唯一标识：${app.slug ?? '—'}
- client_id：${credential.clientId}
- client_secret：${credential.clientSecret}

【第 1 步 · 机器凭证换牌】（令牌 2 小时有效，可随时重复换取）
curl -s -X POST ${origin}/api/auth/client-credentials \\
  -H 'content-type: application/json' \\
  -d '{"clientId":"${credential.clientId}","clientSecret":"${credential.clientSecret}"}'
→ 取响应 data.token，后续请求头带：Authorization: Bearer <token>

【第 2 步 · 接入验证（"发一句话"：首次指标提报）】
curl -s -X POST ${origin}/api/apps/${app.id}/metrics-report \\
  -H "Authorization: Bearer <token>" -H 'content-type: application/json' \\
  -d '{"dau":1,"sessions":1,"avgDepth":1,"retention7":0}'
→ 返回 200 即接入成功；GET ${origin}/api/apps/${app.id} 中 metrics.sessions ≥ 1 可复核。
建议每日定时提报（同日 DAU 取最大值、会话数累加，重复上报安全，可带 date 补录历史）。

【第 3 步 · 提报更新（自主更新资料）】
curl -s -X PATCH ${origin}/api/apps/${app.id} \\
  -H "Authorization: Bearer <token>" -H 'content-type: application/json' \\
  -d '{"attrs":{"url":"<最新访问地址>","description":"<最新说明>","publishVersion":"<版本号，如 v1.0.0>"}}'
→ attrs 为白名单制（应用没有 tags 字段）：白名单外字段（含 version）静默丢弃——返回 200 但不落库。
  版本登记用 publishVersion；PATCH 后 GET 复核生效。

【第 4 步 · 计量自推（可选）】
仅绕过平台网关直连消耗才需要：POST ${origin}/api/usage/record（凭证默认含 usage.write）。
经平台网关的调用已自动计量，禁止双计。

【注意】
1. client_secret 等价口令：只在注册响应出现一次，平台不可再查询；丢失只能在「身份与凭证」轮换。
2. 幂等：重名注册返回 400「已存在」时，按名称查列表复用既有资源。
3. 上线走审批流且 web/h5 形态有 SSO 门禁（owner 在应用详情签发 OIDC 客户端），禁止绕过审批改状态。
4. 失败锁定：换牌连续失败 5 次锁来源 IP 15 分钟，重试前先核对凭证。
5. 数据权限红线：应用代用户操作 NAS 文件等平台数据面接口时，用户身份一律经
   X-On-Behalf-User 请求头透传（禁止进参数/路径）；越权响应（-32403 数据权限拒绝）原文透传给用户，
   degraded.* 前缀表示平台短暂不可达已降级，提示稍后重试。`
}

/**
 * 注册成功弹窗：凭证元信息 + 按模板生成的接入指引全文 + 一键复制。
 * clientSecret 仅此一次展示；全文可整段交给执行 Agent 照做。
 */
export function openOnboardingModal({ title, resource, credential, metaRows, guideText, resourceLabel }) {
  const modal = openModal({
    title, wide: true,
    body: `
      <div class="form-hint mb-8" style="display:flex;gap:8px;align-items:center">
        <span style="color:var(--warn)">⏳</span>
        <span>凭证（client_secret）<b>仅此一次展示</b>，请立即通过下方「一键复制」保存；平台侧不可再查询，丢失只能轮换。</span>
      </div>
      <div class="desc-grid mb-8">
        ${metaRows.map(([k, v]) => `<div class="desc-item"><span class="k">${esc(k)}</span><span class="v mono">${esc(v)}</span></div>`).join('')}
      </div>
      <div class="flex mb-8" style="justify-content:space-between;align-items:center">
        <span class="card-title">接入指引（已按模板生成，凭证已填入）</span>
        <button class="btn btn-primary btn-sm" id="onboard-copy-all">${esc('⧉ 一键复制全部指引')}</button>
      </div>
      <pre class="mono fs-12" id="onboard-guide" style="white-space:pre-wrap;background:var(--bg-2);padding:12px;border-radius:8px;max-height:380px;overflow:auto;line-height:1.7">${esc(guideText)}</pre>
      <div class="form-hint mt-8">整段复制后可直接粘贴给执行 Agent（或开发者）照做：换牌 → 接入验证 → 提报更新，${esc(resourceLabel)}即可自主完成接入与提报闭环。</div>`,
    foot: '<button class="btn btn-primary" data-ok>我已保存凭证，关闭</button>',
  })
  modal.el.querySelector('#onboard-copy-all').onclick = () => {
    const result = copyText(guideText)
    if (result && typeof result.then === 'function') result.catch(() => {})
  }
}
