/**
 * 错误文案共享模块（WP-06/C3）：原因码 → 文案 + 行动按钮，全控制台集中一处。
 *
 * 纪律（DoD「错误文案映射完整性」）：任何新增对外原因码必须同步本表，
 * selftest 枚举全部代码并断言漏配即红。模块保持零依赖（selftest 直接 import 校验）。
 *
 * 原因码全集（初始六条 + 绑定族 + 会话侧兜底码，来源：docs/action-plan-dsh-frontend.md §三 C2/C3 + spike E3）：
 *   nas-authz-deny    NAS 数据权限五步判定 deny（fail-closed）
 *   breaker-open      MCP 服务熔断器开启（连续失败≥3 次置位）
 *   quota-exhausted   钱包余额/月度预算耗尽（quota.exceeded）
 *   pdp-unreachable   权限判定点不可达（保护性拒绝，P0-2 红线）
 *   degraded          服务健康 degraded（延迟>800ms，30s 轮询探活）
 *   binding-invalid   平台身份绑定失效（含 no_cookie / expired / account_inactive 细分）
 *   invoke-error      工具执行报错且无平台侧原因码时的兜底（rq-card 会话卡语义，WP-06 报备决议）
 */

export const ERROR_CODES = [
  'nas-authz-deny',
  'breaker-open',
  'quota-exhausted',
  'pdp-unreachable',
  'degraded',
  'binding-invalid',
  'invoke-error',
] /** 绑定失效细分原因码（dsh-bridge /dsh-bridge/status 返回） */
export const BINDING_REASONS = ['no_cookie', 'expired', 'account_inactive']

const COPY = {
  'nas-authz-deny': {
    tone: 'danger',
    title: '暂无该数据的访问权限',
    message: '本次访问被数据权限策略拦截（保护性拒绝）。如因工作需要，可发起访问申请，审批通过后即可使用。',
    action: { label: '申请访问', href: '#/nas-authz' },
  },
  'breaker-open': {
    tone: 'warn',
    title: '服务熔断中，正在自动恢复',
    message: '该服务连续调用失败已触发熔断保护，暂拒绝调用；探活恢复后自动闭合，无需人工处理。',
    action: { label: '查看服务健康', href: '#/mcp' },
  },
  'quota-exhausted': {
    tone: 'danger',
    title: '额度已耗尽',
    message: '本主体余额或月度预算已用完，调用被暂停。可查看用量明细，或联系管理员调整预算。',
    action: { label: '查看用量与额度', href: '#/assets' },
  },
  'pdp-unreachable': {
    tone: 'warn',
    title: '权限检查服务暂不可用',
    message: '为守住安全红线，权限判定不可达时一律保护性拒绝。服务恢复后请重试；紧急情况请联系平台管理员。',
    action: null,
  },
  degraded: {
    tone: 'info',
    title: '服务响应有点慢',
    message: '该服务当前处于降级运行（延迟偏高），调用仍在继续。如长时间未恢复，系统会转后台并经钉钉通知你。',
    action: null,
  },
  'binding-invalid': {
    tone: 'danger',
    title: '身份绑定已失效',
    message: '当前浏览器与平台账号的绑定已失效（可能是过期、退出或账号状态变化）。重新绑定后即可继续使用宿主对话与归因能力。',
    action: { label: '一键重绑', href: '/auth/oidc/start', external: true },
  },
  'invoke-error': {
    tone: 'danger',
    title: '本次调用执行出错',
    message: '工具执行返回错误（非权限/额度原因）。可重试一次；持续失败请到服务详情查看健康与调用记录。',
    action: { label: '查看调用记录', href: '#/mcp' },
  },
}

/** 绑定细分原因 → 归并到 binding-invalid 的提示补充。 */
const BINDING_DETAIL = {
  no_cookie: '尚未完成身份绑定。',
  expired: '绑定已过期（默认 24 小时），重新登录即可续期。',
  account_inactive: '账号状态异常（冻结/离职联动失效），请联系管理员确认账号状态。',
}

/** 查文案：未知原因码回落通用兜底（永不裸奔技术错误）。 */
export function errorCopy(code, detail) {
  const base = COPY[code] ?? {
    tone: 'danger',
    title: '操作暂时无法完成',
    message: `平台返回未知状态（${code || 'unknown'}）。请稍后重试；若持续出现，请联系平台管理员。`,
    action: null,
  }
  const extra = code === 'binding-invalid' && detail && BINDING_DETAIL[detail] ? BINDING_DETAIL[detail] : ''
  return { ...base, ...(extra ? { message: `${base.message}（${extra}）` } : {}) }
}

/** 渲染横幅/条状提示（返回 HTML 字符串；调用方负责挂载与按钮跳转）。 */
export function errorBarHtml(code, detail) {
  const copy = errorCopy(code, detail)
  const toneColor = copy.tone === 'danger' ? 'var(--danger)' : copy.tone === 'warn' ? 'var(--warn)' : 'var(--info)'
  const toneBg = copy.tone === 'danger' ? 'var(--danger-bg)' : copy.tone === 'warn' ? 'var(--warn-bg)' : 'var(--info-bg)'
  const action = copy.action
    ? `<a class="btn btn-sm ${copy.tone === 'danger' ? 'btn-primary' : 'btn-default'}" data-error-action="1"
        href="${copy.action.href}" ${copy.action.external ? 'target="_top" rel="noopener"' : ''} style="margin-left:12px">${copy.action.label}</a>`
    : ''
  return `<div class="flex error-bar" role="alert" data-error-code="${code}"
    style="gap:10px;padding:10px 14px;border:1px solid ${toneColor}33;background:${toneBg};border-radius:var(--radius);margin-bottom:16px">
    <span style="color:${toneColor};display:flex">${copy.tone === 'info' ? 'ℹ️' : '⚠️'}</span>
    <div class="grow"><div class="fs-13" style="font-weight:600">${copy.title}</div>
    <div class="fs-12 text-3">${copy.message}</div></div>${action}</div>`
}
