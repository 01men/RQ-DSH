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
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/**
 * 白名单渲染（治理 DoD：XSS 面）：先全量转义，再仅放行 <b> 与 mention span——
 * 服务端种子/Agent 产出的轻标记可渲染，任何其他 HTML 一律按文本显示。
 */
export function md(text) {
  let s = esc(text)
  s = s.replaceAll('&lt;b&gt;', '<b>').replaceAll('&lt;/b&gt;', '</b>')
  s = s.replaceAll(`&lt;span class='mention'&gt;`, '<span class="mention">')
  s = s.replaceAll('&lt;span class="mention"&gt;', '<span class="mention">')
  s = s.replaceAll('&lt;/span&gt;', '</span>')
  // 纯文本里的 @提及（无 HTML 包裹）高亮
  s = s.replace(/(^|[\s（(])@([\p{L}\p{N}·]{2,20})/gu, '$1<span class="mention">@$2</span>')
  return s
}

const stars = (n) => '★'.repeat(n) + '☆'.repeat(4 - n)
const fmtTime = (iso) => (iso ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : '')
const TAG_CLS = { 提质: 'tg-tz', 降本: 'tg-jb', 增效: 'tg-zx', 节能: 'tg-jn', 新模式: 'tg-xm' }
const LANE_LABELS = { todo: '待办', doing: '进行中', review: '待审', done: '完成' }
const LANE_ORDER = ['todo', 'doing', 'review', 'done']
const ART_KINDS = { report: '报告', order: '工单', quote: '报价', diagnosis: '诊断', other: '沉淀' }

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

const state = {
  hostBridge: false,
  depts: [],
  dept: localStorage.getItem('panel_dept') ?? 'mfg',
  overview: null,
  industries: [],
  industry: null,
  ddStatus: null,
  bridges: [],
  tab: localStorage.getItem('panel_tab') ?? 'chat',
  channelId: localStorage.getItem('panel_channel') ?? '',
  messages: [],
  tasks: [],
  artifacts: [],
  scenegraph: null,
  ddSync: localStorage.getItem('panel_ddsync') === '1',
  stream: null,
  streamDept: '',
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

export function start({ base, hostBridge = false }) {
  apiSetBase(base)
  depsSetBase(base)
  state.hostBridge = hostBridge
  if (!session.token) {
    renderLoginGuide()
    return
  }
  // 先落外壳骨架（数据慢/失败时页面不再是白屏），数据加载失败显式提示
  renderShell()
  renderTopRight()
  void init()
}

function renderLoginGuide() {
  // 回跳语义：登录成功后带 ?next= 回到面板（登录页消费一次），不再让业务员落在控制台后自己找路
  const here = encodeURIComponent(location.pathname + location.search + location.hash)
  document.getElementById('app').innerHTML = `
    <div class="login-guide">
      <h1>🌳 榕器 · 部门 Agent 工作台</h1>
      <p>当前浏览器没有有效的平台会话。<br>
      请从控制台登录后进入，或从钉钉/门户的「打开即工作台」入口点入（自动票据免登）。</p>
      <a href="${basePath() || '/'}?next=${here}#/login"><button class="btn primary">去控制台登录</button></a>
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

// ---------------------------------------------------------------------------
// 实时通道（SSE 优先 + 轮询降级；复用 console realtime.js）
// ---------------------------------------------------------------------------

function connectStream() {
  if (state.stream && state.streamDept === state.dept) return
  if (state.stream) { try { state.stream.close() } catch { /* 已关闭 */ } }
  state.streamDept = state.dept
  void realtimeDep().then((mod) => {
    state.stream = mod.createEventStream({
      url: `${basePath()}/api/panel/stream?dept=${state.dept}&token=${encodeURIComponent(session.token)}`,
      pollPath: `${basePath()}/api/panel/${state.dept}/poll`,
      pollIntervalMs: 30_000,
      headers: session.token ? { authorization: `Bearer ${session.token}` } : {},
      onMessage: (data) => handleRealtime(data),
      onDowngrade: () => renderLiveBadge(),
    })
  })
}

async function handleRealtime(data) {
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
    <div class="topbar">
      <div class="logo">🌳 榕器 <span class="badge">部门工作台</span></div>
      <div class="ind-sel">
        <div class="ind-btn" id="indBtn">
          <span>${esc(activeIndustry?.icon ?? '🏢')}</span><span>${esc(activeIndustry?.name ?? '未激活行业')}</span>
          <span class="${activeIndustry ? 'dotok' : 'dotlock'}"></span><span style="color:#6b7280">▾</span>
        </div>
        <div class="ind-menu" id="indMenu"></div>
      </div>
      <div class="top-search" id="cmdkTrigger"><span>搜索 Agent / 频道 / 场景 / 同事…</span><span class="kbd">⌘K</span></div>
      <div class="top-right" id="topRight"></div>
    </div>
    <div class="body">
      <div class="rail" id="rail"></div>
      <div class="dept" id="dept"></div>
    </div>`
  document.getElementById('indBtn').onclick = (event) => { event.stopPropagation(); renderIndMenu(); document.getElementById('indMenu').classList.toggle('show') }
  document.addEventListener('click', () => document.getElementById('indMenu')?.classList.remove('show'))
  document.getElementById('cmdkTrigger').onclick = () => openCmdk()
  renderRail()
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
  const user = session.user
  host.innerHTML = `${pill}
    <span class="pill" data-live id="livePill"><span class="dot"></span>LIVE</span>
    <div class="avatar" title="${esc(user?.displayName ?? '')}">${esc((user?.displayName ?? '?').slice(0, 1))}</div>`
  document.getElementById('ddPill').onclick = () => showBind()
}

function renderLiveBadge() {
  const pill = document.getElementById('livePill')
  if (pill) pill.innerHTML = '<span class="dot" style="background:#f59e0b"></span>30s 轮询'
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
    ${state.hostBridge ? `<a class="rail-console" href="/" title="打开 Agent 对话（dsh 宿主）" style="text-decoration:none">
      <div class="ico">💬</div><div>Agent<br>对话</div></a>` : ''}
    <a class="rail-console" href="${basePath() || '/'}" title="打开榕器管理控制台" style="text-decoration:none"
      data-landing="console">
      <div class="ico">🧩</div><div>管理<br>控制台</div></a>`
  rail.querySelectorAll('.rail-item').forEach((el) => {
    el.onclick = () => {
      const dept = state.depts.find((item) => item.id === el.dataset.dept)
      if (dept?.allowed === false) { void toast('部门范围受限：该部门已绑定其他组织治理', 'error'); return }
      void switchDept(el.dataset.dept)
    }
  })
  // 显式跨工作台切换：记住去向（控制台启动分诊尊重该偏好，不再把人拽回面板）
  rail.querySelectorAll('[data-landing]').forEach((el) => {
    el.addEventListener('click', () => {
      try { localStorage.setItem('heng_ops_landing', el.dataset.landing) } catch { /* 忽略 */ }
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
        <button class="btn" id="btnConfig">⚙ 面板配置</button>
        <button class="btn primary" id="btnNewChannel">＋ 发起协作</button>
      </div>
    </div>
    <div class="cols">
      <div class="col-left" id="colLeft"></div>
      <div class="col-main" id="colMain"></div>
      <div class="col-right" id="colRight"></div>
    </div>`
  document.getElementById('btnConfig').onclick = () => showConfig()
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
  host.innerHTML = `
    <div class="tabs">
      <div class="tab ${state.tab === 'chat' ? 'on' : ''}" data-tab="chat">💬 协作会话<span class="mini">人 × Agent × 钉钉</span></div>
      <div class="tab ${state.tab === 'tasks' ? 'on' : ''}" data-tab="tasks">📌 任务看板</div>
      <div class="tab ${state.tab === 'arts' ? 'on' : ''}" data-tab="arts">📁 部门知识</div>
      <div class="tab ${state.tab === 'scene' ? 'on' : ''}" data-tab="scene">🗺 场景图谱<span class="mini">${esc(industry?.code ?? '未激活')}</span></div>
    </div>
    <div id="tabBody"></div>
    ${state.tab === 'chat' ? composerHtml() : ''}`
  host.querySelectorAll('.tab').forEach((el) => {
    el.onclick = async () => {
      state.tab = el.dataset.tab
      localStorage.setItem('panel_tab', state.tab)
      await loadTab()
      renderMain()
    }
  })
  const body = host.querySelector('#tabBody')
  if (state.tab === 'chat') { renderMessages(body); wireComposer(host) }
  else if (state.tab === 'tasks') renderKanban(body)
  else if (state.tab === 'arts') renderArtifacts(body)
  else if (state.tab === 'scene') renderScenegraph(body)
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
}

function messageHtml(m, ddBound) {
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
      <div class="m-body"><div class="m-meta">${esc(m.senderName)} <span class="role">Agent</span></div>
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

function composerHtml() {
  const dept = state.overview.dept
  const bound = Boolean(state.ddStatus?.bound)
  const members = (state.overview.members ?? []).slice(0, 6)
  return `
    <div class="composer">
      <div class="at-row">
        <span style="font-size:11px;color:var(--txt2)">@ 唤起：</span>
        ${dept.agents.map((agent) => `<span class="at-chip ag" data-at="${esc(agent.name)}">🤖 ${esc(agent.name)}</span>`).join('')}
        ${members.map((member) => `<span class="at-chip" data-at="${esc(member.name)}" title="${esc(member.title ?? '')}${member.orgName ? ` · ${esc(member.orgName)}` : ''}">🧑 ${esc(member.name)}</span>`).join('')}
        ${bound ? '<span class="at-chip ddu" data-at="钉群·全员">⇄ 钉群·全员</span>'
          : '<span class="at-chip" id="bindHint">🔗 绑定钉钉后可 @ 钉钉同事</span>'}
        <span class="dd-toggle" id="ddToggle"><span class="sw ${state.ddSync && bound ? 'on' : ''} ${bound ? '' : 'disabled'}" id="ddSw"></span>钉钉同步</span>
      </div>
      <div class="input-row">
        <input id="composerInput" placeholder="发消息给同事 / @Agent 下达任务${bound && state.ddSync ? ' / 本条将同步钉钉群' : ''}…（Enter 发送）">
        <button class="send" id="composerSend">发送</button>
      </div>
    </div>`
}

function wireComposer(host) {
  const input = host.querySelector('#composerInput')
  if (!input) return
  host.querySelectorAll('[data-at]').forEach((el) => {
    el.onclick = () => atMention(el.dataset.at, input)
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
}

function atMention(name, inputEl) {
  const input = inputEl ?? document.querySelector('#composerInput')
  if (!input) { void toast('请先切到「协作会话」再 @ 唤起'); return }
  input.value = `@${name} ${input.value}`
  input.focus()
}

async function sendMessage(input) {
  const text = input.value.trim()
  if (!text || !state.channelId) return
  input.value = ''
  try {
    const result = await api.post(`/api/panel/${state.dept}/messages`, {
      channelId: state.channelId, text, ddSync: state.ddSync && Boolean(state.ddStatus?.bound),
    })
    state.messages.push(result.message)
    renderMessages()
    void refreshOverview()
  } catch (error) {
    input.value = text
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
      if (!state.ddStatus?.bound) { showBind(); return }
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
      <input id="cmdkInput" placeholder="搜索 Agent / 频道 / 场景 / 同事…">
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
