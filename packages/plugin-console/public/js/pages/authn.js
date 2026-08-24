/** 认证与令牌：机器凭证 + 令牌生命周期 + on-behalf-of 说明。 */
import { api, session } from '../api.js'
import { icon } from '../icons.js'
import {
  h, $, $$, esc, toast, openDrawer, openModal, confirmDialog,
  renderTable, statusBadge, collectForm, field, inputField, selectField,
  fmtTime, timeAgo, emptyState,
} from '../ui.js'

export async function renderAuthn(content, params, ctx) {
  const [principals, tokens] = await Promise.all([
    api.get('/api/authn/principals'),
    api.get('/api/authn/tokens'),
  ])

  content.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">统一认证中心</div>
        <div class="page-desc">人与机器双轨身份；令牌统一签发 / 校验 / 吊销，密钥 KMS 托管，支持轮换。</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-default" id="authn-rotate">${icon('refresh', 14)}轮换签名密钥</button>
        <button class="btn btn-primary" id="authn-credential">${icon('key', 14)}签发机器凭证</button>
      </div>
    </div>

    <div class="tabs">
      <div class="tab active" data-tab="principals">身份主体 (${principals.principals.length})</div>
      <div class="tab" data-tab="tokens">访问令牌 (${tokens.total})</div>
    </div>
    <div id="authn-body"></div>`

  const body = $('#authn-body')
  $$('.tab').forEach((el) => {
    el.onclick = () => {
      $$('.tab').forEach((t) => t.classList.remove('active'))
      el.classList.add('active')
      renderTab(el.dataset.tab)
    }
  })

  function renderTab(tab) {
    if (tab === 'principals') {
      const table = renderTable({
        columns: [
          {
            title: '主体', width: '26%',
            render: (p) => `
              <div class="flex" style="gap:10px">
                <div class="avatar sm" style="${p.type === 'machine' ? 'background:linear-gradient(135deg,#8b5cf6,#6d28d9)' : ''}">${icon(p.type === 'machine' ? 'settings' : 'user', 13)}</div>
                <div>
                  <div class="col-strong">${esc(p.name)}</div>
                  <div class="col-sub mono">${esc(p.id)}</div>
                </div>
              </div>`,
          },
          { title: '类型', width: 90, render: (p) => `<span class="badge ${p.type === 'human' ? 'badge-brand' : 'badge-purple'} no-dot">${p.type === 'human' ? '人员' : '机器'}</span>` },
          { title: '绑定资源', render: (p) => esc(refLabel(p)) },
          { title: 'ClientId', render: (p) => p.clientId ? `<span class="mono fs-12">${esc(p.clientId)}</span>` : '<span class="text-4">—</span>' },
          { title: '活跃令牌', width: 90, render: (p) => `<span class="col-num">${p.activeTokens}</span>` },
          { title: '状态', width: 90, render: (p) => statusBadge(p.status === 'active' ? 'active' : 'frozen', p.status === 'active' ? '正常' : '已禁用') },
        ],
        rows: principals.principals,
        onRowClick: (id, row) => openPrincipalDetail(row),
      })
      body.innerHTML = ''
      body.appendChild(table)
    } else {
      const table = renderTable({
        columns: [
          { title: '令牌', render: (t) => `<span class="mono fs-12">${esc(t.jti.slice(0, 18))}…</span><div class="col-sub">${esc(t.principalName)}</div>` },
          { title: '类型', width: 90, render: (t) => `<span class="badge ${t.kind === 'machine' ? 'badge-purple' : 'badge-brand'} no-dot">${t.kind === 'machine' ? '机器' : '访问'}</span>` },
          { title: '签发途径', render: (t) => `<span class="fs-12">${esc(t.issuedBy)}</span>` },
          { title: '签发时间', width: 140, render: (t) => `<span class="fs-12 text-3">${fmtTime(t.issuedAt)}</span>` },
          { title: '过期时间', width: 140, render: (t) => `<span class="fs-12 ${new Date(t.expiresAt) < new Date() ? '' : 'text-3'}">${fmtTime(t.expiresAt)}</span>` },
          {
            title: '状态', width: 110,
            render: (t) => t.revokedAt
              ? statusBadge('offline', '已吊销')
              : new Date(t.expiresAt) < new Date() ? statusBadge('deprecated', '已过期') : statusBadge('online', '生效中'),
          },
          {
            title: '', width: 80,
            render: (t) => !t.revokedAt ? `<button class="btn btn-danger-ghost btn-sm stop" data-revoke="${esc(t.jti)}">吊销</button>` : '',
          },
        ],
        rows: tokens.tokens,
        onRowClick: () => {},
      })
      body.innerHTML = ''
      body.appendChild(table)
      body.querySelectorAll('[data-revoke]').forEach((btn) => {
        btn.onclick = async () => {
          const result = await confirmDialog({
            title: '吊销令牌', requireReason: true, danger: true, confirmText: '立即吊销',
            message: '吊销后该令牌的所有请求立即返回 401。此操作不可恢复。',
          })
          if (!result) return
          await api.delete(`/api/authn/tokens/${btn.dataset.revoke}`, { reason: result.reason })
          toast('令牌已吊销'); ctx.rerender()
        }
      })
    }
  }
  renderTab('principals')

  $('#authn-credential').onclick = async () => {
    // 已注册的可绑定主体：选择后自动回填 refType/refId（凭据与资源真正关联），外部系统仍可手填
    let bindable
    try {
      bindable = await api.get('/api/authn/bindable-resources')
    } catch (error) { toast(error.message, 'error'); return }
    const entries = [
      ...bindable.agents.map((a) => ({ value: `agent:${a.id}`, refType: 'agent', refId: a.id, name: a.name, label: `Agent · ${a.name}（${a.status}）`, search: `${a.name} agent ${a.id}`.toLowerCase() })),
      ...bindable.apps.map((a) => ({ value: `app:${a.id}`, refType: 'app', refId: a.id, name: a.name, label: `AI 应用 · ${a.name}（${a.status}）`, search: `${a.name} app 应用 ${a.id}`.toLowerCase() })),
    ]
    const modal = openModal({
      title: '签发机器凭证（Client Credentials）', wide: true,
      body: `
        <div class="muted-box mb-14" style="display:flex;gap:8px">${icon('info', 15)}<span>用于 Agent / 应用 / 外部系统以机器身份接入平台。Secret 仅在创建后展示一次。</span></div>
        <div class="form-grid">
          ${field('绑定主体（可搜索已注册的 Agent / AI 应用）', `
            <input class="input" id="cred-bind-q" placeholder="输入关键词过滤，或直接下拉选择" autocomplete="off">
            <select class="select" id="cred-bind" style="margin-top:6px"></select>`, { required: true, full: true })}
          <div id="cred-name-holder" class="form-item full"></div>
          ${field('权限范围', selectField('scope', [
            { value: 'mcp.invoke', label: 'MCP 调用' },
            { value: 'skill.read', label: 'Skill 只读' },
            { value: '*', label: '全部权限（慎选）' },
          ]), { hint: '演示环境签发单个权限点；生产建议最小授权' })}
        </div>`,
      foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>签发</button>',
    })
    const bindSelect = modal.body.querySelector('#cred-bind')
    const nameHolder = modal.body.querySelector('#cred-name-holder')
    const renderOptions = (query) => {
      const q = (query ?? '').trim().toLowerCase()
      const visible = q ? entries.filter((e) => e.search.includes(q)) : entries
      const selected = bindSelect.value
      bindSelect.innerHTML =
        `<option value="external">外部系统（手动填写名称）</option>` +
        visible.map((e) => `<option value="${esc(e.value)}">${esc(e.label)}</option>`).join('')
      if (selected && [...bindSelect.options].some((o) => o.value === selected)) bindSelect.value = selected
      // 已选主体被过滤掉时，select 回落到外部系统——名称/关联区必须同步刷新，避免残留旧关联
      renderNameField()
    }
    const current = () => entries.find((e) => e.value === bindSelect.value)
    const renderNameField = () => {
      const entry = current()
      if (entry) {
        nameHolder.innerHTML = `
          <label class="form-label">自动关联</label>
          <div class="muted-box" style="display:flex;align-items:center;gap:8px">
            ${icon('link', 14)}
            <span>主体名称 <code class="mono">${esc(`${entry.refType}:${entry.name}`)}</code> · 关联 ${esc(entry.refType)} <code class="mono">${esc(entry.refId)}</code></span>
          </div>`
      } else {
        nameHolder.innerHTML = field('主体名称', inputField('name', { placeholder: '如 external:ci-system' }), { required: true })
      }
    }
    renderOptions('')
    modal.body.querySelector('#cred-bind-q').oninput = (event) => renderOptions(event.target.value)
    bindSelect.onchange = renderNameField
    modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
    modal.el.querySelector('[data-ok]').onclick = async () => {
      const data = collectForm(modal.body)
      const entry = current()
      const payload = entry
        ? { name: `${entry.refType}:${entry.name}`, refType: entry.refType, refId: entry.refId, scopes: [data.scope] }
        : { name: data.name, refType: 'external', scopes: [data.scope] }
      if (!payload.name) return toast('外部系统需填写主体名称', 'error')
      try {
        const result = await api.post('/api/authn/principals', payload)
        modal.close()
        openModal({
          title: '凭证已签发（仅此一次展示）',
          body: `
            <div class="form-hint" style="margin-bottom:10px;color:var(--danger)">请立即复制保存，关闭后无法再次查看 clientSecret。</div>
            <div class="code-block">principal_id: ${esc(result.principalId)}
client_id:     ${esc(result.clientId)}
client_secret: ${esc(result.clientSecret)}</div>
            <div class="form-hint mt-8">调用示例：POST /api/auth/client-credentials 获取访问令牌</div>`,
          foot: '<button class="btn btn-primary" data-ok>已保存</button>',
        })
      } catch (error) { toast(error.message, 'error') }
    }
  }

  $('#authn-rotate').onclick = async () => {
    const result = await confirmDialog({
      title: '轮换签名密钥', danger: true, confirmText: '确认轮换',
      message: '轮换后 <b>全部存量令牌立即失效</b>（宽限期机制生产环境可配）。确定继续？',
    })
    if (!result) return
    await api.post('/api/authn/rotate-secret')
    toast('签名密钥已轮换，存量令牌全部吊销')
    setTimeout(() => ctx.rerender(), 500)
  }

  async function openPrincipalDetail(principal) {
    const tokens2 = await api.get('/api/authn/tokens' + api.qs({ principalId: principal.id }))
    const drawer = openDrawer({
      title: principal.name,
      sub: `${principal.type === 'human' ? '人员身份' : '机器身份'} · ${principal.id}`,
      body: `
        <div class="desc-grid mb-14">
          <div class="desc-item"><span class="k">类型</span><span class="v">${principal.type === 'human' ? '人员' : '机器'}</span></div>
          <div class="desc-item"><span class="k">状态</span><span class="v">${principal.status === 'active' ? '正常' : '已禁用'}</span></div>
          ${principal.clientId ? `<div class="desc-item"><span class="k">ClientId</span><span class="v mono">${esc(principal.clientId)}</span></div>` : ''}
          <div class="desc-item"><span class="k">绑定资源</span><span class="v">${esc(refLabel(principal))}</span></div>
        </div>
        ${principal.scopes.length ? `
          <div class="card-title mb-8">权限范围（机器身份快照）</div>
          <div class="flex mb-14" style="flex-wrap:wrap;gap:6px">${principal.scopes.map((s) => `<span class="badge badge-brand no-dot mono">${esc(s)}</span>`).join('')}</div>` : ''}
        <div class="card-title mb-8">令牌（${tokens2.total}）</div>
        ${tokens2.tokens.slice(0, 8).map((t) => `
          <div class="flex" style="padding:8px 0;border-bottom:1px solid var(--border)">
            <span class="mono fs-12 grow">${esc(t.jti.slice(0, 22))}…</span>
            <span class="fs-11 text-3">${timeAgo(t.issuedAt)}</span>
            ${t.revokedAt ? statusBadge('offline', '已吊销') : statusBadge('online', '生效中')}
          </div>`).join('') || '<span class="text-4 fs-12">暂无令牌</span>'}`,
      foot: principal.status === 'active'
        ? `<button class="btn btn-danger-ghost" id="pri-disable">${icon('alert', 14)}禁用身份（吊销全部令牌）</button>`
        : '<button class="btn btn-primary" id="pri-enable">启用身份</button>',
    })
    const disableBtn = drawer.el.querySelector('#pri-disable')
    if (disableBtn) disableBtn.onclick = async () => {
      const result = await confirmDialog({ title: '禁用身份', requireReason: true, danger: true, message: `禁用 <b>${esc(principal.name)}</b> 后其全部令牌立即失效。` })
      if (!result) return
      await api.post(`/api/authn/principals/${principal.id}/disable`, { reason: result.reason })
      toast('身份已禁用'); drawer.close(); ctx.rerender()
    }
    const enableBtn = drawer.el.querySelector('#pri-enable')
    if (enableBtn) enableBtn.onclick = () => toast('启用身份请通过 API（演示入口收口）', 'info')
  }

  if (params.get('action') === 'credential') $('#authn-credential').click()
}

function refLabel(principal) {
  if (principal.type === 'human') return '平台账号'
  if (principal.refType === 'agent') return `Agent 本体（${principal.refId ?? '—'}）`
  if (principal.refType === 'app') return `AI 应用（${principal.refId ?? '—'}）`
  return '外部系统'
}
