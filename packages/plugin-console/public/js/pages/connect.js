/** 平台接入：远程 dsh 运行时（插件市场安装）凭证申请管理 —— 接入码 / 已接入客户端。 */
import { api, session } from '../api.js'
import { icon } from '../icons.js'
import {
  h, $, $$, esc, toast, openModal, confirmDialog,
  renderTable, statusBadge, collectForm, field, inputField, selectField, fmtTime, timeAgo,
} from '../ui.js'

const TEMPLATE_LABEL = { readonly: '只读运维', operator: '运维（读+变更）', full: '全部权限' }

export async function renderConnect(content, params) {
  const [codes, clients, principals, oidcClients] = await Promise.all([
    api.get('/api/connect/codes'),
    api.get('/api/connect/clients'),
    api.get('/api/authn/principals').catch(() => null),
    api.get('/api/authn/oidc/clients').catch(() => null),
  ])
  const hasOverview = principals !== null || oidcClients !== null

  content.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">平台接入</div>
        <div class="page-desc">其他电脑的 dsh 经插件市场安装本平台后，凭一次性接入码向宿主申请机器凭证；工具调用全部转发宿主执行（按模板收敛权限、全程审计）。</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-primary" id="connect-code-create">${icon('plus', 14)}创建接入码</button>
      </div>
    </div>

    <div class="card mb-20">
      <div class="card-head"><span class="card-title">${icon('fingerprint', 15)} 远程 dsh 一键接入（三步）</span></div>
      <div class="card-body fs-13" style="line-height:2">
        <div><b>1. 安装插件</b>（远程电脑执行）：<code class="mono">dsh plugin --profile web add github:01men/ybkk-AIOS</code></div>
        <div><b>2. 申请口令</b>（任选其一）：
          ① 在 dsh 界面对 Agent 说「<span class="mono">接入宿主 &lt;本机局域网地址&gt;，接入码 &lt;下方创建的码&gt;</span>」，Agent 调 <span class="mono">connect_setup</span> 自动完成；
          ② 浏览器打开远程电脑的 <span class="mono">http://127.0.0.1:7390</span> 配置页可视化填写（可随时更新/断开）</div>
        <div><b>3. 验证</b>：远程 Agent 执行 <span class="mono">connect_status</span> / <span class="mono">agent_list</span>，工具已转发宿主执行并在下方「已接入客户端」出现记录。</div>
      </div>
    </div>

    <div class="tabs">
      ${hasOverview ? '<div class="tab" data-tab="overview">外部接入总览</div>' : ''}
      <div class="tab ${hasOverview ? '' : 'active'}" data-tab="codes">接入码 (${codes.codes.length})</div>
      <div class="tab" data-tab="clients">已接入客户端 (${clients.clients.length})</div>
    </div>
    <div id="connect-body"></div>`

  $('#connect-code-create').onclick = openCreateCode

  const body = $('#connect-body')
  $$('.tab').forEach((el) => {
    el.onclick = () => {
      $$('.tab').forEach((t) => t.classList.remove('active'))
      el.classList.add('active')
      renderTab(el.dataset.tab)
    }
  })

  function renderTab(tab) {
    if (tab === 'overview') renderOverview()
    else if (tab === 'codes') renderCodes()
    else renderClients()
  }

  /** 外部接入总览：机器凭证 + OIDC 客户端 + 远程 dsh 一处盘点，跳转对应管理页。 */
  function renderOverview() {
    const machines = (principals?.principals ?? []).filter((p) => p.type === 'machine')
    const byRef = (type) => machines.filter((p) => p.refType === type)
    const oidc = oidcClients?.clients ?? []
    const oidcActive = oidc.filter((c) => c.status === 'active')
    const refCard = (title, list, jump, icon2) => `
      <div class="card card-pad" style="flex:1;min-width:280px">
        <div class="flex-between mb-8">
          <div class="card-title">${icon(icon2, 14)} ${title}（${list.length}）</div>
          <button class="btn btn-ghost btn-sm" data-jump="${esc(jump)}">前往管理 ${icon('chevronRight', 12)}</button>
        </div>
        ${list.slice(0, 6).map((item) => `
          <div class="flex" style="padding:6px 0;border-bottom:1px solid var(--border);gap:8px">
            <span class="fs-12 grow ellipsis">${esc(item.name)}</span>
            <span class="fs-11 text-4 mono">${esc(item.id)}</span>
            ${statusBadge(item.status === 'active' ? 'active' : 'frozen', item.status === 'active' ? '正常' : '禁用')}
          </div>`).join('') || '<div class="text-4 fs-12" style="padding:6px 0">暂无</div>'}
        ${list.length > 6 ? `<div class="fs-12 text-4 mt-8">… 共 ${list.length} 项</div>` : ''}
      </div>`
    body.innerHTML = `
      <div class="muted-box mb-14" style="display:flex;gap:8px">${icon('info', 15)}<span>三类「外部接入身份」一处盘点：<b>机器凭证</b>（API 调用方，按绑定资源分组）、<b>OIDC 客户端</b>（应用 SSO 登录接入）、<b>远程 dsh</b>（接入码换牌的工具代理客户端）。</span></div>
      <div class="stat-grid mb-14" style="grid-template-columns:repeat(4,1fr)">
        <div class="card card-pad"><div class="fs-12 text-3">机器凭证（Agent 绑定）</div><div class="col-num" style="font-size:24px;font-weight:700">${byRef('agent').length}</div></div>
        <div class="card card-pad"><div class="fs-12 text-3">机器凭证（应用/外部）</div><div class="col-num" style="font-size:24px;font-weight:700">${byRef('app').length + byRef('external').length + machines.filter((p) => !p.refType).length}</div></div>
        <div class="card card-pad"><div class="fs-12 text-3">OIDC 客户端（活跃）</div><div class="col-num" style="font-size:24px;font-weight:700">${oidcActive.length}/${oidc.length}</div></div>
        <div class="card card-pad"><div class="fs-12 text-3">远程 dsh 客户端</div><div class="col-num" style="font-size:24px;font-weight:700">${clients.clients.filter((c) => c.status === 'active').length}</div></div>
      </div>
      <div class="flex mb-14" style="gap:14px;flex-wrap:wrap;align-items:stretch">
        ${refCard('机器凭证 · 绑定 Agent', byRef('agent'), '#/authn', 'bot')}
        ${refCard('机器凭证 · 应用 / 外部系统', [...byRef('app'), ...byRef('external'), ...machines.filter((p) => !p.refType)], '#/authn', 'key')}
      </div>
      <div class="flex mb-14" style="gap:14px;flex-wrap:wrap;align-items:stretch">
        <div class="card card-pad" style="flex:1;min-width:280px">
          <div class="flex-between mb-8">
            <div class="card-title">${icon('plug', 14)} OIDC 客户端（应用 SSO / 外部登记，${oidc.length}）</div>
            <button class="btn btn-ghost btn-sm" data-jump="#/authn">前往管理 ${icon('chevronRight', 12)}</button>
          </div>
          ${oidc.slice(0, 6).map((c) => `
            <div class="flex" style="padding:6px 0;border-bottom:1px solid var(--border);gap:8px">
              <span class="fs-12 grow ellipsis">${esc(c.name)}${c.refAppName ? ` <span class="text-4">· ${esc(c.refAppName)}</span>` : ''}</span>
              <span class="badge ${c.clientType === 'public' ? 'badge-purple' : 'badge-info'} no-dot">${c.clientType === 'public' ? 'public' : 'confidential'}</span>
              ${statusBadge(c.status === 'active' ? 'active' : 'frozen', c.status === 'active' ? '使用中' : '已禁用')}
            </div>`).join('') || '<div class="text-4 fs-12" style="padding:6px 0">暂无；在「AI 应用 → SSO 配置」或「认证与令牌 → OIDC 客户端」登记</div>'}
          ${oidc.length > 6 ? `<div class="fs-12 text-4 mt-8">… 共 ${oidc.length} 项</div>` : ''}
        </div>
        ${refCard('远程 dsh 已接入客户端', clients.clients, '#/connect?tab=clients', 'terminal')}
      </div>`
    body.querySelectorAll('[data-jump]').forEach((btn) => {
      btn.onclick = () => { location.hash = btn.dataset.jump }
    })
  }

  function codeStatus(record) {
    if (record.status === 'revoked') return statusBadge('offline', '已作废')
    if (record.status === 'used') return statusBadge('archived', '已使用')
    if (record.status === 'expired') return statusBadge('offline', '已过期')
    return statusBadge('active', '待使用')
  }

  function renderCodes() {
    const table = renderTable({
      columns: [
        { title: '接入码', width: '22%', render: (c) => `<span class="mono fs-12">${esc(c.codeMask)}</span><div class="col-sub fs-11">仅创建时展示一次</div>` },
        { title: '权限模板', width: 130, render: (c) => `<span class="badge ${c.template === 'full' ? 'badge-warn' : 'badge-info'} no-dot">${esc(TEMPLATE_LABEL[c.template] ?? c.template)}</span>` },
        { title: '有效期至', width: 150, render: (c) => `<span class="fs-12 text-3">${fmtTime(c.expiresAt)}</span>` },
        { title: '状态', width: 100, render: codeStatus },
        { title: '使用方', render: (c) => c.usedBy ? `<span class="fs-12">${esc(c.usedBy)}</span>` : '<span class="text-4">—</span>' },
        { title: '备注/创建', render: (c) => `<span class="fs-12">${esc(c.remark || '—')}</span><div class="col-sub fs-11">${esc(c.createdBy)} · ${timeAgo(c.createdAt)}</div>` },
        {
          title: '', width: 70,
          render: (c) => c.status === 'active'
            ? `<button class="btn btn-default btn-sm" data-revoke="${esc(c.id)}">${icon('x', 12)}作废</button>`
            : '',
        },
      ],
      rows: codes.codes,
      onRowClick: () => {},
      empty: '暂无接入码；点击右上角「创建接入码」开始远程接入',
    })
    body.innerHTML = ''
    body.appendChild(table)
    $$('[data-revoke]').forEach((btn) => {
      btn.onclick = async (event) => {
        event.stopPropagation()
        const result = await confirmDialog({ title: '作废接入码', message: '作废后该码立即失效，未接入的远程电脑将无法使用它申请凭证。', danger: true, confirmText: '作废' })
        if (!result) return
        try {
          await api.delete(`/api/connect/codes/${btn.dataset.revoke}`)
          toast('接入码已作废')
          renderConnect(content)
        } catch (error) { toast(error.message, 'error') }
      }
    })
  }

  function renderClients() {
    const table = renderTable({
      columns: [
        {
          title: '客户端', width: '24%',
          render: (c) => `
            <div class="flex" style="gap:10px">
              <div class="avatar sm" style="background:linear-gradient(135deg,#0ea5e9,#2563eb)">${icon('terminal', 13)}</div>
              <div>
                <div class="col-strong">${esc(c.name)}</div>
                <div class="col-sub mono fs-11">${esc(c.clientId)}</div>
              </div>
            </div>`,
        },
        { title: '权限模板', width: 130, render: (c) => `<span class="badge ${c.template === 'full' ? 'badge-warn' : 'badge-info'} no-dot">${esc(TEMPLATE_LABEL[c.template] ?? (c.template || '手工凭证'))}</span>` },
        { title: '来源主机', render: (c) => `<span class="mono fs-12">${esc(c.hostname || '—')}</span><div class="col-sub fs-11">${esc(c.platform || '')}</div>` },
        { title: '接入时间', width: 150, render: (c) => `<span class="fs-12 text-3">${fmtTime(c.enrolledAt)}</span>` },
        { title: '最近使用', width: 120, render: (c) => `<span class="fs-12 ${c.lastUsedAt ? '' : 'text-4'}">${c.lastUsedAt ? timeAgo(c.lastUsedAt) : '未调用'}</span>` },
        { title: '最近心跳', width: 120, render: (c) => `<span class="fs-12 ${c.lastHeartbeatAt ? '' : 'text-4'}">${c.lastHeartbeatAt ? timeAgo(c.lastHeartbeatAt) : '未上报'}</span>${c.heartbeat?.tools !== undefined ? `<div class="col-sub fs-11">工具 ${c.heartbeat.tools}${c.heartbeat?.uptimeSec !== undefined ? ` · 运行 ${Math.floor(c.heartbeat.uptimeSec / 60)}min` : ''}</div>` : ''}` },
        { title: '状态', width: 100, render: (c) => statusBadge(c.status === 'active' ? 'active' : 'frozen', c.status === 'active' ? '正常' : '已禁用') },
        {
          title: '', width: 90,
          render: (c) => c.status === 'active'
            ? `<button class="btn btn-default btn-sm" data-disable="${esc(c.id)}" data-name="${esc(c.name)}">${icon('x', 12)}禁用</button>`
            : `<button class="btn btn-default btn-sm" data-enable="${esc(c.id)}">${icon('check', 12)}恢复</button>`,
        },
      ],
      rows: clients.clients,
      onRowClick: (id, row) => openClientDetail(row),
      empty: '暂无已接入客户端；远程电脑完成接入后会出现在这里',
    })
    body.innerHTML = ''
    body.appendChild(table)
    $$('[data-disable]').forEach((btn) => {
      btn.onclick = async (event) => {
        event.stopPropagation()
        const result = await confirmDialog({
          title: `禁用客户端「${btn.dataset.name}」`,
          message: '将联动吊销其全部机器令牌，远程工具调用立即失效。',
          requireReason: true, danger: true, confirmText: '禁用',
        })
        if (!result) return
        try {
          await api.post(`/api/connect/clients/${btn.dataset.disable}/disable`, { reason: result.reason ?? '' })
          toast('客户端已禁用，令牌已联动吊销')
          renderConnect(content)
        } catch (error) { toast(error.message, 'error') }
      }
    })
    $$('[data-enable]').forEach((btn) => {
      btn.onclick = async (event) => {
        event.stopPropagation()
        try {
          await api.post(`/api/connect/clients/${btn.dataset.enable}/enable`, {})
          toast('客户端已恢复')
          renderConnect(content)
        } catch (error) { toast(error.message, 'error') }
      }
    })
  }

  function openClientDetail(client) {
    const scopeText = client.scopes.length > 12 ? `${client.scopes.slice(0, 12).join('、')} 等 ${client.scopes.length} 项` : client.scopes.join('、')
    openModal({
      title: `接入客户端：${client.name}`,
      body: h(`
        <div class="kv-list fs-13" style="line-height:2.2">
          <div><span class="text-4">ClientId：</span><span class="mono">${esc(client.clientId)}</span></div>
          <div><span class="text-4">权限模板：</span>${esc(TEMPLATE_LABEL[client.template] ?? (client.template || '手工凭证'))}（${client.scopes.includes('*') ? '全部权限' : `${client.scopes.length} 个权限点`}）</div>
          <div><span class="text-4">生效权限：</span><span class="fs-12">${esc(scopeText)}</span></div>
          <div><span class="text-4">来源主机：</span><span class="mono">${esc(client.hostname || '—')}</span>（${esc(client.platform || '未知平台')}）</div>
          <div><span class="text-4">接入时间：</span>${fmtTime(client.enrolledAt)}</div>
          <div><span class="text-4">最近使用：</span>${client.lastUsedAt ? timeAgo(client.lastUsedAt) : '未调用'} · 活跃令牌 ${client.activeTokens} 个</div>
          <div><span class="text-4">最近心跳：</span>${client.lastHeartbeatAt ? timeAgo(client.lastHeartbeatAt) : '未上报'}${client.heartbeat?.tools !== undefined ? ` · 工具 ${client.heartbeat.tools} 个` : ''}${client.heartbeat?.version ? ` · ${esc(client.heartbeat.version)}` : ''}${client.heartbeat?.uptimeSec !== undefined ? ` · 在线 ${Math.floor(client.heartbeat.uptimeSec / 60)} 分钟` : ''}</div>
        </div>`),
      foot: '<button class="btn btn-default" data-cancel>关闭</button>',
    })
  }

  function openCreateCode() {
    const templates = clients.templates ?? []
    const modal = openModal({
      title: '创建接入码（一次性）',
      body: h(`
        <form id="connect-code-form">
          ${field('权限模板', selectField('template', templates.map((t) => ({ value: t.name, label: `${t.label} —— ${t.description}` })), { value: 'readonly' }), { hint: '接入后远程客户端的权限边界，等价于为其签发的口令权限' })}
          ${field('有效分钟数', inputField('ttlMinutes', { value: '15' }), { hint: '超时未使用自动过期（1-1440）' })}
          ${field('用途备注', inputField('remark', { placeholder: '如：研发部小王的办公电脑 dsh' }), { hint: '便于审计与识别使用方' })}
        </form>`),
      // foot 传字符串：openModal 走 innerHTML，可含多个按钮（h() 只取 firstElementChild 会丢按钮）
      foot: `
        <button class="btn btn-default" data-cancel>取消</button>
        <button class="btn btn-primary" id="connect-code-submit">创建并展示接入码</button>`,
    })
    modal.el.querySelector('#connect-code-submit').onclick = async () => {
      const values = collectForm(modal.el.querySelector('#connect-code-form'))
      try {
        const created = await api.post('/api/connect/codes', {
          template: values.template,
          ttlMinutes: Number(values.ttlMinutes) || 15,
          remark: values.remark ?? '',
        })
        modal.close()
        showOneTimeCode(created)
      } catch (error) { toast(error.message, 'error') }
    }
  }

  function showOneTimeCode(created) {
    const modal = openModal({
      title: '接入码已创建（仅展示这一次）',
      // body 传字符串：含多个顶层元素（h() 只取 firstElementChild 会丢内容）
      body: `
        <div class="fs-13 text-4 mb-8">请立即复制并发送给远程电脑的使用者（有效至 ${fmtTime(created.expiresAt)}）：</div>
        <div class="flex" style="gap:8px;align-items:center">
          <code class="mono" id="connect-one-time-code" style="flex:1;padding:12px;border-radius:8px;background:var(--bg-2);font-size:14px;word-break:break-all">${esc(created.code)}</code>
          <button class="btn btn-default" id="connect-copy-code">${icon('check', 12)}复制</button>
        </div>
        <div class="fs-12 mt-12" style="line-height:1.9">
          远程电脑安装插件后，在 dsh 界面对 Agent 说：<br>
          <span class="mono">「接入宿主平台，地址 &lt;本机局域网地址:端口&gt;，接入码 &lt;上面的码&gt;」</span><br>
          Agent 将执行 <span class="mono">connect_setup</span> 自动申请口令；也可打开远程电脑的 <span class="mono">http://127.0.0.1:7390</span> 配置页填写。
        </div>`,
      foot: '<button class="btn btn-primary" data-cancel>我已保存</button>',
    })
    modal.el.querySelector('#connect-copy-code').onclick = async () => {
      try {
        await navigator.clipboard.writeText(created.code)
        toast('已复制到剪贴板')
      } catch {
        const range = document.createRange()
        range.selectNode(modal.el.querySelector('#connect-one-time-code'))
        getSelection().removeAllRanges()
        getSelection().addRange(range)
        toast('已全选，请按 Ctrl+C 复制', 'info')
      }
    }
    renderConnect(content, params)
  }

  const initialTab = params?.get('tab') === 'clients' ? 'clients' : params?.get('tab') === 'codes' ? 'codes' : (hasOverview ? 'overview' : 'codes')
  $$('.tab').forEach((el) => { if (el.dataset.tab === initialTab) el.classList.add('active'); else el.classList.remove('active') })
  renderTab(initialTab)
}
