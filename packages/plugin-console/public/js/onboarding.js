/** 接入指引生成器：手动注册 Agent / AI 应用成功后，按平台接入规范自动生成可执行指引（附刚颁发的凭证）。 */
import { esc, openModal, copyText } from './ui.js'

const base = () => location.origin

/** Agent 接入指引全文（可直接交给执行 Agent 照做；凭证已填好）。 */
export function buildAgentOnboardingText(agent, credential) {
  const origin = base()
  return `【任务】按《榕器平台 · Agent 接入指引》完成下方 Agent 的接入验证与提报更新。平台地址：${origin}

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

【第 2 步 · 接入验证（"发一句话"）】
curl -s ${origin}/api/agents -H "Authorization: Bearer <token>"
→ 返回 200 且列表中能找到 Agent ID「${agent.id}」即接入成功（平台审计留痕 agent.verify）。

【第 3 步 · 提报更新（自主更新资料）】
curl -s -X PATCH ${origin}/api/agents/${agent.id} \\
  -H "Authorization: Bearer <token>" -H 'content-type: application/json' \\
  -d '{"attrs":{"description":"<最新描述，可注明版本号>","tags":["<版本号，如 v1.0.0>"]}}'
→ attrs 为白名单制：白名单外字段（含 version，放 attrs 或请求顶层都一样）静默丢弃——返回 200 但不落库。
  版本登记：通用版本写 tags / description；提示词版本用 systemPromptVersion（上线必填）。PATCH 后 GET 复核生效。

【第 4 步 · 计量自推（可选）】
仅绕过平台网关直连外部资源时需要：POST ${origin}/api/usage/record（凭自身凭证即可，凭证默认含 usage.write）。
经平台网关的调用已自动计量，禁止双计。

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
4. 失败锁定：换牌连续失败 5 次锁来源 IP 15 分钟，重试前先核对凭证。`
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
