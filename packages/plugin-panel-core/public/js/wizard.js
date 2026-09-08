/**
 * 连接与登录向导（M2，fresh-install 首启体验）。
 *
 * 触发：boot.js 探测到宿主连接为 none 且浏览器无会话时渲染本向导。
 * 两条路径（B/C 双形态）：
 *   - 本机初始化（形态 B）：本机即宿主。首启时可在此直接设置 admin 口令（初始口令
 *     全程不出服务端）；可选对外 IP 并生成本机监听指引；随后本机登录。
 *   - 连接远端宿主（形态 C）：手输/扫描宿主地址（IP:port）→ 测试连接 → 账号密码登录
 *     （经本机插件代理，浏览器零跨域）；钉钉扫码引导到宿主登录页完成。
 *
 * 数据面：全部经 /rqcard/* 免登向导端点（须带 x-rqcard-call 头，服务端 CSRF 防线）；
 * 远端登录经 /rqcard/proxy/api/auth/login（白名单内）。登录成功后 location.reload()
 * 重走 boot 链（作用域/代理/会话一次性就位）。
 */
import { setConnectionScope, session } from './api.js'

const esc = (text) => String(text ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

const HISTORY_KEY = 'panel_hub_history'

/** 向导端点请求：统一带向导头；非 2xx 抛错（error.message 透出）。 */
async function wfetch(base, method, wpath, body) {
  const response = await fetch(`${base}${wpath}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-rqcard-call': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error?.message ?? `请求失败（${response.status}）`)
  }
  return payload?.data
}

function readHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') } catch { return [] }
}

function rememberHub(hubBase, label) {
  const list = readHistory().filter((item) => item.hubBase !== hubBase)
  list.unshift({ hubBase, label: label ?? '', savedAt: new Date().toISOString() })
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 6)))
}

export async function start({ base, hostBridge = false, localFirstRun = false }) {
  const root = document.getElementById('app')
  root.innerHTML = `
    <div class="wizard">
      <div class="wz-head">
        <div class="wz-logo">🌳 榕器 <span class="badge">连接与登录向导</span></div>
        <p>刚刚安装的 dsh 插件还未连接宿主服务。选择「把本机初始化为宿主」或「连接局域网内的宿主」，
        连接并登录后即可完整使用部门工作台 / 战略看板 / Agent 协作。</p>
      </div>
      <div class="wz-cards">
        <section class="wz-card" id="wzLocal">
          <h2>🖥 本机宿主（形态 B）</h2>
          <p class="wz-sub">本机 dsh 即企业宿主：面板、控制台、对话面同进程单入口。</p>
          <div id="wzLocalBody"></div>
        </section>
        <section class="wz-card" id="wzRemote">
          <h2>🔗 连接远端宿主（形态 C）</h2>
          <p class="wz-sub">本机 dsh 作为客户端，连接局域网内已部署的宿主服务（选择 IP）。</p>
          <div id="wzRemoteBody"></div>
        </section>
      </div>
      <p class="wz-foot">向导端点位于免登命名空间（/rqcard/*，服务端校验向导头 + 代理白名单）；
      钉钉扫码在宿主登录页完成（宿主侧回跳增强见交接清单 G1）。</p>
    </div>`

  renderLocalCard(root, base, { hostBridge, localFirstRun })
  renderRemoteCard(root, base)
}

// ---------------------------------------------------------------- 本机宿主（形态 B）

async function renderLocalCard(root, base, { localFirstRun }) {
  const body = root.querySelector('#wzLocalBody')
  let init = null
  try {
    init = await wfetch(base, 'GET', '/rqcard/local-init')
  } catch { /* 端点不可用时按已知信息渲染 */ }
  const firstRun = init?.firstRun ?? localFirstRun
  const here = encodeURIComponent(location.pathname + location.search + location.hash)

  if (firstRun) {
    body.innerHTML = `
      <div class="wz-ok">🚀 检测到本机首次启动——先为平台管理员（admin）设置登录口令：</div>
      <div class="wz-form">
        <input type="password" id="wzAdminPass" placeholder="新口令（≥8 位，不含中文）" autocomplete="new-password">
        <button class="btn primary" id="wzAdminSet">设置口令并登录</button>
      </div>
      <p class="wz-hint">初始口令文件由服务端一次性消费，全程不经过浏览器；设置成功即完成本机初始化。</p>
      <div id="wzAdminErr" class="wz-err"></div>`
    body.querySelector('#wzAdminSet').onclick = async (event) => {
      const button = event.target
      const pass = body.querySelector('#wzAdminPass').value
      button.disabled = true
      body.querySelector('#wzAdminErr').textContent = ''
      try {
        const data = await wfetch(base, 'POST', '/rqcard/local-init/admin', { username: 'admin', newPassword: pass })
        session.save(data.token, data.user)
        if (data.refreshToken) session.saveRefresh(data.refreshToken)
        await wfetch(base, 'POST', '/rqcard/link/local', {})
        window.location.reload()
      } catch (error) {
        button.disabled = false
        body.querySelector('#wzAdminErr').textContent = error.message
      }
    }
  } else {
    body.innerHTML = `
      <div class="wz-ok">✅ 本机数据面已就绪（admin 已初始化）。</div>
      <a href="${base || '/'}?next=${here}#/login"><button class="btn primary">在本机控制台登录</button></a>
      <p class="wz-hint">支持账号密码与钉钉扫码（本机同源，登录后自动回到面板）。</p>`
  }

  // 对外访问（选 IP → 生成监听指引；插件不热改 dsh webServer 监听）
  const interfaces = init?.interfaces ?? []
  if (interfaces.length > 0 || firstRun) {
    body.insertAdjacentHTML('beforeend', `
      <details class="wz-details" id="wzListen">
        <summary>📡 局域网访问（选择对外 IP）</summary>
        <div class="wz-ifaces">${interfaces.map((item, index) => `
          <button class="wz-iface" data-addr="${esc(item.address)}" data-idx="${index}">
            ${esc(item.address)}<span class="sub">${esc(item.iface)}</span>
          </button>`).join('') || '<span class="wz-hint">未枚举到非内部网卡</span>'}
        </div>
        <pre class="wz-cmd" id="wzListenCmd" hidden></pre>
      </details>`)
    body.querySelectorAll('.wz-iface').forEach((el) => {
      el.onclick = async () => {
        try {
          const plan = await wfetch(base, 'POST', '/rqcard/local-init/listen-plan', { ip: el.dataset.addr })
          const cmd = body.querySelector('#wzListenCmd')
          cmd.hidden = false
          cmd.textContent = `${plan.command}\n# ${plan.note}`
        } catch (error) {
          void alert(error.message)
        }
      }
    })
  }
}

// ---------------------------------------------------------------- 远端宿主（形态 C）

async function renderRemoteCard(root, base) {
  const body = root.querySelector('#wzRemoteBody')
  body.innerHTML = `
    <div class="wz-form">
      <input type="text" id="wzHubInput" placeholder="宿主地址，如 http://192.168.1.5:3080" spellcheck="false">
      <button class="btn primary" id="wzHubConnect">测试并连接</button>
    </div>
    <button class="btn wz-scan" id="wzHubScan">📡 扫描局域网宿主</button>
    <div class="wz-history" id="wzHubHistory"></div>
    <div class="wz-found" id="wzHubFound"></div>
    <div id="wzHubErr" class="wz-err"></div>`

  const history = readHistory()
  const historyBox = body.querySelector('#wzHubHistory')
  historyBox.innerHTML = history.length > 0
    ? `<span class="wz-hint">最近：</span>` + history.map((item) =>
      `<button class="wz-chip" data-hub="${esc(item.hubBase)}">${esc(item.hubBase)}</button>`).join('')
    : ''
  historyBox.querySelectorAll('.wz-chip').forEach((el) => {
    el.onclick = () => { body.querySelector('#wzHubInput').value = el.dataset.hub }
  })

  body.querySelector('#wzHubScan').onclick = async (event) => {
    const button = event.target
    button.disabled = true
    button.textContent = '扫描中…（约数秒）'
    const found = body.querySelector('#wzHubFound')
    found.innerHTML = '<span class="wz-hint">正在探测本网段常见端口（7300/3080）…</span>'
    try {
      const candidates = [...new Set([...history.map((item) => item.hubBase)])]
      const result = await wfetch(base, 'POST', '/rqcard/link/scan', candidates.length > 0 ? { candidates } : {})
      found.innerHTML = result.hosts.length > 0
        ? result.hosts.map((host) => `
          <button class="wz-host" data-hub="${esc(host.endpoint)}">
            <b>${esc(host.endpoint)}</b>
            <span class="sub">${host.mountPrefix === '/rq' ? 'dsh 挂载形态' : '独立宿主形态'}${host.version ? ` · v${esc(host.version)}` : ''}</span>
          </button>`).join('')
        : '<span class="wz-hint">未发现宿主——请确认宿主已启动、防火墙放行，或手输地址。</span>'
      found.querySelectorAll('.wz-host').forEach((el) => {
        el.onclick = () => { body.querySelector('#wzHubInput').value = el.dataset.hub }
      })
    } catch (error) {
      found.innerHTML = `<span class="wz-err">${esc(error.message)}</span>`
    } finally {
      button.disabled = false
      button.textContent = '📡 扫描局域网宿主'
    }
  }

  body.querySelector('#wzHubConnect').onclick = async (event) => {
    const button = event.target
    const hubBase = body.querySelector('#wzHubInput').value.trim()
    const errBox = body.querySelector('#wzHubErr')
    errBox.textContent = ''
    button.disabled = true
    try {
      const result = await wfetch(base, 'POST', '/rqcard/link/remote', { hubBase })
      rememberHub(result.config.hubBase, result.config.label)
      renderRemoteLogin(body, base, {
        hubBase: result.config.hubBase,
        hubMountPrefix: result.config.hubMountPrefix ?? '',
        version: result.probe?.version,
      })
    } catch (error) {
      errBox.textContent = error.message
    } finally {
      button.disabled = false
    }
  }
}

/** 远端连接成功后的登录步骤：账号密码（代理全闭环）+ 钉钉扫码（宿主页完成）。 */
function renderRemoteLogin(body, base, { hubBase, hubMountPrefix, version }) {
  const hubPanelBase = `${hubBase}${hubMountPrefix}`
  body.innerHTML = `
    <div class="wz-ok">✅ 已连接宿主 <b>${esc(hubBase)}</b>${version ? `（v${esc(version)}）` : ''}</div>
    <div class="wz-form">
      <input type="text" id="wzLoginUser" placeholder="账号" autocomplete="username" value="">
      <input type="password" id="wzLoginPass" placeholder="密码" autocomplete="current-password">
      <button class="btn primary" id="wzLoginGo">登录</button>
    </div>
    <button class="btn wz-dd" id="wzLoginDd">💬 用钉钉扫码登录（在宿主登录页完成）</button>
    <p class="wz-hint">账号登录经本机插件代理（令牌按连接隔离保存）；钉钉扫码会打开宿主登录页，
    在宿主侧完成扫码后即可在宿主页使用全部功能（回跳自动带入见交接清单 G1）。</p>
    <button class="btn wz-back" id="wzLoginBack">← 重选宿主</button>
    <div id="wzLoginErr" class="wz-err"></div>`
  body.querySelector('#wzLoginDd').onclick = () => {
    window.open(`${hubPanelBase}/#/login`, '_blank', 'noopener')
  }
  body.querySelector('#wzLoginBack').onclick = () => {
    void wfetch(base, 'POST', '/rqcard/link/reset', {}).then(() => window.location.reload())
  }
  body.querySelector('#wzLoginGo').onclick = async (event) => {
    const button = event.target
    button.disabled = true
    body.querySelector('#wzLoginErr').textContent = ''
    try {
      // 登录走代理白名单（/api/auth/login）：作用域先切到该宿主，令牌按连接隔离
      setConnectionScope(hubBase)
      const response = await fetch(`${base}/rqcard/proxy/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rqcard-call': '1' },
        body: JSON.stringify({
          username: body.querySelector('#wzLoginUser').value.trim(),
          password: body.querySelector('#wzLoginPass').value,
        }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.ok === false) throw new Error(payload?.error?.message ?? '登录失败')
      session.save(payload.data.token, payload.data.user)
      if (payload.data.refreshToken) session.saveRefresh(payload.data.refreshToken)
      rememberHub(hubBase)
      window.location.reload()
    } catch (error) {
      button.disabled = false
      body.querySelector('#wzLoginErr').textContent = error.message
    }
  }
}
