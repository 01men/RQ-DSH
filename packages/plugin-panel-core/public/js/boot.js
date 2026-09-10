/**
 * 面板启动引导：BASE 推导修正 + 票据免登 + 宿主连接探测 + 动态装载应用。
 *
 * BASE 修正（review-dsh-agent-panel-v2 Phase 1 第 5 条）：console api.js 的
 * `new URL('.', baseURI)` 在 /gate01/panel/ 下会推导成 /gate01/panel（缺陷），这里改为
 * 「截取 /panel 前缀之前的部分」——独立形态 /panel/ → ''，挂载形态 /gate01/panel/ → '/gate01'。
 *
 * M2 宿主连接探测（fresh-install 铁律）：装好插件的全新 dsh 上，面板启动时向本机
 * 插件的 /rqcard/link 问一次「连的哪个宿主」——
 *   - remote：令牌作用域切到该宿主 + 全部 API 走本机远端代理（api.js setRemoteProxy）；
 *   - none 且无会话：渲染连接向导（wizard.js）——地址输入/扫描/登录（连接统一语义）；
 *   - local / 探测失败（独立形态未装 rq-card）：维持既有行为。
 * 向导端点在 /gate01（非 /api）命名空间，须带 x-rqcard-call 头（服务端 CSRF 防线）。
 */
const path = location.pathname
const panelIdx = path.indexOf('/panel')
export const BASE = panelIdx > 0 ? path.slice(0, panelIdx) : ''

const TOKEN_KEY = 'gate01_token'
const REFRESH_KEY = 'gate01_refresh'
const USER_KEY = 'gate01_user'

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

/**
 * 远端形态票据兑换（G1 回跳闭环的消费侧）：宿主签发的回跳票据必须回宿主兑换
 * （本机 authn 兑不了别家的票）——经本机插件代理转发（白名单端点 + 向导头），
 * 兑得的宿主会话按连接作用域隔离保存（gate01_token@<hubBase>），与本机/其他连接互不串台。
 */
async function exchangeEntryTicketRemote(ticket, apiModule) {
  const response = await fetch(`${BASE}/rqcard/proxy/api/auth/entry-ticket-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rqcard-call': '1' },
    body: JSON.stringify({ ticket }),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.ok === false) throw new Error(payload?.error?.message ?? '票据兑换失败')
  apiModule.session.save(payload.data.token, payload.data.user)
  if (payload.data.refreshToken) apiModule.session.saveRefresh(payload.data.refreshToken)
}

/**
 * 一次性回跳票据提取：query `?entry_ticket=`（门户/钉钉「打开即工作台」传统入口）
 * 与 fragment `#entry_ticket=`（G1 跨源回跳形态：宿主登录页按 next 回跳时把票据放
 * fragment，避免服务端 302 携带）均收。
 */
function takeEntryTicket() {
  const fromQuery = new URLSearchParams(location.search).get('entry_ticket')
  if (fromQuery) return { ticket: fromQuery, where: 'query' }
  if (location.hash.includes('entry_ticket=')) {
    const raw = location.hash.replace(/^#/, '').replace(/^\/+/, '').replace(/^\?/, '')
    const fromHash = new URLSearchParams(raw).get('entry_ticket')
    if (fromHash) return { ticket: fromHash, where: 'hash' }
  }
  return null
}

/** 票据即用即清（不常驻地址栏）：query 形态仅剔除票据参数，fragment 形态整段移除。 */
function clearEntryTicket(found) {
  if (found.where === 'hash') {
    window.history.replaceState(null, '', `${location.pathname}${location.search}`)
    return
  }
  const params = new URLSearchParams(location.search)
  params.delete('entry_ticket')
  const rest = params.toString()
  window.history.replaceState(null, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`)
}

function saveSession(data) {
  localStorage.setItem(TOKEN_KEY, data.token)
  localStorage.setItem(USER_KEY, JSON.stringify(data.user))
  if (data.refreshToken) localStorage.setItem(REFRESH_KEY, data.refreshToken)
}

/**
 * 同源控制台会话直通（独立形态 G1 补环）：控制台已登录（同源可见 heng_ops_token）而面板
 * 无会话时，自助签发一次性 entry_ticket（≤120s，console.login 权限面）并即兑面板会话——
 * 管理员从控制台导航进面板零二次登录，不再落「无有效平台会话 → 去控制台登录 →
 * next 被已登录态忽略」的死循环。remote 连接形态不走本机票（作用域隔离，天然无同源控制台
 * 会话）；签票/兑换任一步失败诚实降级为既有引导页，不阻断启动。
 */
async function consoleSessionPassthrough() {
  let consoleToken = ''
  try { consoleToken = localStorage.getItem('heng_ops_token') ?? '' } catch { return }
  if (!consoleToken || localStorage.getItem(TOKEN_KEY)) return
  try {
    const response = await fetch(`${BASE}/api/auth/entry-tickets/self`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${consoleToken}` },
      body: JSON.stringify({}),
    })
    const payload = await response.json().catch(() => null)
    const ticket = payload?.data?.ticket
    if (!response.ok || !ticket) return
    await exchangeEntryTicket(ticket)
  } catch { /* 直通失败按未登录处理（引导页仍可用） */ }
}

/**
 * 宿主桥探测 + 宿主会话直通（登录打通）：dsh 宿主下 rq_sid Cookie 已绑定宿主身份时，
 * 经 POST /dsh-bridge/session（同源收紧）兑换平台会话——零二次登录。
 * 路径必须根绝对（不带 BASE）：/dsh-bridge/* 注册在 dsh webServer 根上，挂载形态并不落在 /gate01 之内
 * （带 BASE 会请求 /gate01/dsh-bridge/* → 剥前缀后无此路由 → 静默 miss）。
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
  // 宿主连接探测先行：票据兑换的路由依赖连接形态（remote=宿主签发的票据须回宿主兑换）
  const hostLink = await probeHostLink()
  const apiModule = await import('./api.js')
  const remoteMode = hostLink?.mode === 'remote' && Boolean(hostLink.hubBase)
  if (remoteMode) {
    apiModule.setConnectionScope(hostLink.hubBase)
    apiModule.setRemoteProxy(true)
  }
  // 票据免登（「打开即工作台」/ G1 回跳通道）：票据只进请求体，兑换后立即从地址栏清除。
  // 兑换路由按连接形态：remote 经代理回宿主（会话落连接作用域）；本机/独立形态本机兑换。
  const found = takeEntryTicket()
  if (found) {
    try {
      if (remoteMode) await exchangeEntryTicketRemote(found.ticket, apiModule)
      else await exchangeEntryTicket(found.ticket)
    } catch { /* 兑换失败按未登录处理 */ }
    clearEntryTicket(found)
  }
  // 会话链：已有令牌 → 票据 → 同源控制台会话直通（独立形态管理员零二次登录）
  // → 宿主 Cookie 直通（dsh 宿主内点入面板零二次登录）
  if (!remoteMode && !apiModule.session.token) await consoleSessionPassthrough()
  const { hostBridge } = await hostBridgeSession()

  // 宿主连接探测结果落地：remote 时令牌作用域与代理已在上方就位；none 且无会话 → 连接向导
  // （fresh-install 首启体验）
  let remoteHub = null
  let app = null
  if (remoteMode) remoteHub = { hubBase: hostLink.hubBase, hubMountPrefix: hostLink.hubMountPrefix ?? '' }
  if (hostLink?.mode === 'none' && !apiModule.session.token) {
    // 演示态探测（plan-gate01 决策 2）：只读面板 API 匿名可达 = demoAuth 装态——
    // 直接进入演示看板（横幅引导连接），不把用户挡在向导里；严格态（401）才渲染向导。
    let demoOk = false
    try {
      const probe = await fetch(`${BASE}/api/panel/depts`, { headers: { accept: 'application/json' } })
      demoOk = probe.ok
    } catch { /* 探测失败按严格态处理 */ }
    document.getElementById('app').dataset.booted = '1'
    if (demoOk) {
      app = await import('./app.js')
      app.start({ base: BASE, hostBridge, remoteHub: null, demoMode: true })
      return
    }
    const wizard = await import('./wizard.js')
    wizard.start({ base: BASE, hostBridge })
    return
  }

  app = await import('./app.js')
  app.start({ base: BASE, hostBridge, remoteHub, demoMode: hostLink?.mode === 'none' })
}

bootstrap().catch((error) => {
  // 加载失败页（QA BUG-U-10）：一线用户面对英文堆栈无所适从——给明确动作（重新加载），
  // 技术详情折叠进「联系管理员时出示」区域，不再裸奔 40 行堆栈。
  const message = String(error?.message ?? error).replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[ch])
  const stack = String(error?.stack ?? '').replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[ch])
  const app = document.getElementById('app')
  if (app) app.innerHTML = `
    <div class="login-guide">
      <h1>🌳 工作台暂时没有加载起来</h1>
      <p>通常是网络波动或服务正在重启，稍等片刻再试即可。<br>若反复出现，请联系管理员并出示下方「技术详情」。</p>
      <button class="btn primary" onclick="location.reload()">重新加载</button>
      <details style="margin-top:16px;text-align:left">
        <summary style="cursor:pointer;color:#6b7280;font-size:12px">技术详情（联系管理员时提供）</summary>
        <pre style="text-align:left;font-size:11px;color:#6b7280;white-space:pre-wrap;max-height:220px;overflow:auto">${message}${stack ? `\n${stack}` : ''}</pre>
      </details>
    </div>`
})
window.addEventListener('error', (event) => {
  // 预启动脚本异常：一线用户不需要原始报错——只留一条中性提示（详情在浏览器控制台）
  const app = document.getElementById('app')
  if (app && !app.dataset.booted) {
    app.insertAdjacentHTML('beforeend', '<div class="boot-alert">页面加载出现异常，请刷新重试；若反复出现请联系管理员（详情见浏览器控制台）</div>')
  }
})
