/**
 * 部门 Agent 工作台（review-dsh-agent-panel-v2 F1-F13 落地）：
 * 顶栏（行业选择器/⌘K/钉钉状态胶囊）+ 部门 rail + 三栏（Agent 名册+频道 / 四 Tab 协作区 / widget 看板）。
 * 一切数据来自 /api/panel/* 与 /api/dingtalk/*；XSS 白名单渲染；SSE 优先 + 轮询降级（realtime.js 复用）。
 */
import { api, session, setBase as apiSetBase, ApiError } from './api.js'
import { setBase as depsSetBase, ui as uiDep, realtime as realtimeDep } from './deps.js'

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

export function esc(text) {
  // 引号一并转义（QA BUG-U-06）：本函数大量输出进 HTML 属性位（data-* / title），
  // 不转义双引号=用户可控值可在属性内闭合注入事件（存储型 XSS）。
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * 白名单渲染（治理 DoD：XSS 面）：先全量转义，再仅放行 <b> 与 mention span——
 * 服务端种子/Agent 产出的轻标记可渲染，任何其他 HTML 一律按文本显示。
 * 注意 esc 现已转义引号，放行模式同步适配 &quot;/&#39; 形态（种子用单引号 span）。
 */
export function md(text) {
  let s = esc(text)
  s = s.replaceAll('&lt;b&gt;', '<b>').replaceAll('&lt;/b&gt;', '</b>')
  s = s.replaceAll(`&lt;span class=&#39;mention&#39;&gt;`, '<span class="mention">')
  s = s.replaceAll('&lt;span class=&quot;mention&quot;&gt;', '<span class="mention">')
  s = s.replaceAll(`&lt;span class='mention'&gt;`, '<span class="mention">')
  s = s.replaceAll('&lt;span class="mention"&gt;', '<span class="mention">')
  s = s.replaceAll('&lt;/span&gt;', '</span>')
  // 纯文本里的 @提及（无 HTML 包裹）高亮
  s = s.replace(/(^|[\s（(])@([\p{L}\p{N}·]{2,20})/gu, '$1<span class="mention">@$2</span>')
  return s
}

const stars = (n) => '★'.repeat(n) + '☆'.repeat(4 - n)
const pad2 = (n) => String(n).padStart(2, '0')
/** 本地时区展示（QA BUG-U-01）：此前直接切片 UTC ISO 串，中国用户全部慢 8 小时。 */
const fmtTime = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
const TAG_CLS = { 提质: 'tg-tz', 降本: 'tg-jb', 增效: 'tg-zx', 节能: 'tg-jn', 新模式: 'tg-xm' }
const LANE_LABELS = { todo: '待办', doing: '进行中', review: '待审', done: '完成' }
const LANE_ORDER = ['todo', 'doing', 'review', 'done']
const ART_KINDS = { report: '报告', order: '工单', quote: '报价', diagnosis: '诊断', other: '沉淀' }

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

const state = {
  hostBridge: false,
  /** 演示态（plan-gate01 决策 2）：宿主连接为 none 时展示内置演示数据横幅。 */
  demoMode: false,
  /** 远端宿主连接（形态 C）：{ hubBase, hubMountPrefix }；null=本机/未连接。 */
  remoteHub: null,
  /** 双轨视图：workbench=部门工作台（三栏） / board=战略看板（/panel 面自持看板）。 */
  view: location.hash === '#/board' ? 'board' : 'workbench',
  boardPlatform: localStorage.getItem('panel_board_platform') ?? '',
  depts: [],
  dept: localStorage.getItem('panel_dept') ?? 'mfg',
  overview: null,
  industries: [],
  industry: null,
  ddStatus: null,
  bridges: [],
  // C1-1 信息架构收敛：进入即对话框——boot 不再恢复上次 Tab，班组长打开面板第一眼是对话
  tab: 'chat',
  channelId: localStorage.getItem('panel_channel') ?? '',
  messages: [],
  tasks: [],
  artifacts: [],
  scenegraph: null,
  ddSync: localStorage.getItem('panel_ddsync') === '1',
  /** 模型目录（与 dsh 服务共用 modelgw 事实源）；chatModel='' 表示跟随各 Agent 资产配置。 */
  models: [],
  chatModel: localStorage.getItem('panel_chat_model') ?? '',
  /** 可直调技能清单（C1-2：skillhub published 且对当前账号组织开放；空=不展示技能入口）。 */
  skills: [],
  stream: null,
  streamDept: '',
  /** 实时通道健康（QA BUG-U-02）：downgraded=轮询降级态；lastRealtimeAt=最后收到数据时刻；
   *  stale=轮询连续失败（数据可能过期）——徽标必须如实反映，不许断网仍标 LIVE。 */
  streamDowngraded: false,
  streamStale: false,
  lastRealtimeAt: 0,
}

/** 实时平台 chip 展示名（QA P2-6）：此前直接显示英文原始 id。 */
const PLATFORM_LABELS = { strategy: '战略', marketing: '营销', manufacturing: '制造', rd: '研发', quality: '质量' }

/** 嵌套防护（M3）：?embed=1（dsh「01门工作台」视图 Tab 内嵌本面板）或自身已在 iframe 中 = 嵌入形态——
 *  嵌入态不再内嵌 dsh 对话（防 iframe 递归），侧栏「Agent 对话」入口隐藏。 */
const EMBEDDED = new URLSearchParams(location.search).has('embed') || (() => {
  try { return window.self !== window.top } catch { return true }
})()

/** 「Agent 对话」默认内嵌 dsh 标准对话（默认 Agent 交互面，M3）：hostBridge=dsh 对话面在场；
 *  用户可用「使用内置协作会话」退回（panel_chat_embed_off），退回后 at-row 提供「改用 dsh 对话」。 */
function canEmbedDshChat() {
  return state.hostBridge && !EMBEDDED && localStorage.getItem('panel_chat_embed_off') !== '1'
}

async function toast(message, type) {
  const mod = await uiDep()
  mod.toast(message, type)
}

function showModal(title, bodyHtml) {
  const mask = document.getElementById('mask')
  document.getElementById('modalTitle').textContent = title
  document.getElementById('modalBody').innerHTML = bodyHtml
  mask.classList.add('show')
}

function hideModal() {
  document.getElementById('mask').classList.remove('show')
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

export function start({ base, hostBridge = false, remoteHub = null, demoMode = false }) {
  apiSetBase(base)
  depsSetBase(base)
  state.hostBridge = hostBridge
  state.remoteHub = remoteHub
  state.demoMode = demoMode
  if (!session.token && !demoMode) {
    renderLoginGuide()
    return
  }
  // 先落外壳骨架（数据慢/失败时页面不再是白屏），数据加载失败显式提示
  renderShell()
  renderTopRight()
  window.addEventListener('hashchange', () => {
    state.view = location.hash === '#/board' ? 'board' : 'workbench'
    applyView()
  })
  // 会话中途过期（QA BUG-U-05）：api.js 刷新失败即广播，此处统一切回登录引导
  // （远端连接态会导向重连向导），不再让用户对着每次操作失败的 toast 摸不着头脑
  window.addEventListener('panel:session-expired', () => {
    if (document.getElementById('app')?.dataset.booted) renderLoginGuide()
  })
  // 通道健康看门狗（QA BUG-U-02）：轮询降级态下超过 95s（3 轮 + 余量）无任何数据到达，
  // 徽标转「连接中断」并可点击重连——不许断网后仍宣称实时
  window.setInterval(() => {
    if (!state.streamDowngraded || state.streamStale) {
      if (!state.streamDowngraded && state.streamStale) { state.streamStale = false; renderLiveBadge() }
      return
    }
    if (state.lastRealtimeAt > 0 && Date.now() - state.lastRealtimeAt > 95_000) {
      state.streamStale = true
      renderLiveBadge()
    }
  }, 15_000)
  void init()
}

function renderLoginGuide() {
  // 远端连接态（形态 C）：会话失效时回到连接向导重连/重登，而不是误导向本机控制台
  if (state.remoteHub) {
    document.getElementById('app').innerHTML = `
      <div class="login-guide">
        <h1>🌳 01门 · 部门 Agent 工作台</h1>
        <p>与远端宿主（${esc(state.remoteHub.hubBase)}）的会话已失效。</p>
        <button class="btn primary" id="reopenWizard">重新连接 / 登录</button>
      </div>`
    document.getElementById('reopenWizard').onclick = async () => {
      const wizard = await import('./wizard.js')
      wizard.start({ base: basePath(), hostBridge: state.hostBridge })
    }
    return
  }
  // 回跳语义：登录成功后带 ?next= 回到面板（登录页消费一次），不再让业务员落在控制台后自己找路
  // 尾斜杠不能省：/gate01 不带斜杠会触发 302 → /gate01/，重定向把 #/login fragment 与 next 参数一并吃掉
  const here = encodeURIComponent(location.pathname + location.search + location.hash)
  document.getElementById('app').innerHTML = `
    <div class="login-guide">
      <h1>🌳 01门 · 部门 Agent 工作台</h1>
      <p>当前浏览器没有有效的平台会话。<br>
      请从控制台登录后进入，或从钉钉/门户的「打开即工作台」入口点入（自动票据免登）。</p>
      <a href="${basePath() || '/'}/?next=${here}#/login"><button class="btn primary">去控制台登录</button></a>
    </div>`
}

async function init() {
  document.body.insertAdjacentHTML('beforeend', `
    <div class="modal-mask" id="mask">
      <div class="modal">
        <div class="modal-h"><span class="t" id="modalTitle"></span><span class="x" id="modalX">✕</span></div>
        <div class="modal-b" id="modalBody"></div>
      </div>
    </div>`)
  document.getElementById('modalX').onclick = hideModal
  document.getElementById('mask').addEventListener('click', (event) => {
    if (event.target.id === 'mask') hideModal()
  })

  try {
    const [deptsRes, indRes] = await Promise.all([api.get('/api/panel/depts'), api.get('/api/panel/industries')])
    state.depts = deptsRes.depts
    state.industries = indRes.industries
    // 部门范围权限（账号组织打通）：无权限的部门不可作为当前部门
    const allowedDepts = state.depts.filter((dept) => dept.allowed !== false)
    if (!allowedDepts.some((dept) => dept.id === state.dept)) state.dept = allowedDepts[0]?.id ?? state.dept
    state.industry = state.industries.find((item) => item.state === 'active') ?? null
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      session.clear()
      renderLoginGuide()
      return
    }
    document.getElementById('app').innerHTML = `<div class="login-guide"><h1>面板数据加载失败</h1><p>${esc(error.message)}</p></div>`
    return
  }

  void refreshDingtalk()
  renderShell()
  await refreshModels()
  await loadSkills()
  await switchDept(state.dept, { keepTab: true })
  connectStream()
  window.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      openCmdk()
    }
  })
}

async function refreshDingtalk() {
  try {
    const [status, bridges] = await Promise.all([api.get('/api/dingtalk/status'), api.get('/api/dingtalk/bridges')])
    state.ddStatus = status
    state.bridges = bridges.bridges
  } catch {
    state.ddStatus = null
    state.bridges = []
  }
  renderTopRight()
}

/** 模型目录（GET /api/panel/models，panel.read）：失败时置空（composer 退化为「未接入模型」提示）。 */
async function refreshModels() {
  try {
    state.models = (await api.get('/api/panel/models')).models ?? []
  } catch {
    state.models = []
  }
}

/** 可直调技能清单（C1-2，GET /api/panel/:dept/skills）：拿不到就置空——不展示技能入口，
 *  不假装可用；直调本身的失败在执行卡里大声报（诚实降级分层：清单是便利性，直调是承诺）。 */
async function loadSkills() {
  try {
    state.skills = (await api.get(`/api/panel/${state.dept}/skills`)).skills ?? []
  } catch {
    state.skills = []
  }
}

// ---------------------------------------------------------------------------
// 实时通道（SSE 优先 + 轮询降级；复用 console realtime.js）
// H4：stream URL 首选一次性短时 ticket（POST /api/panel/stream-ticket 换取，消费即焚），
// 长效 access token 不再进 URL/代理日志；ticket 获取失败回落 ?token= 旧通道。
// H2：onPollError 连续失败 ≥3 轮（约 95s）→「连接中断·点击重试」徽标；成功自愈自动恢复。
// ---------------------------------------------------------------------------

const POLL_FAIL_BADGE_THRESHOLD = 3

function connectStream() {
  if (state.stream && state.streamDept === state.dept) return
  if (state.stream) { try { state.stream.close() } catch { /* 已关闭 */ } }
  state.streamDept = state.dept
  state.streamDowngraded = false
  state.streamStale = false
  state.lastRealtimeAt = Date.now() // 建流观察窗：首轮数据到达前不误报中断
  renderLiveBadge()
  // 远端形态（C）：数据面走本机代理——SSE 会被代理显式拒绝（代理不持流，403 触发既有降级），
  // 轮询路径同样映射到代理（面板 REST 白名单内），请求须带向导头（/rqcard/* 免登命名空间防线）
  const remote = Boolean(state.remoteHub)
  const streamBase = remote ? `${basePath()}/rqcard/proxy` : basePath()
  const headers = session.token ? { authorization: `Bearer ${session.token}` } : {}
  if (remote && session.token) headers['x-rqcard-call'] = '1'
  void (async () => {
    // H4/P2-O-5：URL 不再携带长效 access token——先换 ≤60s 一次性 stream ticket（消费即焚）；
    // 票据面不可用（旧版后端/权限缺失）回落 ?token= 旧通道
    let url = `${streamBase}/api/panel/stream?dept=${state.dept}&token=${encodeURIComponent(session.token)}`
    try {
      const ticket = await api.post('/api/panel/stream-ticket', { dept: state.dept })
      if (ticket?.ticket) url = `${streamBase}/api/panel/stream?dept=${state.dept}&ticket=${encodeURIComponent(ticket.ticket)}`
    } catch { /* 票据面不可用：回落 token 通道 */ }
    state.stream = (await realtimeDep()).createEventStream({
      url,
      pollPath: `${streamBase}/api/panel/${state.dept}/poll`,
      pollIntervalMs: 30_000,
      headers,
      onMessage: (data) => { renderLiveBadge(); handleRealtime(data) },
      onDowngrade: () => {
        state.streamDowngraded = true
        renderLiveBadge()
      },
      // H2：轮询连续失败可观测（95s 看门狗只覆盖「完全无数据」，这里覆盖「有失败在身」）
      onPollError: (_error, info) => {
        if (info.consecutiveFailures >= POLL_FAIL_BADGE_THRESHOLD) renderLiveBadge('down')
      },
    })
    renderLiveBadge()
  })().catch(() => { /* realtime 依赖装载失败（异常环境）：静默，消息刷新退化为操作后手动拉取 */ })
}

/** 手动重连（QA BUG-U-02）：「连接中断」徽标点击后重建通道并给 95s 观察窗。 */
function reconnectStream() {
  if (state.stream) { try { state.stream.close() } catch { /* 已关闭 */ } }
  state.stream = null
  state.streamDept = ''
  state.lastRealtimeAt = Date.now()
  connectStream()
}

async function handleRealtime(data) {
  // 任何通道（SSE 事件/轮询应答）只要有数据到达就算「活着」——看门狗据此判断健康
  state.lastRealtimeAt = Date.now()
  if (state.streamStale) {
    state.streamStale = false
    renderLiveBadge()
  }
  if (!data || typeof data !== 'object') return
  if (data.name === 'panel.message.created' && data.payload) {
    const payload = data.payload
    if (payload.dept !== state.dept) return
    if (payload.channelId !== state.channelId) { void refreshOverview(); return }
    if (state.messages.some((m) => m.id === payload.messageId)) return
    try {
      const detail = await api.get(`/api/panel/${state.dept}/messages?channelId=${payload.channelId}&limit=20`)
      const fresh = detail.messages.filter((m) => !state.messages.some((x) => x.id === m.id))
      if (fresh.length > 0) {
        state.messages.push(...fresh)
        renderMessages()
        void refreshOverview()
      }
    } catch { /* 下轮轮询兜底 */ }
    return
  }
  if (data.name === 'panel.task.updated' || data.name === 'scenegraph.updated') {
    if (state.tab === 'tasks') void loadTab().then(renderMain)
    if (data.name === 'scenegraph.updated' && state.tab === 'scene') void loadTab().then(renderMain)
    return
  }
  if (data.messages) {
    // 轮询降级应答：整体刷新消息与任务
    const fresh = data.messages.filter((m) => m.channelId === state.channelId && !state.messages.some((x) => x.id === m.id))
    if (fresh.length > 0) {
      state.messages.push(...fresh)
      renderMessages()
    }
    if (JSON.stringify(data.tasks) !== JSON.stringify(state.tasks)) {
      state.tasks = data.tasks
      if (state.tab === 'tasks') renderMain()
    }
  }
}

// ---------------------------------------------------------------------------
// 外壳渲染
// ---------------------------------------------------------------------------

function renderShell() {
  const activeIndustry = state.industry
  document.getElementById('app').innerHTML = `
    ${state.demoMode ? `
    <div id="demoBanner" class="demo-banner">
      <span>🧪 当前展示的是<b>内置演示数据</b>——连接宿主后自动切换为真实看板</span>
      <button class="btn primary" id="demoOpenWizard">连接宿主</button>
    </div>` : ''}
    <div class="topbar">
      <div class="logo">🌳 01门 <span class="badge">部门工作台</span></div>
      <div class="more-sel">
        <div class="more-btn" id="moreBtn">☰ 更多</div>
        <div class="more-menu" id="moreMenu">
          <div class="more-opt" data-m="board"><span>📈</span><span>战略看板<span class="sub">平台聚合视图（经理视角）</span></span></div>
          ${session.can('panel.config.write') ? '<div class="more-opt" data-m="config"><span>⚙</span><span>面板设置<span class="sub">阵容 / 看板块 / KPI</span></span></div>' : ''}
          <div class="more-opt" data-m="models"><span>🧠</span><span>模型管理<span class="sub">接入与连通性</span></span></div>
        </div>
      </div>
      <div class="ind-sel">
        <div class="ind-btn" id="indBtn">
          <span>${esc(activeIndustry?.icon ?? '🏢')}</span><span>${esc(activeIndustry?.name ?? '未激活行业')}</span>
          <span class="${activeIndustry ? 'dotok' : 'dotlock'}"></span><span style="color:#6b7280">▾</span>
        </div>
        <div class="ind-menu" id="indMenu"></div>
      </div>
      <div class="top-search" id="cmdkTrigger"><span>搜索 Agent / 技能 / 频道 / 场景 / 同事…</span><span class="kbd">⌘K</span></div>
      <div class="top-right" id="topRight"></div>
    </div>
    <div class="body">
      <div class="rail" id="rail"></div>
      <div class="dept" id="dept"></div>
      <div class="board" id="board" style="display:none"></div>
    </div>`
  document.getElementById('indBtn').onclick = (event) => { event.stopPropagation(); renderIndMenu(); document.getElementById('indMenu').classList.toggle('show') }
  document.addEventListener('click', () => {
    document.getElementById('indMenu')?.classList.remove('show')
    document.getElementById('moreMenu')?.classList.remove('show')
  })
  // C1-1 信息架构收敛：战略看板/面板设置/模型管理收进「更多」二级入口——主界面只剩对话
  // 与执行卡；#/board 深链保留（hash 直达看板不受影响）。
  document.getElementById('moreBtn').onclick = (event) => { event.stopPropagation(); document.getElementById('moreMenu').classList.toggle('show') }
  document.querySelectorAll('.more-opt').forEach((el) => {
    el.onclick = (event) => {
      event.stopPropagation()
      document.getElementById('moreMenu')?.classList.remove('show')
      if (el.dataset.m === 'board') location.hash = '#/board'
      else if (el.dataset.m === 'config') void showConfig()
      else if (el.dataset.m === 'models') void showModels()
    }
  })
  document.getElementById('cmdkTrigger').onclick = () => openCmdk()
  // 演示横幅按钮（renderShell 模板内，重建后重绑）：唤起连接向导
  document.getElementById('demoOpenWizard')?.addEventListener('click', async () => {
    const wizard = await import('./wizard.js')
    wizard.start({ base: basePath() })
  })
  applyView()
  renderTopRight()
}

function renderIndMenu() {
  const menu = document.getElementById('indMenu')
  menu.innerHTML = state.industries.map((ind) => {
    const badge = ind.state === 'active' ? '<span class="st ok">已激活</span>'
      : ind.state === 'pending' ? '<span class="st pending">审批中</span>'
        : '<span class="st lock">🔒 待授权</span>'
    const sub = ind.state === 'active' ? `${ind.code} · 场景图谱${ind.graphLoaded ? '已挂载' : '缺位（请联系管理员）'}` : ind.sub
    return `<div class="ind-opt ${ind.state === 'active' ? 'on' : ''}" data-code="${esc(ind.code)}">
      <span style="font-size:17px">${esc(ind.icon)}</span>
      <span>${esc(ind.name)}<span class="sub">${esc(sub)}</span></span>${badge}</div>`
  }).join('') + `<div style="border-top:1px solid var(--line);margin-top:6px;padding:9px 10px;font-size:11px;color:var(--txt2)">行业场景图谱包经平台内置资产/市场分发 · 切换/使用需宿主平台授权激活（usage 计量 + audit 留痕）</div>`
  menu.querySelectorAll('.ind-opt').forEach((el) => {
    el.onclick = (event) => {
      event.stopPropagation()
      menu.classList.remove('show')
      void pickIndustry(el.dataset.code)
    }
  })
}

async function pickIndustry(code) {
  const ind = state.industries.find((item) => item.code === code)
  if (!ind) return
  if (ind.state === 'active') {
    state.industry = ind
    renderShell()
    await switchDept(state.dept, { keepTab: true })
    if (state.tab === 'scene') void loadTab().then(renderMain)
    return
  }
  if (ind.state === 'pending') {
    void toast('该行业授权申请审批中，可在控制台「审批中心」跟进')
    return
  }
  showActivate(ind)
}

function showActivate(ind) {
  showModal(`🔐 行业功能包授权激活 · ${ind.name}（${ind.code}）`, `
    <p class="note" style="margin-top:0">该行业场景图谱包尚未对本组织授权。行业切换与功能面板使用需经<b>宿主平台授权激活</b>——申请进入审批中心（高风险单需二次确认），激活后按 usage 计量、audit 全程留痕。</p>
    <div style="margin:14px 0">
      <div class="lic-row"><span class="lr-ic">🗺</span><span>${esc(ind.name)}场景图谱包（一图四清单）<span style="display:block;font-size:10px;color:var(--txt2)">${esc(ind.sub)}</span></span><span class="lr-st">待授权</span></div>
      <div class="lic-row"><span class="lr-ic">🧩</span><span>部门面板行业化配置（五部门 × 场景挂载）</span><span class="lr-st">随审批生效</span></div>
      <div class="lic-row"><span class="lr-ic">🤖</span><span>行业 Agent 阵容与数据面连接器映射</span><span class="lr-st">随审批生效</span></div>
    </div>
    <div class="flow"><span class="fn">① 提交申请</span><span class="fa">→</span><span class="fn">② 平台管理员审批</span><span class="fa">→</span><span class="fn">③ 激活 + 能力授权</span><span class="fa">→</span><span class="fn">④ 面板解锁</span></div>
    <div style="display:flex;gap:10px">
      <button class="btn primary" id="actSubmit">提交激活申请</button>
      <button class="btn" id="actCancel">取消</button>
    </div>
    <p class="note">计量说明：激活后部门面板按 resource='panel:&lt;dept&gt;.${esc(ind.code.toLowerCase())}' 计量（零费率起步，费率由平台运营配置）。</p>`)
  document.getElementById('actCancel').onclick = hideModal
  document.getElementById('actSubmit').onclick = async (event) => {
    event.target.disabled = true
    try {
      await api.post(`/api/panel/industries/${ind.code}/activate-requests`)
      ind.state = 'pending'
      hideModal()
      renderIndMenu()
      void toast('激活申请已提交，请等待平台管理员审批')
    } catch (error) {
      event.target.disabled = false
      void toast(error.message, 'error')
    }
  }
}

function renderTopRight() {
  const host = document.getElementById('topRight')
  if (!host) return
  const bound = state.ddStatus?.bound
  const pill = state.ddStatus
    ? (bound
        ? `<span class="pill dd-on" id="ddPill">⇄ 钉钉：${esc(bound.displayName)} 已绑定</span>`
        : `<span class="pill dd-off" id="ddPill">⇄ 钉钉桥接：未绑定（点击绑定）</span>`)
    : `<span class="pill" id="ddPill">⇄ 钉钉桥接不可用</span>`
  const user = session.user ?? (state.demoMode ? { displayName: '演示访客' } : null)
  const avatarTitle = state.demoMode ? '演示访客（只读）——点击连接宿主'
    : `${esc(user?.displayName ?? '')}（点击退出登录）`
  host.innerHTML = `${pill}
    <span class="pill" data-live id="livePill"><span class="dot"></span>LIVE</span>
    <div class="avatar" id="userAvatar" title="${avatarTitle}">${esc((user?.displayName ?? '?').slice(0, 1))}</div>`
  document.getElementById('ddPill').onclick = () => showBind()
  // 退出登录入口（QA P2-3）：车间共用电脑下一班不能沿用上一班身份
  document.getElementById('userAvatar').onclick = async () => {
    if (state.demoMode) {
      const wizard = await import('./wizard.js')
      wizard.start({ base: basePath() })
      return
    }
    if (!window.confirm(`退出当前账号（${user?.displayName ?? ''}）？`)) return
    session.clear()
    renderLoginGuide()
    void toast('已退出登录')
  }
}

/** 实时徽标三态（QA BUG-U-02 / 交接 H2 根治）：LIVE（SSE）/ 30s 轮询 / 连接中断·点击重试。
 *  缺省按 state.stream.health() 投影当前传输态（轮询有失败在身即示警，自愈即恢复）；
 *  kind='down' 为轮询连续失败直呼（onPollError 阈值）；95s 无数据看门狗置 streamStale 同样示警。 */
function renderLiveBadge(kind) {
  const pill = document.getElementById('livePill')
  if (!pill) return
  const down = (title) => {
    pill.innerHTML = '<span class="dot" style="background:#ef4444"></span>连接中断 · 点击重试'
    pill.title = title
    pill.onclick = () => { reconnectStream(); void toast('正在重建实时通道…') }
  }
  if (kind === 'down') return down('实时轮询连续失败。点击重建实时通道。')
  if (state.streamStale) return down('超过 90 秒没有收到任何数据（可能断网或服务重启）。点击重建实时通道。')
  pill.onclick = null
  const health = state.stream?.health?.()
  if (!health || health.transport === 'sse') {
    pill.innerHTML = '<span class="dot"></span>LIVE'
    pill.title = '实时通道（SSE）已连接'
  } else if (health.consecutivePollFailures > 0) {
    down('实时轮询连续失败。点击重建实时通道。')
  } else {
    pill.innerHTML = '<span class="dot" style="background:#f59e0b"></span>30s 轮询'
    pill.title = '实时通道不可用（如钉钉 webview），已按 30 秒轮询兜底'
  }
}

function renderRail() {
  const rail = document.getElementById('rail')
  rail.innerHTML = state.depts.map((dept) => {
    const locked = dept.allowed === false
    return `<div class="rail-item ${dept.id === state.dept ? 'active' : ''}" data-dept="${esc(dept.id)}"
      ${locked ? 'style="opacity:.45" title="部门范围受限（已绑定其他组织治理）"' : ''}>
      <div class="ico">${locked ? '🔒' : esc(dept.icon)}</div><div class="nm">${esc(dept.label)}</div>
    </div>`
  }).join('') + `
    <div class="rail-spacer"></div>
    ${state.hostBridge && !EMBEDDED ? `<div class="rail-console" id="railChat" title="切到 AI 助手对话（默认对话入口）" style="cursor:pointer">
      <div class="ico">💬</div><div>AI 助手<br>对话</div></div>` : ''}
    <a class="rail-console" href="${basePath() || '/'}" title="打开01门管理控制台" style="text-decoration:none"
      data-landing="console">
      <div class="ico">🧩</div><div>管理<br>控制台</div></a>`
  rail.querySelectorAll('.rail-item').forEach((el) => {
    el.onclick = () => {
      const dept = state.depts.find((item) => item.id === el.dataset.dept)
      if (dept?.allowed === false) { void toast('部门范围受限：该部门已绑定其他组织治理', 'error'); return }
      void switchDept(el.dataset.dept)
    }
  })
  // 「Agent 对话」＝切到内嵌 dsh 标准对话的会话 Tab（不再整页跳出；嵌入态无此入口）
  const railChat = rail.querySelector('#railChat')
  if (railChat) {
    railChat.onclick = async () => {
      state.tab = 'chat'
      localStorage.setItem('panel_tab', 'chat')
      await loadTab()
      renderMain()
    }
  }
  // 显式跨工作台切换：记住去向（控制台启动分诊尊重该偏好，不再把人拽回面板）
  rail.querySelectorAll('[data-landing]').forEach((el) => {
    el.addEventListener('click', () => {
      try { localStorage.setItem('gate01_landing', el.dataset.landing) } catch { /* 忽略 */ }
    })
  })
}

function basePath() {
  const index = location.pathname.indexOf('/panel')
  return index > 0 ? location.pathname.slice(0, index) : ''
}

// ---------------------------------------------------------------------------
// 部门渲染
// ---------------------------------------------------------------------------

async function switchDept(deptId, { keepTab } = {}) {
  state.dept = deptId
  localStorage.setItem('panel_dept', deptId)
  state.channelId = ''
  state.channelId = localStorage.getItem(`panel_channel_${deptId}`) ?? ''
  if (!keepTab) state.tab = 'chat'
  document.documentElement.dataset.dept = deptId
  connectStream()
  state.overview = await api.get(`/api/panel/${deptId}/overview`)
  const channels = state.overview.channels
  if (!channels.some((channel) => channel.id === state.channelId)) {
    state.channelId = channels[0]?.id ?? ''
    if (state.channelId) localStorage.setItem(`panel_channel_${deptId}`, state.channelId)
  }
  renderDept()
  await loadTab()
  renderMain()
}

function renderDept() {
  const dept = state.overview.dept
  const industry = state.overview.industry
  const host = document.getElementById('dept')
  host.innerHTML = `
    <div class="dept-head">
      <div class="dept-title">${esc(dept.icon)} ${esc(dept.label)}工作台
        <span class="tag">${esc(dept.theme)}</span>
        <span class="tag gray">协作模式：${esc(dept.collab)}</span>
        ${state.overview.org ? `<span class="tag gray">🏷 ${esc(state.overview.org.name)}</span>` : ''}
        ${industry ? `<span class="tag gray">${esc(industry.name)} · 场景图谱已挂载</span>` : '<span class="tag gray">未激活行业（顶栏切换）</span>'}
      </div>
      <div class="dept-kpis">${state.overview.kpis.map((kpi) => `
        <div class="kpi" title="来源：${esc(kpi.source)}"><div class="v">${esc(kpi.value)}</div><div class="k">${esc(kpi.label)}</div></div>`).join('')}
      </div>
      <div class="head-actions">
        <button class="btn only-compact toggle-left" id="btnLeftDrawer" title="名册/频道（窄窗抽屉）">👥</button>
        <button class="btn only-compact toggle-right" id="btnRightDrawer" title="部门看板（窄窗抽屉）">📊</button>
        <button class="btn" id="btnModels" title="模型配置（与 dsh 服务共用模型目录）">🧠 模型</button>
        ${session.can('panel.config.write') ? '<button class="btn" id="btnConfig">⚙ 面板配置</button>' : ''}
        <button class="btn primary" id="btnNewChannel">＋ 发起协作</button>
      </div>
    </div>
    <div class="cols">
      <div class="col-left" id="colLeft"></div>
      <div class="col-main" id="colMain"></div>
      <div class="col-right" id="colRight"></div>
    </div>`
  const btnConfig = document.getElementById('btnConfig')
  // 只读用户隐藏配置入口（QA P2-4）：有点击后提示不如按权限直接隐藏
  if (btnConfig) btnConfig.onclick = () => showConfig()
  document.getElementById('btnModels').onclick = () => void showModels()
  document.getElementById('btnNewChannel').onclick = () => showNewChannel()
  const toggle = (cls) => document.body.classList.toggle(cls)
  document.getElementById('btnLeftDrawer').onclick = () => toggle('left-open')
  document.getElementById('btnRightDrawer').onclick = () => toggle('right-open')
  renderColLeft()
  renderColRight()
}

function renderColLeft() {
  const host = document.getElementById('colLeft')
  if (!host) return
  const dept = state.overview.dept
  const bridgeIds = new Set(state.bridges.filter((b) => b.purpose === 'channel').map((b) => b.channelId))
  host.innerHTML = `
    <button class="drawer-close" id="leftClose">✕ 收起名册</button>
    <div class="col-title"><span>部门 AGENT</span><span title="阵容在面板配置中绑定 Agent 资产">＋</span></div>
    ${dept.agents.map((agent) => {
      const statusColor = agent.asset ? (agent.asset.status === 'online' ? '#22c55e' : '#94a3b8') : ''
      const statusTitle = agent.asset
        ? `Agent 资产：${agent.asset.name}（${agent.asset.status === 'online' ? '在线' : agent.asset.status}${agent.asset.model ? ` · ${agent.asset.model}` : ''}）`
        : '未绑定 Agent 资产（面板配置中绑定后可真实调用）'
      return `
      <div class="agent-card" data-agent="${esc(agent.name)}" title="${esc(statusTitle)}">
        <div class="agent-av">${esc(agent.icon)}<span class="st2 ${agent.busy ? 'busy' : ''}" ${statusColor ? `style="background:${statusColor}"` : ''}></span></div>
        <div class="agent-info"><div class="n">${esc(agent.name)}</div><div class="d">${esc(agent.desc)}</div></div>
      </div>`
    }).join('') || '<div class="sys-line"><span>本部门暂无 Agent 阵容（面板配置中添加）</span></div>'}
    <div class="col-title" style="margin-top:14px"><span>协作频道</span><span id="addChannel">＋建群</span></div>
    ${state.overview.channels.map((channel) => `
      <div class="chan ${channel.id === state.channelId ? 'on' : ''}" data-channel="${esc(channel.id)}">
        <span class="h">#</span>${esc(channel.name)}
        ${bridgeIds.has(channel.id) ? '<span class="ddic">⇄钉钉</span>' : ''}
        ${channel.unread > 0 ? `<span class="cnt">${channel.unread > 99 ? '99+' : channel.unread}</span>` : ''}
      </div>`).join('')}`
  host.querySelectorAll('.agent-card').forEach((el) => {
    el.onclick = () => atMention(el.dataset.agent)
  })
  host.querySelectorAll('.chan').forEach((el) => {
    el.onclick = () => void switchChannel(el.dataset.channel)
  })
  const add = host.querySelector('#addChannel')
  if (add) add.onclick = () => showNewChannel()
  const leftClose = host.querySelector('#leftClose')
  if (leftClose) leftClose.onclick = () => document.body.classList.remove('left-open')
}

async function switchChannel(channelId) {
  state.channelId = channelId
  localStorage.setItem(`panel_channel_${state.dept}`, channelId)
  // 窄窗抽屉态下选中频道即收起（移动端姿态）
  document.body.classList.remove('left-open')
  renderColLeft()
  await loadTab()
  renderMain()
}

function renderColRight() {
  const host = document.getElementById('colRight')
  if (!host) return
  host.innerHTML = `<button class="drawer-close" id="rightClose">✕ 收起看板</button>${state.overview.widgets.map(renderWidget).join('')}`
  const rightClose = host.querySelector('#rightClose')
  if (rightClose) rightClose.onclick = () => document.body.classList.remove('right-open')
}

function renderWidget(widget) {
  const srcCls = widget.source.startsWith('连接器') ? 'connector' : widget.source.startsWith('手工') ? 'manual' : ''
  const head = `<div class="wt">${esc(widget.title)} ${widget.live ? '<span class="live">● LIVE</span>' : ''}<span class="src-badge ${srcCls}" title="数据来源徽标（治理 DoD）">${esc(widget.source)}</span></div>`
  if (widget.degraded) {
    return `<div class="widget">${head}<div class="degraded-note">该数据源暂不可用——等待业务连接器接入。<br>面板绝不以演示数据冒充真实业务面。</div></div>`
  }
  let inner = ''
  if (widget.type === 'bars') {
    inner = widget.rows.map((row) => `
      <div class="bar-row"><div class="lb"><span>${esc(row[0])}</span><span>${esc(row[1])}%</span></div>
      <div class="bar"><i class="${esc(row[2] ?? '')}" style="width:${Number(row[1]) || 0}%"></i></div></div>`).join('')
  } else if (widget.type === 'funnel') {
    inner = widget.rows.map((row) => `
      <div class="funnel-row"><span style="width:56px">${esc(row[0])}</span>
      <div class="fb" style="width:${Math.max(Number(row[1]) || 0, 16)}%;opacity:${(0.4 + 0.6 * (Number(row[1]) || 0) / 100).toFixed(2)}">${esc(row[2])}</div></div>`).join('')
  } else if (widget.type === 'alerts') {
    inner = widget.rows.map((row) => `
      <div class="alert-item ${row[0] === 'y' ? 'warn' : ''}"><span class="ab ${esc(row[0])}">${esc(row[1])}</span><span>${esc(row[2])}</span></div>`).join('')
  } else if (widget.type === 'todos') {
    inner = widget.rows.map((row) => `
      <div class="todo-item"><span>${esc(row[0])}</span>${row[1] ? `<span class="amt">${esc(row[1])}</span>` : ''}${row[2] ? `<span class="mini-btn">${esc(row[2])}</span>` : ''}</div>`).join('')
  } else if (widget.type === 'feeds') {
    inner = widget.rows.map((row) => `
      <div class="feed-item">${row[0] ? `<span class="hot">${esc(row[0])}</span>` : ''}${esc(row[1])}<div class="ft">${esc(row[2])}</div></div>`).join('')
  }
  return `<div class="widget">${head}${inner}</div>`
}

// ---------------------------------------------------------------------------
// 主区（四 Tab）
// ---------------------------------------------------------------------------

function renderMain() {
  const host = document.getElementById('colMain')
  if (!host) return
  const industry = state.overview.industry
  const embedChat = state.tab === 'chat' && canEmbedDshChat()
  host.innerHTML = `
    <div class="tabs">
      <div class="tab ${state.tab === 'chat' ? 'on' : ''}" data-tab="chat">💬 ${embedChat ? 'AI 助手' : '协作会话'}<span class="mini">${embedChat ? '默认对话 · 可 /技能名 直调' : '人 × 数字同事 × 钉钉'}</span></div>
      <div class="tab ${state.tab === 'tasks' ? 'on' : ''}" data-tab="tasks">📌 任务看板</div>
      <div class="tab ${state.tab === 'arts' ? 'on' : ''}" data-tab="arts">📁 部门知识</div>
      <div class="tab ${state.tab === 'scene' ? 'on' : ''}" data-tab="scene">🗺 场景图谱<span class="mini">${esc(industry?.code ?? '未激活')}</span></div>
    </div>
    <div id="tabBody"></div>
    ${state.tab === 'chat' && !embedChat ? composerHtml() : ''}`
  host.querySelectorAll('.tab').forEach((el) => {
    el.onclick = async () => {
      state.tab = el.dataset.tab
      localStorage.setItem('panel_tab', state.tab)
      await loadTab()
      renderMain()
    }
  })
  const body = host.querySelector('#tabBody')
  if (state.tab === 'chat') {
    if (embedChat) renderChatEmbed(body)
    else { renderMessages(body); wireComposer(host) }
  }
  else if (state.tab === 'tasks') renderKanban(body)
  else if (state.tab === 'arts') renderArtifacts(body)
  else if (state.tab === 'scene') renderScenegraph(body)
}

/**
 * 「Agent 对话」内嵌 dsh 标准对话（M3 双向打通的 panel 侧）：同源 iframe 挂 dsh 根 `/`。
 * 上下文携带（MVP）：dsh 深链预填能力未经核实（spike 未覆盖），以剪贴板 + 聚焦兜底——
 * 按钮把部门/行业上下文复制给用户，粘进对话；dsh 若支持预填深链再升级（诚实降级）。
 */
function renderChatEmbed(host) {
  const dept = state.overview.dept
  const industry = state.overview.industry
  const skills = state.skills.slice(0, 4)
  host.innerHTML = `
    <div class="chat-embed">
      <div class="ce-bar">
        <span class="ce-title">🤖 AI 助手对话<span class="ce-sub">默认对话入口 · 部门数字同事可 @ 点名协作</span></span>
        <span class="ce-acts">
          ${skills.length > 0 ? `<select class="ce-act" id="ceSkillPick" title="选一个已上架技能，转到协作会话直调（执行卡展示进度与结果）">
            <option value="">⚡ 选技能直调…</option>
            ${skills.map((skill) => `<option value="${esc(skill.name)}">${esc(skill.name)}</option>`).join('')}
          </select>` : ''}
          <button class="ce-act" id="ceHandoff" title="把当前部门/行业上下文复制到剪贴板，粘进对话即可继续">📋 携带部门上下文</button>
          <button class="ce-act" id="ceFallback">使用内置协作会话</button>
          <a class="ce-act" href="/" target="_blank" rel="noreferrer">在 dsh 中打开 ↗</a>
        </span>
      </div>
      <iframe class="ce-frame" src="/" title="AI 助手对话" referrerpolicy="same-origin"></iframe>
    </div>`
  document.getElementById('ceHandoff').onclick = async () => {
    const context = `【01门·${dept.label}】行业 ${industry?.code ?? '未激活'} · 请围绕该部门场景协作（面板：${location.origin}${basePath()}/panel/?dept=${state.dept}）`
    try {
      await navigator.clipboard.writeText(context)
      void toast('上下文已复制——粘贴到对话即可让 Agent 进入该部门语境')
    } catch {
      void toast(context, 'info')
    }
  }
  document.getElementById('ceFallback').onclick = () => {
    localStorage.setItem('panel_chat_embed_off', '1')
    renderMain()
  }
  // 技能直调入口（C1-2）：内嵌形态选技能 → 转内置协作会话并预填 /技能名（执行卡在那里渲染）
  const skillPick = document.getElementById('ceSkillPick')
  if (skillPick) {
    skillPick.onchange = () => {
      const name = skillPick.value
      if (!name) return
      localStorage.setItem('panel_chat_embed_off', '1')
      renderMain()
      insertSkill(name)
    }
  }
}

async function loadTab() {
  try {
    if (state.tab === 'chat') {
      if (!state.channelId) { state.messages = []; return }
      const detail = await api.get(`/api/panel/${state.dept}/messages?channelId=${state.channelId}&limit=80`)
      state.messages = detail.messages
      await api.post(`/api/panel/channels/${state.channelId}/read`)
    } else if (state.tab === 'tasks') {
      state.tasks = (await api.get(`/api/panel/${state.dept}/tasks`)).tasks
    } else if (state.tab === 'arts') {
      state.artifacts = (await api.get(`/api/panel/${state.dept}/artifacts`)).artifacts
    } else if (state.tab === 'scene') {
      state.scenegraph = null
      if (state.overview.industry) {
        state.scenegraph = await api.get(`/api/panel/scenegraph?industry=${state.overview.industry.code.toUpperCase()}`)
      }
    }
  } catch (error) {
    void toast(error.message, 'error')
  }
}

// -- 会话 ------------------------------------------------------------------

function renderMessages(host) {
  const target = host ?? document.querySelector('#tabBody')
  if (!target) return
  if (!state.channelId) {
    target.innerHTML = '<div class="msgs"><div class="empty-line">本部门还没有协作频道，点右上「＋ 发起协作」创建。</div></div>'
    return
  }
  const ddBound = Boolean(state.ddStatus?.bound)
  target.innerHTML = `<div class="msgs">${state.messages.map((m) => messageHtml(m, ddBound)).join('')}</div>`
  const wrap = target.querySelector('.msgs')
  wrap.scrollTop = wrap.scrollHeight
  wrap.querySelectorAll('[data-op]').forEach((el) => {
    el.onclick = () => void doCardAction(el.dataset.msg, el.dataset.op, el)
  })
  // 技能执行卡「重试」（C1-2）：原样回填斜杠命令再走一次直调
  wrap.querySelectorAll('[data-retry]').forEach((el) => {
    el.onclick = async () => {
      const input = document.querySelector('#composerInput')
      if (!input) { void toast('请切到协作会话后重试'); return }
      input.value = el.dataset.retry
      await sendMessage(input)
    }
  })
}

function messageHtml(m, ddBound) {
  // 技能执行卡（C1-2 本地瞬时态）：调用中转圈 / 异常阻断红卡（原因 + 重试）。
  // 已完成态不落卡——应答消息本身（⚡ 技能名）就是结果，卡片即时移除避免双份展示。
  if (m.kind === 'skill-exec') {
    if (m.state === 'blocked') {
      return `<div class="msg"><div class="m-av" style="background:#ef4444">⚡</div>
        <div class="m-body"><div class="m-meta">${esc(m.skillName)} <span class="role" style="color:var(--err)">执行失败</span></div>
        <div class="m-txt"><div class="skill-exec blocked"><b>调用没有成功：</b>${esc(m.reason ?? '未知原因（可下拉查看技术详情）')}
          ${m.raw ? `<div class="se-ops"><button class="btn" data-retry="${esc(m.raw)}">↻ 重试</button></div>` : ''}</div></div></div></div>`
    }
    return `<div class="msg"><div class="m-av" style="background:#6366f1">⚡</div>
      <div class="m-body"><div class="m-meta">${esc(m.skillName)} <span class="role">技能执行中</span></div>
      <div class="m-txt"><div class="skill-exec calling"><span class="se-spin"></span> 正在执行「${esc(m.skillName)}」${esc(m.text ? `：${m.text.slice(0, 40)}` : '')}…</div></div></div></div>`
  }
  if (m.senderType === 'system') return `<div class="sys-line"><span>⚡ ${md(m.text)}</span></div>`
  const ddBadge = m.ddSync === 'sent'
    ? '<div class="dd-sync">⇄ 已同步钉钉</div>'
    : m.ddSync === 'pending' ? '<div class="dd-sync">⇄ 钉钉投递中…</div>'
      : m.ddSync === 'failed' ? '<div class="dd-sync" style="color:var(--err)">⇄ 钉钉投递失败</div>'
        : ''
  const card = m.card
    ? `<div class="action-card"><div class="t">${esc(m.card.title)}</div>
        <div class="ops">${m.card.ops.map((op) => `
          <button data-op="${esc(op.id)}" data-msg="${esc(m.id)}"
            class="btn ${m.card.done.includes(op.id) ? 'done' : op.style === 'dd' ? 'dd' : 'primary'}"
            ${m.card.done.includes(op.id) ? 'disabled' : ''}>${esc(op.label)}${m.card.done.includes(op.id) ? ' ✓' : ''}</button>`).join('')}
        </div></div>`
    : ''
  if (m.senderType === 'human' && m.senderId && m.senderId === session.user?.id) {
    return `<div class="msg me"><div class="m-av human" style="background:#f59e0b">我</div>
      <div class="m-body"><div class="m-meta" style="justify-content:flex-end">${esc(m.senderName)}</div>
      <div class="m-txt">${md(m.text)}${ddBadge}</div></div></div>`
  }
  if (m.senderType === 'agent') {
    return `<div class="msg"><div class="m-av agent">${esc(m.senderIcon ?? '🤖')}</div>
      <div class="m-body"><div class="m-meta">${esc(m.senderName)} <span class="role">Agent</span>${m.model ? `<span class="role model" title="本次回包使用的模型（可在输入区切换）">🧠 ${esc(m.model)}</span>` : ''}</div>
      <div class="m-txt">${md(m.text)}${card}${ddBadge}</div></div></div>`
  }
  const fromDd = m.ddSync === 'origin'
  return `<div class="msg"><div class="m-av ${fromDd ? 'fromdd' : 'human'}">${esc((m.senderName ?? '?').slice(0, 1))}</div>
    <div class="m-body"><div class="m-meta">${esc(m.senderName)}${fromDd ? '<span class="dd-tag">● 来自钉钉</span>' : ''}</div>
    <div class="m-txt">${md(m.text)}${card}${ddBadge}</div></div></div>`
}

async function doCardAction(messageId, opId, btn) {
  btn.disabled = true
  try {
    const result = await api.post(`/api/panel/messages/${messageId}/card-action`, { opId })
    const message = state.messages.find((m) => m.id === messageId)
    if (message?.card) message.card = result.message.card
    renderMessages()
    void toast(result.result)
    if (state.tab === 'tasks') void loadTab()
  } catch (error) {
    btn.disabled = false
    void toast(error.message, 'error')
  }
}

// -- 输入区 ------------------------------------------------------------------

/** 输入草稿（QA BUG-U-07）：按 部门:频道 落 localStorage——任何 Tab 切换/频道切换/
 *  整页刷新都不许弄丢正在输入的交接班记录。 */
function draftKey() {
  return `panel_draft:${state.dept}:${state.channelId}`
}

function saveDraft(input) {
  try { localStorage.setItem(draftKey(), input.value) } catch { /* 存储满/隐私模式忽略 */ }
}

function clearDraft() {
  try { localStorage.removeItem(draftKey()) } catch { /* 忽略 */ }
}

function composerHtml() {
  const dept = state.overview.dept
  const bound = Boolean(state.ddStatus?.bound)
  const members = (state.overview.members ?? []).slice(0, 6)
  // 对话框模型切换：在线模型下拉（默认跟随 Agent 资产配置）；目录为空/全离线时给诚实提示
  const onlineModels = state.models.filter((model) => model.status === 'online')
  const modelSwitch = onlineModels.length > 0
    ? `<select id="chatModel" class="model-sel" title="本次会话使用的模型（默认跟随 Agent 资产配置；目录与 dsh 服务共用）">
        <option value="">🧠 跟随 Agent</option>
        ${onlineModels.map((model) => `<option value="${esc(model.slug)}" ${state.chatModel === model.slug ? 'selected' : ''}>${esc(model.displayName || model.slug)}</option>`).join('')}
      </select>`
    : '<span class="model-empty" id="modelEmptyHint" title="模型目录暂无在线模型——点此登记接入（与 dsh 服务共用模型目录）">🧠 未接入模型</span>'
  const skills = state.skills.slice(0, 6)
  return `
    <div class="composer">
      <div class="at-row">
        <span style="font-size:11px;color:var(--txt2)">@ 唤起：</span>
        ${dept.agents.map((agent) => `<span class="at-chip ag" data-at="${esc(agent.name)}">🤖 ${esc(agent.name)}</span>`).join('')}
        ${members.map((member) => `<span class="at-chip" data-at="${esc(member.name)}" title="${esc(member.title ?? '')}${member.orgName ? ` · ${esc(member.orgName)}` : ''}">🧑 ${esc(member.name)}</span>`).join('')}
        ${bound ? '<span class="at-chip ddu" data-at="钉群·全员">⇄ 钉群·全员</span>'
          : '<span class="at-chip" id="bindHint">🔗 绑定钉钉后可 @ 钉钉同事</span>'}
        ${state.hostBridge && !EMBEDDED ? '<span class="at-chip" id="reembedHint" title="切回 AI 助手对话（默认对话入口）">🤖 改用 AI 助手</span>' : ''}
        <span class="dd-toggle" id="ddToggle"><span class="sw ${state.ddSync && bound ? 'on' : ''} ${bound ? '' : 'disabled'}" id="ddSw"></span>钉钉同步</span>
      </div>
      ${skills.length > 0 ? `
      <div class="at-row skill-row">
        <span style="font-size:11px;color:var(--txt2)">⚡ 技能：</span>
        ${skills.map((skill) => `<span class="at-chip sk" data-skill="${esc(skill.name)}" title="${esc(skill.summary)}（已上架 v${esc(skill.version)}）">⚡ ${esc(skill.name)}</span>`).join('')}
        <span style="font-size:11px;color:var(--txt2)">输入 /技能名 也可直调</span>
      </div>` : ''}
      <div class="input-row">
        ${modelSwitch}
        <input id="composerInput" placeholder="发消息 / @数字同事 下任务 / /技能名 直调${bound && state.ddSync ? ' / 本条将同步钉钉群' : ''}…（Enter 发送）">
        <button class="send" id="composerSend">发送</button>
      </div>
    </div>`
}

function wireComposer(host) {
  const input = host.querySelector('#composerInput')
  if (!input) return
  // 草稿恢复 + 随输入保存（QA BUG-U-07）
  try { input.value = localStorage.getItem(draftKey()) ?? '' } catch { /* 忽略 */ }
  input.oninput = () => saveDraft(input)
  host.querySelectorAll('[data-at]').forEach((el) => {
    el.onclick = () => atMention(el.dataset.at, input)
  })
  // 技能 chips（C1-2）：点击把 /技能名 填进输入框——发送时按斜杠命令直调
  host.querySelectorAll('[data-skill]').forEach((el) => {
    el.onclick = () => insertSkill(el.dataset.skill, input)
  })
  const bindHint = host.querySelector('#bindHint')
  if (bindHint) bindHint.onclick = () => showBind()
  const toggle = host.querySelector('#ddToggle')
  if (toggle) {
    toggle.onclick = () => {
      if (!state.ddStatus?.bound) { showBind(); return }
      state.ddSync = !state.ddSync
      localStorage.setItem('panel_ddsync', state.ddSync ? '1' : '0')
      renderMain()
    }
  }
  const send = () => void sendMessage(input)
  host.querySelector('#composerSend').onclick = send
  input.onkeydown = (event) => { if (event.key === 'Enter') send() }
  // 模型切换：目录变化后本地记忆可能失效——以 DOM 实际选中值归一（失配时自动回到「跟随 Agent」）
  const modelSel = host.querySelector('#chatModel')
  if (modelSel) {
    state.chatModel = modelSel.value
    modelSel.onchange = () => {
      state.chatModel = modelSel.value
      try { localStorage.setItem('panel_chat_model', state.chatModel) } catch { /* 忽略 */ }
    }
  }
  const modelHint = host.querySelector('#modelEmptyHint')
  if (modelHint) modelHint.onclick = () => void showModels()
  // 退回内置会话后的「改用 dsh 对话」：清掉关闭标记并重渲染（内嵌为默认交互面）
  const reembedHint = host.querySelector('#reembedHint')
  if (reembedHint) {
    reembedHint.onclick = () => {
      localStorage.removeItem('panel_chat_embed_off')
      renderMain()
    }
  }
}

function atMention(name, inputEl) {
  const input = inputEl ?? document.querySelector('#composerInput')
  if (!input) { void toast('请先切到「协作会话」再 @ 唤起'); return }
  input.value = `@${name} ${input.value}`
  saveDraft(input)
  input.focus()
}

/** 技能名填入输入框（C1-2：/技能名 斜杠形态，发送时直调）。 */
function insertSkill(name, inputEl) {
  const input = inputEl ?? document.querySelector('#composerInput')
  if (!input) { void toast('请先切到「协作会话」再直调技能'); return }
  input.value = `/${name} ${input.value}`
  saveDraft(input)
  input.focus()
}

/** 斜杠命令解析：/技能名 输入 → 匹配已上架技能（名全名优先，slug 兜底）；不匹配返回 null 走普通消息。 */
function parseSkillCommand(text) {
  const m = /^\/(.+?)(?:\s+([\s\S]*))?$/.exec(text)
  if (!m) return null
  const name = m[1].trim()
  const skill = state.skills.find((item) => item.name === name || item.slug === name)
  if (!skill) return null
  return { skill, message: (m[2] ?? '').trim() }
}

/**
 * 技能直调 + 面板侧执行卡（C1-2 四态）：调用中（本地瞬时卡）→ 已完成（应答以数字同事消息落频道）
 * / 异常阻断（红卡原因 + 重试；服务端同时落失败系统行，全频道可见可回查）。
 * 卡片是进度示意；结果（成功应答/失败原因）都已服务端持久化，刷新不丢。
 */
async function runSkillInvoke(skill, message, rawText) {
  const exec = {
    id: `local-skill-${Date.now()}`, kind: 'skill-exec', state: 'calling',
    skillName: skill.name, text: message, raw: rawText, at: new Date().toISOString(),
  }
  state.messages.push(exec)
  renderMessages()
  try {
    const result = await api.post(`/api/panel/${state.dept}/skills/invoke`, {
      skill: skill.name, message, channelId: state.channelId,
      ...(state.chatModel ? { model: state.chatModel } : {}),
    })
    state.messages = state.messages.filter((m) => m.id !== exec.id)
    for (const m of [result.message, result.replyMessage]) {
      if (m && !state.messages.some((x) => x.id === m.id)) state.messages.push(m)
    }
    if (!result.ok) state.messages.push({ ...exec, state: 'blocked', reason: result.reason })
    renderMessages()
    void refreshOverview()
  } catch (error) {
    state.messages = state.messages.filter((m) => m.id !== exec.id)
    state.messages.push({ ...exec, state: 'blocked', reason: error.message })
    renderMessages()
  }
}

async function sendMessage(input) {
  const text = input.value.trim()
  if (!text || !state.channelId) return
  const skillCmd = parseSkillCommand(text)
  if (skillCmd) {
    input.value = ''
    clearDraft()
    await runSkillInvoke(skillCmd.skill, skillCmd.message, text)
    return
  }
  input.value = ''
  try {
    const result = await api.post(`/api/panel/${state.dept}/messages`, {
      channelId: state.channelId, text, ddSync: state.ddSync && Boolean(state.ddStatus?.bound),
      // 对话框选中的模型（'' = 跟随 Agent 资产配置，不传 model）
      ...(state.chatModel ? { model: state.chatModel } : {}),
    })
    clearDraft()
    state.messages.push(result.message)
    renderMessages()
    void refreshOverview()
  } catch (error) {
    input.value = text
    saveDraft(input)
    void toast(error.message, 'error')
  }
}

async function refreshOverview() {
  try {
    state.overview = await api.get(`/api/panel/${state.dept}/overview`)
    renderColLeft()
  } catch { /* 静默 */ }
}

// -- 任务看板 ------------------------------------------------------------------

function renderKanban(host) {
  const laneOf = (lane) => state.tasks.filter((task) => task.lane === lane)
  host.innerHTML = `<div class="kanban">${LANE_ORDER.map((lane) => `
    <div class="lane">
      <div class="lane-h"><span>${LANE_LABELS[lane]}</span><span>${laneOf(lane).length}</span></div>
      ${laneOf(lane).map((task) => `
        <div class="task-card">
          <div class="tt">${esc(task.title)}</div>
          <div class="tm">
            <span class="who">${task.assigneeType === 'agent' ? '🤖' : '🧑'} ${esc(task.assigneeName ?? '')}</span>
            ${task.sceneCode ? `<span class="scene" data-scene="${esc(task.sceneCode)}">${esc(task.sceneCode)}</span>` : ''}
            <span class="mv">
              ${lane !== 'todo' ? `<button data-move="${esc(task.id)}" data-to="todo" title="移到待办">⇤</button>` : ''}
              ${lane !== 'done' ? `<button data-move="${esc(task.id)}" data-to="${nextLane(lane)}" title="推进">→</button>` : ''}
            </span>
          </div>
        </div>`).join('')}
      <button class="lane-add" data-addlane="${lane}">＋ 新建任务</button>
    </div>`).join('')}</div>`
  host.querySelectorAll('[data-move]').forEach((el) => {
    el.onclick = async () => {
      try {
        await api.post(`/api/panel/tasks/${el.dataset.move}/transition`, { lane: el.dataset.to })
        await loadTab()
        renderMain()
      } catch (error) { void toast(error.message, 'error') }
    }
  })
  host.querySelectorAll('[data-addlane]').forEach((el) => {
    el.onclick = () => showNewTask(el.dataset.addlane)
  })
  host.querySelectorAll('[data-scene]').forEach((el) => {
    el.onclick = () => {
      state.tab = 'scene'
      void loadTab().then(renderMain)
    }
  })
}

function nextLane(lane) {
  return LANE_ORDER[Math.min(LANE_ORDER.indexOf(lane) + 1, LANE_ORDER.length - 1)]
}

function showNewTask(lane) {
  showModal('📌 新建任务', `
    <div style="display:flex;flex-direction:column;gap:10px">
      <input id="taskTitle" placeholder="任务标题" style="border:1px solid var(--line);border-radius:8px;padding:9px 12px;font-size:13px">
      <input id="taskScene" placeholder="关联场景编号（可选，如 QB01-A-2-5）" style="border:1px solid var(--line);border-radius:8px;padding:9px 12px;font-size:13px">
      <div style="display:flex;gap:10px">
        <button class="btn primary" id="taskSubmit">创建到「${LANE_LABELS[lane]}」</button>
        <button class="btn" id="taskCancel">取消</button>
      </div>
    </div>`)
  document.getElementById('taskCancel').onclick = hideModal
  document.getElementById('taskSubmit').onclick = async (event) => {
    const title = document.getElementById('taskTitle').value.trim()
    if (!title) { void toast('标题必填', 'error'); return }
    event.target.disabled = true
    try {
      await api.post(`/api/panel/${state.dept}/tasks`, {
        title, lane,
        ...(document.getElementById('taskScene').value.trim() ? { sceneCode: document.getElementById('taskScene').value.trim() } : {}),
      })
      hideModal()
      await loadTab()
      renderMain()
    } catch (error) {
      event.target.disabled = false
      void toast(error.message, 'error')
    }
  }
}

// -- 部门知识 ------------------------------------------------------------------

function renderArtifacts(host) {
  if (state.artifacts.length === 0) {
    host.innerHTML = '<div class="artifacts"><div class="empty-line">暂无沉淀产出。Agent 产出物（报告/工单/报价/诊断卡）与手工登记都会沉淀在这里。</div></div>'
    return
  }
  host.innerHTML = `<div class="artifacts">${state.artifacts.map((art) => `
    <div class="art-card">
      <div class="ah"><span class="kind">${ART_KINDS[art.kind] ?? art.kind}</span><span class="t">${esc(art.title)}</span>
        <span class="time">${esc(fmtTime(art.createdAt))}${art.agentName ? ` · ${esc(art.agentName)}` : ''}</span></div>
      <div class="c">${esc(art.content)}</div>
      <div class="ao"><button data-quote="${esc(art.id)}">💬 引用到会话</button></div>
    </div>`).join('')}</div>`
  host.querySelectorAll('[data-quote]').forEach((el) => {
    el.onclick = () => {
      const art = state.artifacts.find((item) => item.id === el.dataset.quote)
      if (!art) return
      state.tab = 'chat'
      void loadTab().then(() => {
        renderMain()
        const input = document.querySelector('#composerInput')
        if (input) {
          input.value = `请基于「${art.title}」继续推进：`
          input.focus()
        }
      })
    }
  })
}

// -- 场景图谱 ------------------------------------------------------------------

function renderScenegraph(host) {
  if (!state.overview.industry) {
    host.innerHTML = '<div class="scene-wrap"><div class="empty-line">本组织尚未激活行业场景图谱。请通过顶栏行业选择器提交激活申请。</div></div>'
    return
  }
  if (!state.scenegraph) {
    host.innerHTML = '<div class="scene-wrap"><div class="empty-line">场景图谱包未装载（已激活但数据缺位）——请联系平台管理员检查 scenegraphs 目录。</div></div>'
    return
  }
  const { pack } = state.scenegraph
  const dept = state.overview.dept
  const acts = Object.entries(pack.activities).filter(([key]) => dept.acts.includes(key))
  host.innerHTML = `<div class="scene-wrap">
    <div class="sys-line" style="margin-top:0"><span>🗺 ${esc(pack.name)}场景图谱（${esc(pack.code)} · ${esc(pack.version)} 版）· 一图四清单 · 环节：${esc(pack.chains)}</span></div>
    ${acts.map(([activity, scenes]) => {
      const avg = Math.round(scenes.reduce((sum, scene) => sum + scene.s, 0) / scenes.length)
      return `<div class="scene-act">
        <div class="scene-act-h"><span class="an">${esc(activityLabel(activity))}</span>
          <span class="ar">活动现状评级 ≈ ${stars(avg)}</span>
          <span class="achain">${scenes.length} 个场景 · ${scenes.filter((scene) => scene.s <= 2).length} 个低于★★★ 建议优先改造</span></div>
        <div class="scene-grid">${scenes.map((scene) => sceneCardHtml(scene)).join('')}</div>
      </div>`
    }).join('') || '<div class="empty-line">本部门在当前行业图谱中没有挂载的业务活动。</div>'}
  </div>`
  host.querySelectorAll('[data-diag]').forEach((el) => {
    el.onclick = async () => {
      el.disabled = true
      try {
        await api.post(`/api/panel/${state.dept}/scenes/${el.dataset.diag}/diagnose`)
        state.tab = 'chat'
        state.channelId = state.overview.channels[0]?.id ?? ''
        await loadTab()
        renderMain()
        void toast('诊断任务已派发，请到协作会话跟进')
      } catch (error) {
        el.disabled = false
        void toast(error.message, 'error')
      }
    }
  })
  host.querySelectorAll('[data-syncdd]').forEach((el) => {
    el.onclick = async () => {
      // 前置状态检查（QA BUG-G-03）：未配置/未绑定/无群桥三种情况都必须给明确报错，
      // 不许「零反馈」——工人按了按钮就该知道发生了什么、下一步找谁
      if (!state.ddStatus?.connector?.configured) {
        void toast('钉钉桥接未配置：请联系管理员在控制台「三方集成」配置钉钉连接器', 'error')
        return
      }
      if (!state.ddStatus?.bound) {
        void toast('尚未绑定钉钉账号：请点击顶栏钉钉状态丸完成扫码绑定', 'error')
        showBind()
        return
      }
      const deptBridge = state.bridges.some((b) => b.purpose === 'channel' && (!b.dept || b.dept === state.dept))
      if (!deptBridge) {
        void toast('本部门尚未绑定钉钉群桥：请联系管理员在频道旁「⇄钉钉」绑定群后重试', 'error')
        return
      }
      el.disabled = true
      try {
        await api.post(`/api/panel/${state.dept}/scenes/${el.dataset.syncdd}/sync-dingtalk`)
        void toast('场景卡已请求同步至钉钉协作群')
      } catch (error) {
        void toast(error.message, 'error')
      } finally {
        el.disabled = false
      }
    }
  })
}

function activityLabel(key) {
  const labels = { rd: '研发设计', mfg: '生产制造', scm: '供应链管理', svc: '运维服务', mkt: '数字营销', mgmt: '经营管理', fin: '法财税与成本' }
  return labels[key] ?? key
}

function sceneCardHtml(scene) {
  return `<div class="scene-card">
    <div class="sc-top"><span class="sc-code">${esc(scene.code)}</span><span class="sc-name">${esc(scene.name)}</span>
      <span class="sc-stars">${stars(scene.s)}</span>
      ${scene.tags.map((tag) => `<span class="sc-tag ${TAG_CLS[tag] ?? ''}">${esc(tag)}</span>`).join('')}</div>
    <div class="sc-pain"><b>痛点：</b>${esc(scene.pain)}</div>
    <div class="sc-lists">
      <div class="sc-list"><span class="lk">工具软件</span><span>${scene.tools.map((chip) => `<span class="chip">${esc(chip)}</span>`).join('')}</span></div>
      <div class="sc-list"><span class="lk">知识模型</span><span>${scene.models.map((chip) => `<span class="chip">${esc(chip)}</span>`).join('')}</span></div>
      <div class="sc-list"><span class="lk">数据要素</span><span>${scene.data.map((chip) => `<span class="chip">${esc(chip)}</span>`).join('')}</span></div>
      <div class="sc-list"><span class="lk">人才技能</span><span>${scene.talent.map((chip) => `<span class="chip">${esc(chip)}</span>`).join('')}</span></div>
    </div>
    <div class="sc-ops">
      <button class="btn primary" data-diag="${esc(scene.code)}">🤖 派 Agent 诊断</button>
      <button class="btn dd" data-syncdd="${esc(scene.code)}">📤 同步钉钉群</button>
    </div></div>`
}

// ---------------------------------------------------------------------------
// 绑定向导（D2 裁决：iam 扫码绑定为事实源，无一次性绑定码）
// ---------------------------------------------------------------------------

async function showBind() {
  const status = state.ddStatus
  const connectorOk = status?.connector?.configured
  const bound = status?.bound
  showModal('⇄ 钉钉身份绑定与消息桥接', `
    <div class="step ${connectorOk ? 'done' : ''}"><div class="no">${connectorOk ? '✓' : '1'}</div><div>
      <div class="st-t">宿主平台钉钉连接器</div>
      <div class="st-d">${connectorOk
        ? `已配置（${esc(status.connector.name ?? status.connector.corpId)} · ${status.connector.mode === 'real' ? '真实模式' : 'mock 演示模式——真实投递需切 real'}）`
        : '未配置：请管理员在控制台「组织与账号 → 三方集成」配置钉钉连接器'}</div></div></div>
    <div class="step ${bound ? 'done' : ''}"><div class="no">${bound ? '✓' : '2'}</div><div>
      <div class="st-t">绑定当前登录身份 ↔ 钉钉账号（iam 扫码绑定，事实源 identityLinks）</div>
      <div class="st-d">${bound
        ? `已绑定：${esc(bound.displayName)}（${esc(bound.corpId)}）`
        : '点击下方按钮，在钉钉中完成扫码授权即可。绑定后面板消息可同步钉钉群、场景卡可推送钉钉。'}</div>
      ${bound ? '' : '<div style="margin-top:8px"><button class="btn dd" id="bindStart">📱 去钉钉扫码绑定</button></div>'}</div></div>
    <div class="step"><div class="no">3</div><div>
      <div class="st-t">频道群桥（管理员）</div>
      <div class="st-d">在频道旁「⇄钉钉」处绑定钉钉群会话（openConversationId + robotCode）后，开启「钉钉同步」的消息将投递到群。</div></div></div>
    <p class="note">安全边界：身份绑定事实源为 iam identityLinks（扫码授权）；出向投递凭证单一来源=连接器配置（本面板零凭证）；
    高风险审批钉钉回决必须二次确认（fail-closed）；入向 Stream 在官方连接器暴露面核对前停用（R-SPIKE）。</p>`)
  const startBtn = document.getElementById('bindStart')
  if (startBtn) {
    startBtn.onclick = async () => {
      try {
        const authorize = await api.post('/api/auth/sso/bind/authorize', { provider: 'dingtalk' })
        const url = authorize.redirectUrl ?? authorize.url ?? authorize.redirect_uri
        if (url) {
          window.open(url, '_blank', 'width=520,height=640')
          void toast('已打开钉钉授权页，完成后回到本页自动刷新状态')
          setTimeout(() => { void refreshDingtalk().then(() => { hideModal(); void showBind() }) }, 4000)
        } else {
          void toast('平台未返回授权地址，请检查钉钉连接器登录配置', 'error')
        }
      } catch (error) {
        void toast(error.message, 'error')
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 面板配置抽屉（widget/KPI/Agent 阵容，panel.config.write）
// ---------------------------------------------------------------------------

async function showConfig() {
  const dept = state.overview.dept
  let orgs = null
  try {
    orgs = (await api.get('/api/panel/orgs')).orgs
  } catch { /* 无 panel.config.write 或组织面不可用：隐藏绑定区 */ }
  showModal(`⚙ ${dept.label}面板配置`, `
    <p class="note" style="margin-top:0">配置需 panel.config.write 权限。修改立即生效（全程审计）。</p>
    ${orgs ? `
    <div style="margin:12px 0">
      <div class="col-title"><span>组织绑定（账号组织打通：绑定后仅该组织子树成员可访问本部门）</span></div>
      <div class="lic-row"><span class="lr-ic">🏷</span>
        <select id="cfgOrg" style="flex:1;border:1px solid var(--line);border-radius:6px;padding:6px 8px;font-size:12px">
          <option value="">（不绑定——对全部 panel.read 持有者开放）</option>
          ${orgs.map((org) => `<option value="${esc(org.id)}" ${state.overview.org?.id === org.id ? 'selected' : ''}>${esc(org.name)}</option>`).join('')}
        </select>
      </div>
    </div>` : ''}
    <div style="margin:12px 0">
      <div class="col-title"><span>AGENT 阵容（@唤起键 · 绑定 Agent 资产后可真实调用）</span></div>
      ${dept.agents.map((agent, index) => `
        <div class="lic-row"><span class="lr-ic">${esc(agent.icon)}</span>
          <span style="flex:1">${esc(agent.name)}${agent.asset ? `<span style="font-size:10px;color:${agent.asset.status === 'online' ? '#16a34a' : 'var(--txt2)'}"> · 资产 ${esc(agent.asset.name)}（${esc(agent.asset.status)}）</span>` : ''}<span style="display:block;font-size:10px;color:var(--txt2)">${esc(agent.desc)}</span></span>
          <input id="agentRef${index}" value="${esc(agent.agentRef ?? '')}" placeholder="agent:资产id/slug（可空）"
            style="border:1px solid var(--line);border-radius:6px;padding:4px 8px;font-size:11px;width:180px">
        </div>`).join('')}
      <div class="col-title" style="margin-top:12px"><span>WIDGET 来源（连接器接入前均为 mock/手工 徽标）</span></div>
      ${dept.widgets.map((widget) => `
        <div class="lic-row"><span class="lr-ic">📊</span><span>${esc(widget.title)}</span>
          <span class="lr-st" style="background:var(--bg);color:var(--txt2)">${esc(widget.source)}${widget.ref ? ` · ${esc(widget.ref)}` : ''}</span></div>`).join('')}
    </div>
    <div style="display:flex;gap:10px">
      <button class="btn primary" id="cfgSave">保存配置</button>
      <button class="btn" id="cfgCancel">关闭</button>
    </div>`)
  document.getElementById('cfgCancel').onclick = hideModal
  document.getElementById('cfgSave').onclick = async (event) => {
    event.target.disabled = true
    try {
      const agents = dept.agents.map((agent, index) => {
        const ref = document.getElementById(`agentRef${index}`).value.trim()
        const rest = { name: agent.name, desc: agent.desc, icon: agent.icon, ...(agent.busy ? { busy: true } : {}) }
        return ref ? { ...rest, agentRef: ref } : rest
      })
      const orgSelect = document.getElementById('cfgOrg')
      const promises = [api.put(`/api/panel/${dept.id}/agents`, { agents })]
      if (orgSelect) promises.push(api.put(`/api/panel/${dept.id}/config`, { orgId: orgSelect.value || null }))
      const [agentsRes] = await Promise.all(promises)
      state.overview.dept.agents = agentsRes.agents
      hideModal()
      void toast('配置已保存（范围权限/阵容绑定立即生效）')
      void refreshOverview()
    } catch (error) {
      event.target.disabled = false
      void toast(error.message, 'error')
    }
  }
}

// ---------------------------------------------------------------------------
// 模型配置（与 dsh 服务共用 modelgw 唯一事实源；读 panel.read / 管 panel.config.write）
// ---------------------------------------------------------------------------

async function showModels() {
  let models
  try {
    models = (await api.get('/api/panel/models')).models ?? []
  } catch (error) {
    void toast(error.message, 'error')
    return
  }
  state.models = models
  const canEdit = session.can('panel.config.write')
  const rows = models.map((model) => `
    <div class="lic-row">
      <span class="lr-ic">🧠</span>
      <span style="flex:1;min-width:0">
        ${esc(model.displayName || model.slug)} <span class="mono">${esc(model.slug)}</span>
        <span style="display:block;font-size:10px;color:var(--txt2)">${esc(model.provider)} · ${esc(model.endpoint || '（未配置 endpoint，拒绝调用）')}</span>
        <span style="display:block;font-size:10px;color:var(--txt2)">挂牌 ${esc(model.listCentsPerKTokens)} / 成本 ${esc(model.costCentsPerKTokens)} 分/千tokens · 密钥 ${esc(model.apiKey)}</span>
      </span>
      <span class="st ${model.status === 'online' ? 'ok' : 'lock'}" style="margin-left:0">${model.status === 'online' ? '在线' : '离线'}</span>
      ${canEdit ? `<span class="model-ops">
        <button class="btn" data-mtest="${esc(model.slug)}" title="真实调用一次（走计量计费全链，失败如实回传）">测试</button>
        <button class="btn" data-medit="${esc(model.id)}">编辑</button>
        <button class="btn" data-mdel="${esc(model.id)}" title="从目录移除登记（计量与审计数据保留）">删除</button>
      </span>` : ''}
    </div>`).join('')
    || '<div class="sys-line"><span>模型目录为空：登记后即可在协作会话切换模型、供 Agent 真实调用。</span></div>'
  showModal('🧠 模型配置（与 dsh 服务共用模型目录）', `
    <p class="note" style="margin-top:0">模型目录（modelgw）是平台服务唯一的模型事实源：此处登记的模型 = 协作会话对话框可切换的模型 = 面板 Agent 实际调用的模型，与 dsh 本身服务保持一致。调用走真实上游（OpenAI 兼容 chat/completions），未配置 endpoint 的模型拒绝调用、绝不造假回复。</p>
    <div style="margin:12px 0">${rows}</div>
    ${canEdit ? `<div style="display:flex;gap:10px">
      <button class="btn primary" id="modelAdd">＋ 登记模型</button>
      <button class="btn" id="modelClose">关闭</button>
    </div>` : '<p class="note">登记/修改模型需 panel.config.write 权限。</p>'}`)
  const closeBtn = document.getElementById('modelClose')
  if (closeBtn) closeBtn.onclick = hideModal
  const addBtn = document.getElementById('modelAdd')
  if (addBtn) addBtn.onclick = () => showModelForm(null)
  document.querySelectorAll('[data-mtest]').forEach((el) => {
    el.onclick = async () => {
      el.disabled = true
      try {
        // 真实外呼可能慢于默认 20s（QA BUG-U-03 超时豁免项）
        const result = await api.post(`/api/panel/models/${encodeURIComponent(el.dataset.mtest)}/test`, {}, { timeoutMs: 60_000 })
        void toast(result.ok ? `✓ ${result.model} 连通正常（输出 ${result.outputTokens} tokens）` : `✗ 连通失败：${result.error}`, result.ok ? undefined : 'error')
      } catch (error) {
        void toast(error.message, 'error')
      } finally {
        el.disabled = false
      }
    }
  })
  document.querySelectorAll('[data-medit]').forEach((el) => {
    el.onclick = () => showModelForm(models.find((model) => model.id === el.dataset.medit) ?? null)
  })
  document.querySelectorAll('[data-mdel]').forEach((el) => {
    el.onclick = async () => {
      const model = models.find((item) => item.id === el.dataset.mdel)
      if (!window.confirm(`确定从模型目录移除「${model?.slug ?? el.dataset.mdel}」？（绑定该模型的 Agent 将无法调用）`)) return
      el.disabled = true
      try {
        await api.delete(`/api/panel/models/${el.dataset.mdel}`)
        void toast('已移除模型登记')
        void showModels()
        void refreshModels().then(() => { if (state.tab === 'chat') renderMain() })
      } catch (error) {
        el.disabled = false
        void toast(error.message, 'error')
      }
    }
  })
}

function showModelForm(existing) {
  showModal(existing ? `🧠 编辑模型 · ${esc(existing.slug)}` : '🧠 登记模型（OpenAI 兼容 chat/completions）', `
    <div class="mform">
      <label>模型 slug（唯一标识；Agent 资产 model 属性与对话框切换均使用它）*
        <input id="mfSlug" value="${esc(existing?.slug ?? '')}" ${existing ? 'disabled title="slug 是登记主键，如需变更请新建登记"' : ''} placeholder="如 deepseek-chat"></label>
      <label>显示名<input id="mfName" value="${esc(existing?.displayName ?? '')}" placeholder="缺省同 slug"></label>
      <label>厂商<input id="mfProvider" value="${esc(existing?.provider ?? '')}" placeholder="如 deepseek / aliyun / openai"></label>
      <label>Endpoint（OpenAI 兼容基址）*<input id="mfEndpoint" value="${esc(existing?.endpoint ?? '')}" placeholder="如 https://api.deepseek.com/v1"></label>
      <label>API Key${existing ? '（留空保持不变）' : ''}<input id="mfKey" type="password" autocomplete="new-password" placeholder="${existing ? '留空保持既有密钥' : '直填或环境变量引用（如 env:DEEPSEEK_API_KEY）'}"></label>
      <div class="mform-grid">
        <label>挂牌价（分/千 tokens）*<input id="mfList" type="number" min="0" step="0.1" value="${existing?.listCentsPerKTokens ?? 0}"></label>
        <label>成本价（分/千 tokens）<input id="mfCost" type="number" min="0" step="0.1" value="${existing?.costCentsPerKTokens ?? ''}" placeholder="缺省为挂牌价一半"></label>
      </div>
      <label>状态<select id="mfStatus">
        <option value="online" ${existing?.status !== 'offline' ? 'selected' : ''}>在线（可调用）</option>
        <option value="offline" ${existing?.status === 'offline' ? 'selected' : ''}>离线（停用）</option>
      </select></label>
    </div>
    <div style="display:flex;gap:10px">
      <button class="btn primary" id="mfSave">保存</button>
      <button class="btn" id="mfCancel">返回列表</button>
    </div>
    <p class="note">密钥支持 env: 变量名引用（调用时读取进程环境变量），回显一律脱敏；保存即生效并全程审计。保存后可用列表中「测试」真实调用一次验证连通（按量计费）。</p>`)
  document.getElementById('mfCancel').onclick = () => void showModels()
  document.getElementById('mfSave').onclick = async (event) => {
    const payload = {
      slug: document.getElementById('mfSlug').value.trim(),
      displayName: document.getElementById('mfName').value.trim(),
      provider: document.getElementById('mfProvider').value.trim(),
      endpoint: document.getElementById('mfEndpoint').value.trim(),
      listCentsPerKTokens: Number(document.getElementById('mfList').value) || 0,
      status: document.getElementById('mfStatus').value,
    }
    const cost = document.getElementById('mfCost').value
    if (cost !== '') payload.costCentsPerKTokens = Number(cost)
    const key = document.getElementById('mfKey').value.trim()
    if (key) payload.apiKey = key
    if (!payload.slug) { void toast('模型 slug 必填', 'error'); return }
    if (!payload.endpoint) { void toast('Endpoint 必填（未配置不可调用）', 'error'); return }
    event.target.disabled = true
    try {
      await api.post('/api/panel/models', payload)
      void toast(`模型 ${payload.slug} 已保存`)
      await refreshModels()
      if (state.tab === 'chat') renderMain()
      void showModels()
    } catch (error) {
      event.target.disabled = false
      void toast(error.message, 'error')
    }
  }
}

function showNewChannel() {
  showModal('＋ 发起协作（新建频道）', `
    <div style="display:flex;flex-direction:column;gap:10px">
      <input id="chanName" placeholder="频道名（如：异常快速响应群）" style="border:1px solid var(--line);border-radius:8px;padding:9px 12px;font-size:13px">
      <div style="display:flex;gap:10px">
        <button class="btn primary" id="chanSubmit">创建</button>
        <button class="btn" id="chanCancel">取消</button>
      </div>
    </div>`)
  document.getElementById('chanCancel').onclick = hideModal
  document.getElementById('chanSubmit').onclick = async (event) => {
    const name = document.getElementById('chanName').value.trim()
    if (!name) { void toast('频道名必填', 'error'); return }
    event.target.disabled = true
    try {
      const result = await api.post(`/api/panel/${state.dept}/channels`, { name })
      state.overview.channels.push({ ...result.channel, unread: 0 })
      state.channelId = result.channel.id
      localStorage.setItem(`panel_channel_${state.dept}`, state.channelId)
      hideModal()
      renderColLeft()
      state.tab = 'chat'
      await loadTab()
      renderMain()
    } catch (error) {
      event.target.disabled = false
      void toast(error.message, 'error')
    }
  }
}

// ---------------------------------------------------------------------------
// ⌘K（动态源：Agent / 频道 / 场景 / 同事）
// ---------------------------------------------------------------------------

async function openCmdk() {
  const mask = document.createElement('div')
  mask.className = 'cmdk-mask'
  mask.innerHTML = `
    <div class="cmdk">
      <input id="cmdkInput" placeholder="搜索 Agent / 技能 / 频道 / 场景 / 同事…">
      <div class="cmdk-list" id="cmdkList"></div>
    </div>`
  document.body.appendChild(mask)
  mask.addEventListener('click', (event) => {
    if (event.target === mask) mask.remove()
  })
  const input = mask.querySelector('#cmdkInput')
  const list = mask.querySelector('#cmdkList')
  input.focus()

  const sources = []
  for (const dept of state.depts) {
    for (const agent of dept.agents) sources.push({ group: 'Agent', icon: agent.icon, label: agent.name, sub: dept.label, act: () => { mask.remove(); void switchDept(dept.id); atMention(agent.name) } })
  }
  for (const dept of state.depts) {
    for (const channel of state.overview?.dept?.id === dept.id ? state.overview.channels : []) {
      sources.push({ group: '频道', icon: '#', label: channel.name, sub: dept.label, act: () => { mask.remove(); void switchDept(dept.id).then(() => switchChannel(channel.id)) } })
    }
  }
  // 技能源（C1-2）：选中即回协作会话并把 /技能名 填进输入框
  for (const skill of state.skills.slice(0, 8)) {
    sources.push({ group: '技能', icon: '⚡', label: skill.name, sub: skill.summary || skill.category, act: () => { mask.remove(); state.tab = 'chat'; localStorage.setItem('panel_tab', 'chat'); insertSkill(skill.name) } })
  }
  try {
    const graph = state.industry ? await api.get(`/api/panel/scenegraph?industry=${state.industry.code.toUpperCase()}`) : null
    if (graph) {
      for (const [activity, scenes] of Object.entries(graph.pack.activities)) {
        for (const scene of scenes) {
          sources.push({ group: '场景', icon: '🗺', label: `${scene.code} ${scene.name}`, sub: activityLabel(activity), act: () => { mask.remove(); state.tab = 'scene'; void loadTab().then(renderMain) } })
        }
      }
    }
  } catch { /* 图谱不可用时跳过场景源 */ }
  let colleagues = []
  // 同事源：部门名册（账号组织打通，随总览下发、无额外权限要求）优先，roster 接口兜底
  colleagues = (state.overview?.members ?? []).map((member) => ({ group: '同事', icon: '🧑', label: member.name, sub: member.title ?? member.orgName ?? '', act: () => { mask.remove(); atMention(member.name) } }))
  if (colleagues.length === 0) {
    try {
      const roster = await api.get('/api/iam/roster')
      colleagues = roster.users.slice(0, 200).map((user) => ({ group: '同事', icon: '🧑', label: user.displayName ?? user.name ?? user.id, sub: user.orgName ?? '', act: () => { mask.remove(); atMention(String(user.displayName ?? user.name ?? '')) } }))
    } catch { /* 无 iam.roster.read 权限且部门名册为空时诚实略过 */ }
  }
  sources.push(...colleagues)

  const render = () => {
    const query = input.value.trim().toLowerCase()
    const hits = sources.filter((item) => !query || item.label.toLowerCase().includes(query) || item.sub.toLowerCase().includes(query)).slice(0, 40)
    list.innerHTML = hits.length === 0 ? '<div class="cmdk-empty">无匹配结果</div>'
      : [...new Set(hits.map((item) => item.group))].map((group) => `
        <div class="cmdk-group">${group}</div>
        ${hits.filter((item) => item.group === group).map((item, index) => `
          <div class="cmdk-item" data-idx="${hits.indexOf(hits.filter((x) => x.group === group)[index])}">
            <span>${esc(item.icon)}</span><span>${esc(item.label)}</span><span class="sub">${esc(item.sub)}</span>
          </div>`).join('')}`).join('')
    list.querySelectorAll('.cmdk-item').forEach((el) => {
      el.onclick = () => hits[Number(el.dataset.idx)]?.act()
    })
  }
  input.oninput = render
  render()
}

// ---------------------------------------------------------------------------
// 战略看板视图（双轨：/panel 面自持看板，数据面 /api/panel/board 一套端点下发）
// ---------------------------------------------------------------------------

/** 顶栏视图切换：工作台（rail+dept 三栏）与战略看板互斥显隐；看板首次进入才拉数据。 */
function applyView() {
  const rail = document.getElementById('rail')
  const dept = document.getElementById('dept')
  const board = document.getElementById('board')
  if (!rail || !dept || !board) return
  const isBoard = state.view === 'board'
  rail.style.display = isBoard ? 'none' : ''
  dept.style.display = isBoard ? 'none' : ''
  board.style.display = isBoard ? '' : 'none'
  if (isBoard) void renderBoardView()
}

/** 战略看板：聚合面（资产/漏斗/趋势/WAIC/ROI）+ 卡片包面（角色×平台下发，上限 6 张）。 */
async function renderBoardView() {
  const host = document.getElementById('board')
  if (!host) return
  const stamp = `${state.boardPlatform}|${state.view}`
  if (host.dataset.loaded === stamp) return
  host.innerHTML = '<div class="board-loading">看板加载中…</div>'
  try {
    const q = state.boardPlatform ? `?platform=${encodeURIComponent(state.boardPlatform)}` : ''
    const b = await api.get(`/api/panel/board${q}`)
    host.dataset.loaded = stamp
    const platforms = b.availablePlatforms ?? []
    const funnel = b.funnel ?? {}
    const days = b.byDay ?? []
    const maxDay = Math.max(1, ...days.map((d) => d.count))
    const cards = (b.cards ?? []).map((card) => (
      `<a class="board-card" target="_blank" rel="noopener" href="${basePath() || ''}/${esc(card.href)}">` +
      `<span class="bc-badge">${esc(card.badge)}</span>` +
      `<div class="bc-title">${esc(card.title)}</div>` +
      `<div class="bc-desc">${esc(card.description)}</div></a>`
    )).join('')
    host.innerHTML = `
      <div class="board-head">
        <div class="board-title">📈 战略看板<span class="tag">${esc(b.platform ?? '')}${b.label ? ' · ' + esc(b.label) : ''}</span></div>
        <div class="board-plat">${platforms.map((pf) => `<span class="plat-chip${pf === b.platform ? ' active' : ''}" data-p="${esc(pf)}">${esc(PLATFORM_LABELS[pf] ?? pf)}</span>`).join('')}</div>
        <span class="board-stamp">更新于 ${esc(fmtTime(b.generatedAt))} · 近 ${esc(String(b.windowDays ?? 7))} 天</span>
      </div>
      <div class="board-grid">
        <div class="board-blk"><h3>在线资产</h3><div class="board-row">
          <div class="kpi"><div class="v">${b.assets?.appsOnline ?? 0}</div><div class="k">AI 应用</div></div>
          <div class="kpi"><div class="v">${b.assets?.agentsOnline ?? 0}</div><div class="k">Agent 本体</div></div>
          <div class="kpi"><div class="v">${b.assets?.skillsPublished ?? 0}</div><div class="k">已上架技能</div></div>
          <div class="kpi"><div class="v">${b.assets?.mcpServing ?? 0}</div><div class="k">MCP 服务中</div></div>
        </div></div>
        <div class="board-blk"><h3>价值漏斗（曝光 → 点击 → 调用 → 完成）</h3><div class="board-funnel">
          <div class="fn-step"><div class="v">${funnel.exposed ?? 0}</div><div class="k">曝光</div></div><span class="fn-arr">→</span>
          <div class="fn-step"><div class="v">${funnel.clicked ?? 0}</div><div class="k">点击</div></div><span class="fn-arr">→</span>
          <div class="fn-step"><div class="v">${funnel.invoked ?? 0}</div><div class="k">调用</div></div><span class="fn-arr">→</span>
          <div class="fn-step"><div class="v">${funnel.completed ?? 0}</div><div class="k">完成</div></div>
        </div></div>
        <div class="board-blk"><h3>调用量趋势（近 7 天）</h3><div class="board-days">${days.map((d) => `<div class="day" style="height:${Math.round((d.count / maxDay) * 64) + 4}px" title="${esc(d.day)}：${d.count} 次"><i></i></div>`).join('') || '<span class="dim">暂无数据</span>'}</div></div>
        <div class="board-blk"><h3>WAIC 口径（近 7 天）</h3><div class="board-row">
          <div class="kpi"><div class="v">${b.waic?.count ?? 0}</div><div class="k">调用次数</div></div>
          <div class="kpi"><div class="v">¥${(((b.waic?.chargeCents ?? 0)) / 100).toFixed(2)}</div><div class="k">平台费用</div></div>
        </div></div>
        <div class="board-blk"><h3>ROI 用工成本估算（WP-14）</h3><div class="board-row">
          <div class="kpi"><div class="v">${b.roi?.estimatedHoursSaved ?? 0}h</div><div class="k">替代工时（估）</div></div>
          <div class="kpi"><div class="v">¥${((b.roi?.estimatedLaborCostCents ?? 0) / 100).toFixed(0)}</div><div class="k">人力成本（估）</div></div>
          <div class="kpi"><div class="v">¥${((b.roi?.platformChargeCents ?? 0) / 100).toFixed(2)}</div><div class="k">平台费用</div></div>
        </div><p class="board-note">${esc(b.roi?.note ?? '')}</p></div>
        <div class="board-blk"><h3>部门快捷入口（上限 6 张）</h3><div class="board-cards">${cards || '<span class="dim">当前平台暂无卡片</span>'}</div></div>
      </div>`
    host.querySelectorAll('.plat-chip').forEach((chip) => {
      chip.onclick = () => {
        state.boardPlatform = chip.dataset.p ?? ''
        localStorage.setItem('panel_board_platform', state.boardPlatform)
        host.dataset.loaded = ''
        void renderBoardView()
      }
    })
  } catch (error) {
    host.innerHTML = `<div class="board-loading">看板加载失败：${esc(String(error?.message ?? error))}</div>`
  }
}
