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
  localStorage.setItem(TOKEN_KEY, payload.data.token)
  localStorage.setItem(USER_KEY, JSON.stringify(payload.data.user))
  if (payload.data.refreshToken) localStorage.setItem(REFRESH_KEY, payload.data.refreshToken)
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
