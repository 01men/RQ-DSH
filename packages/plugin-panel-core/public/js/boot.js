/**
 * 面板启动引导：BASE 推导修正 + 票据免登 + 宿主连接探测 + 动态装载应用。
 *
 * BASE 修正（review-dsh-agent-panel-v2 Phase 1 第 5 条）：console api.js 的
 * `new URL('.', baseURI)` 在 /rq/panel/ 下会推导成 /rq/panel（缺陷），这里改为
 * 「截取 /panel 前缀之前的部分」——独立形态 /panel/ → ''，挂载形态 /rq/panel/ → '/rq'。
 *
 * M2 宿主连接探测（fresh-install 铁律）：装好插件的全新 dsh 上，面板启动时向本机
 * 插件的 /rqcard/link 问一次「连的哪个宿主」——
 *   - remote：令牌作用域切到该宿主 + 全部 API 走本机远端代理（api.js setRemoteProxy）；
 *   - none 且无会话：渲染连接向导（wizard.js）——选宿主/扫描 IP/本机初始化/登录；
 *   - local / 探测失败（独立形态未装 rq-card）：维持既有行为。
 * 向导端点在 /rq（非 /api）命名空间，须带 x-rqcard-call 头（服务端 CSRF 防线）。
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
 * 宿主桥探测 + 宿主会话直通（登录打通）：dsh 宿主下 rq_sid Cookie 已绑定宿主身份时，
 * 经 POST /dsh-bridge/session（同源收紧）兑换平台会话——零二次登录。
 * 路径必须根绝对（不带 BASE）：/dsh-bridge/* 注册在 dsh webServer 根上，挂载形态并不落在 /rq 之内
 * （带 BASE 会请求 /rq/dsh-bridge/* → 剥前缀后无此路由 → 静默 miss）。
 * 独立形态下 /dsh-bridge/* 不存在（回落 SPA HTML → json 为 null），静默跳过。
 * 返回 hostBridge 供面板侧栏决定是否展示「Agent 对话」入口（仅 dsh 宿主形态有对话面）。
 */
async function hostBridgeSession() {
  try {
    const statusPayload = await fetch('/dsh-bridge/status').then((r) => r.json()).catch(() => null)
    if (!statusPayload?.data?.bound) return { hostBridge: false }
    if (!localStorage.getItem(TOKEN_KEY)) {
      const payload = await fetch('/dsh-bridge/session', { method: 'POST' })
        .then((r) => r.json()).catch(() => null)
      if (payload?.ok) saveSession(payload.data)
    }
    return { hostBridge: true }
  } catch {
    return { hostBridge: false }
  }
}

/**
 * 宿主连接探测（M2）：GET /rqcard/link（免登命名空间 + 向导头）。
 * 返回 null = 端点不存在（独立形态/旧版本插件），按本机模式继续。
 */
async function probeHostLink() {
  try {
    const response = await fetch(`${BASE}/rqcard/link`, { headers: { 'x-rqcard-call': '1' } })
    const payload = await response.json().catch(() => null)
    if (!response.ok || payload?.ok !== true) return null
    return payload.data ?? null
  } catch {
    return null
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
  const { hostBridge } = await hostBridgeSession()

  // 宿主连接探测：remote 切换令牌作用域与代理；none 且无会话 → 连接向导（fresh-install 首启体验）
  const hostLink = await probeHostLink()
  const apiModule = await import('./api.js')
  let remoteHub = null
  if (hostLink?.mode === 'remote' && hostLink.hubBase) {
    remoteHub = { hubBase: hostLink.hubBase, hubMountPrefix: hostLink.hubMountPrefix ?? '' }
    apiModule.setConnectionScope(hostLink.hubBase)
    apiModule.setRemoteProxy(true)
  }
  if (hostLink?.mode === 'none' && !apiModule.session.token) {
    const wizard = await import('./wizard.js')
    document.getElementById('app').dataset.booted = '1'
    wizard.start({ base: BASE, hostBridge, localFirstRun: hostLink.localFirstRun === true })
    return
  }

  const app = await import('./app.js')
  document.getElementById('app').dataset.booted = '1'
  app.start({ base: BASE, hostBridge, remoteHub })
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
