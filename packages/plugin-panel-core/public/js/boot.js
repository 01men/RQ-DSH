/**
 * 面板启动引导：BASE 推导修正 + 票据免登 + 动态装载应用。
 *
 * BASE 修正（review-dsh-agent-panel-v2 Phase 1 第 5 条）：console api.js 的
 * `new URL('.', baseURI)` 在 /rq/panel/ 下会推导成 /rq/panel（缺陷），这里改为
 * 「截取 /panel 前缀之前的部分」——独立形态 /panel/ → ''，挂载形态 /rq/panel/ → '/rq'。
 */
const path = location.pathname
const panelIdx = path.indexOf('/panel')
export const BASE = panelIdx > 0 ? path.slice(0, panelIdx) : ''

const TOKEN_KEY = 'heng_ops_token'
const REFRESH_KEY = 'heng_ops_refresh'
const USER_KEY = 'heng_ops_user'

async function exchangeEntryTicket(ticket) {
  const response = await fetch(`${BASE}/api/auth/entry-ticket-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticket }),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.ok === false) throw new Error(payload?.error?.message ?? '票据兑换失败')
  saveSession(payload.data)
}

function saveSession(data) {
  localStorage.setItem(TOKEN_KEY, data.token)
  localStorage.setItem(USER_KEY, JSON.stringify(data.user))
  if (data.refreshToken) localStorage.setItem(REFRESH_KEY, data.refreshToken)
}

/**
 * 宿主会话直通（登录打通）：dsh 宿主下 rq_sid Cookie 已绑定宿主身份时，
 * 经 POST /dsh-bridge/session（同源收紧）兑换平台会话——零二次登录。
 * 独立形态下 /dsh-bridge/* 不存在（回落 SPA HTML → json 为 null），静默跳过。
 */
async function bridgeSession() {
  try {
    const statusPayload = await fetch(`${BASE}/dsh-bridge/status`).then((r) => r.json()).catch(() => null)
    if (!statusPayload?.data?.bound) return false
    const payload = await fetch(`${BASE}/dsh-bridge/session`, { method: 'POST' })
      .then((r) => r.json()).catch(() => null)
    if (!payload?.ok) return false
    saveSession(payload.data)
    return true
  } catch {
    return false
  }
}

async function bootstrap() {
  // 票据免登（dsh 宿主「打开即工作台」通道）：票据只进请求体，兑换后立即从地址栏清除
  const params = new URLSearchParams(location.search)
  const ticket = params.get('entry_ticket')
  if (ticket) {
    try {
      await exchangeEntryTicket(ticket)
    } catch { /* 兑换失败按未登录处理 */ }
    params.delete('entry_ticket')
    const rest = params.toString()
    history.replaceState(null, '', `${path}${rest ? `?${rest}` : ''}${location.hash}`)
  }
  // 会话链：已有令牌 → 票据 → 宿主 Cookie 直通（dsh 宿主内点入面板零二次登录）
  if (!localStorage.getItem(TOKEN_KEY)) {
    await bridgeSession()
  }
  const app = await import('./app.js')
  document.getElementById('app').dataset.booted = '1'
  app.start({ base: BASE })
}

bootstrap().catch((error) => {
  const app = document.getElementById('app')
  if (app) app.innerHTML = `<div class="login-guide"><h1>面板加载失败</h1><p>${String(error?.message ?? error).replace(/</g, '&lt;')}</p><pre style="text-align:left;font-size:11px;color:#6b7280">${String(error?.stack ?? '').replace(/</g, '&lt;')}</pre></div>`
})
window.addEventListener('error', (event) => {
  const app = document.getElementById('app')
  if (app && !app.dataset.booted) {
    app.insertAdjacentHTML('beforeend', `<pre style="position:fixed;bottom:0;left:0;font-size:10px;color:#ef4444;background:#fff;padding:4px;z-index:999">${String(event.message ?? '').replace(/</g, '&lt;')}</pre>`)
  }
})
