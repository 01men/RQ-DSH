/**
 * 连接器纳管：SaaS 连接器（open-connector 数据面网关）控制台页。
 * 页内分期（dev-plan-connector §2.9）：
 *   M1——网关设置 / 目录浏览（只读）/ 连接卡片墙 + 三形态向导 / 运行日志抽屉；
 *   M2——权限组管理（policies 编辑、subjects 绑定、模板安装二次确认、变更影响面提示）。
 * 桥接过渡：经 POST /api/mcp/import 纳入的 open-connector MCP 服务在 #/mcp 打「桥接」徽章。
 */
import { api } from '../api.js'
import { icon } from '../icons.js'
import {
  h, $, $$, esc, toast, openDrawer, openModal, confirmDialog,
  statusBadge, renderTable,
  fmtTime, emptyState, inputField, selectField, textareaField,
} from '../ui.js'

const RISK_BADGE = { read: 'success', write: 'warning', admin: 'danger' }
const AUTH_LABEL = { oauth: 'OAuth', api_key: 'API Key', custom_credential: '自定义凭证', no_auth: '免凭证' }

export async function renderConnectors(content, params, ctx) {
  let tab = params.get('tab') ?? 'catalog'

  content.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">连接器</div>
        <div class="page-desc">1,000+ SaaS Provider 的数据面纳管：目录 / 连接（OAuth · API Key · 免凭证）/ 双层授权（权限组 ↔ oct_ 令牌镜像）/ 计量对账。凭证托管在连接器网关侧，平台零密钥落盘。</div>
      </div>
      <div class="page-actions" id="cn-head-actions"></div>
    </div>
    <div class="filter-bar">
      <div class="chips" id="cn-tabs">
        ${[['catalog', '目录'], ['connections', '连接'], ['perm-groups', '权限组'], ['runs', '运行日志']]
          .map(([key, label]) => `<span class="chip ${tab === key ? 'active' : ''}" data-tab="${key}">${label}</span>`).join('')}
      </div>
    </div>
    <div id="cn-body"></div>`

  $('#cn-tabs').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-tab]')
    if (!chip) return
    tab = chip.dataset.tab
    $$('#cn-tabs .chip').forEach((node) => node.classList.toggle('active', node.dataset.tab === tab))
    void renderTab()
  })

  await refreshGateway()
  await renderTab()

  async function refreshGateway() {
    try {
      const gatewayStatus = await api.get('/api/connector/gateway')
      const available = gatewayStatus.available === true
      $('#cn-head-actions').innerHTML = `
        <span class="badge ${available ? 'badge-success' : 'badge-danger'}" title="${esc(gatewayStatus.reason ?? '')}">
          ${icon(available ? 'checkCircle' : 'alertTriangle', 12)} 网关${available ? `在线 ${gatewayStatus.latencyMs ?? 0}ms` : '不可用'}
        </span>
        <button class="btn btn-default" id="cn-gateway">${icon('settings', 14)}网关设置</button>`
    } catch {
      $('#cn-head-actions').innerHTML = `
        <span class="badge badge-warning">无 connector.gateway.write 权限点</span>`
      return
    }
    $('#cn-gateway').addEventListener('click', () => gatewayDrawer())
  }

  function gatewayDrawer() {
    void api.get('/api/connector/gateway').then((gatewayStatus) => {
      const probe = openDrawer({
        title: '连接器网关设置',
        width: 520,
        content: h('div', {}, `
          <div class="kv-list">
            <div class="kv"><span class="k">状态</span><span class="v">${gatewayStatus.available ? '可用' : esc(gatewayStatus.reason ?? '')}</span></div>
            <div class="kv"><span class="k">baseUrl</span><span class="v mono">${esc(gatewayStatus.baseUrl ?? '未配置')}</span></div>
            <div class="kv"><span class="k">上次探活</span><span class="v">${gatewayStatus.lastProbeAt ? fmtTime(gatewayStatus.lastProbeAt) : '—'}${gatewayStatus.latencyMs !== undefined ? `（${gatewayStatus.latencyMs}ms）` : ''}</span></div>
            <div class="kv"><span class="k">OOMOL_CONNECT_ENCRYPTION_KEY</span><span class="v">${gatewayStatus.envChecks?.OOMOL_CONNECT_ENCRYPTION_KEY ? '✅ 已设置（AES-256-GCM 生效）' : '❌ 缺失 → fail-closed'}</span></div>
            <div class="kv"><span class="k">OOMOL_CONNECT_ADMIN_TOKEN</span><span class="v">${gatewayStatus.envChecks?.OOMOL_CONNECT_ADMIN_TOKEN ? '✅ 已设置' : '⚠️ 未设置（需以字面量配置 adminToken）'}</span></div>
          </div>`),
        footer: [
          { label: '立即探活', onClick: async () => { const result = await api.post('/api/connector/gateway/health'); toast(result.ok ? `在线 ${result.latencyMs}ms` : String(result.reason), result.ok); await refreshGateway() } },
        ],
      })
      // 配置表单（env: 间接引用生产推荐）
      const formHost = h('div', { style: 'margin-top:16px;border-top:1px solid var(--border);padding-top:14px;display:flex;flex-direction:column;gap:10px' }, '')
      formHost.innerHTML = `
        ${inputField({ name: 'baseUrl', label: 'baseUrl', placeholder: 'http://open-connector:3000', value: gatewayStatus.baseUrl ?? '' })}
        ${inputField({ name: 'adminToken', label: '管理口令（推荐 env:OOMOL_CONNECT_ADMIN_TOKEN 间接引用）', placeholder: 'env:OOMOL_CONNECT_ADMIN_TOKEN', value: '' })}`
      probe.body.appendChild(formHost)
      const saveBtn = h('button', { class: 'btn btn-primary', style: 'margin-top:8px' }, '保存并探活')
      saveBtn.addEventListener('click', async () => {
        const payload = {}
        const base = formHost.querySelector('[name=baseUrl]').value.trim()
        if (!base) return toast('baseUrl 必填', false)
        payload.baseUrl = base
        const token = formHost.querySelector('[name=adminToken]').value.trim()
        if (token) payload.adminToken = token
        const saved = await api.put('/api/connector/gateway', payload)
        if (!saved.ok) return toast(saved.error?.message ?? '保存失败', false)
        toast('已保存并探活')
        probe.close()
        await refreshGateway()
      })
      probe.footer.appendChild(saveBtn)
    })
  }

  async function renderTab() {
    const body = $('#cn-body')
    body.innerHTML = ''
    if (tab === 'catalog') await renderCatalog(body)
    else if (tab === 'connections') await renderConnections(body)
    else if (tab === 'perm-groups') await renderPermGroups(body)
    else await renderRuns(body)
  }

  // -- 目录 -----------------------------------------------------------------
  async function renderCatalog(host) {
    host.innerHTML = `
      <div class="filter-bar">
        <div class="search-input">${icon('search')}<input class="input" id="cn-q" placeholder="搜索 provider / action"></div>
      </div>
      <div id="cn-catalog"></div>`
    const load = async () => {
      const q = $('#cn-q').value.trim()
      const catalog = await api.get('/api/connector/catalog' + api.qs(q ? { q } : {}))
      renderCatalogBody(catalog)
    }
    $('#cn-q').addEventListener('input', debounce(load, 300))
    await load()

    function renderCatalogBody(catalog) {
      const holder = $('#cn-catalog')
      holder.innerHTML = ''
      if (!catalog.providers?.length && !catalog.actions?.length) {
        holder.appendChild(emptyState({
          title: '目录尚未同步',
          desc: '在「网关设置」中指向 open-connector sidecar 并探活成功后，点击下方同步',
          actionText: '同步目录',
          onAction: syncCatalog,
        }))
        return
      }
      const sectionTitle = (text) => h('div', { class: 'section-title', style: 'margin:14px 0 8px;font-weight:600' }, text)
      holder.appendChild(sectionTitle(`Providers（${catalog.providers.length}）`))
      const grid = h('div', { class: 'grid grid-4', style: 'gap:10px' })
      for (const provider of catalog.providers.slice(0, 60)) {
        const card = h('div', { class: 'card card-hover', style: 'padding:12px;cursor:pointer' },
          h('div', { style: 'font-weight:600' }, String(provider.name ?? provider.service)),
          h('div', { class: 'muted', style: 'font-size:12px;margin-top:4px' }, `${provider.service}`))
        card.addEventListener('click', () => openProviderDrawer(provider, catalog))
        grid.appendChild(card)
      }
      holder.appendChild(grid)
      holder.appendChild(sectionTitle(`Actions（${catalog.actions.length}${catalog.actions.length >= 60 ? '+，输入关键词过滤' : ''}）`))
      const rows = catalog.actions.slice(0, 60).map((action) => ({
        id: action.id,
        service: action.service,
        riskLevel: `<span class="badge badge-${RISK_BADGE[action.riskLevel] ?? 'default'}">${action.riskLevel}</span>`,
        description: action.description ?? '',
        __raw: action,
      }))
      holder.appendChild(renderTable({
        columns: [
          { key: 'id', label: 'Action ID' },
          { key: 'service', label: 'Provider' },
          { key: 'riskLevel', label: '风险级', html: true },
          { key: 'description', label: '说明' },
        ],
        rows,
        onRowClick: (row) => openActionDrawer(row.__raw),
      }))
      if ((catalog.skippedServices ?? []).length > 0) {
        holder.appendChild(h('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' },
          `被拒纳管 service：${catalog.skippedServices.map((item) => item.service).join('、')}（计量资源正则约束）`))
      }
    }
  }

  function openProviderDrawer(provider, catalog) {
    const actions = catalog.actions.filter((action) => action.service === provider.service)
    openDrawer({
      title: `${provider.name ?? provider.service}`,
      width: 560,
      content: h('div', {}, `
        <div class="muted">${esc(String(provider.description ?? ''))}</div>
        <div class="section-title" style="margin-top:12px">Actions（${actions.length}）</div>
        ${actions.slice(0, 50).map((action) => `
          <div class="list-row" data-action="${esc(action.id)}" style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);cursor:pointer">
            <span class="mono" style="font-size:12px">${esc(action.id)}</span>
            <span class="badge badge-${RISK_BADGE[action.riskLevel] ?? 'default'}">${action.riskLevel}</span>
          </div>`).join('') || '<div class="muted">（无 action，或关键词过滤后为空）</div>'}
        <div id="pv-guide" class="muted" style="margin-top:12px;font-size:12px;white-space:pre-wrap"></div>`),
    }).body.addEventListener('click', (event) => {
      const row = event.target.closest('[data-action]')
      if (!row) return
      const action = actions.find((item) => item.id === row.dataset.action)
      if (action) openActionDrawer(action)
    })
  }

  async function openActionDrawer(action) {
    const drawer = openDrawer({
      title: action.id,
      width: 620,
      content: h('div', {}, `
        <span class="badge badge-${RISK_BADGE[action.riskLevel] ?? 'default'}">${action.riskLevel}</span>
        <div class="muted" style="margin-top:8px">${esc(action.description ?? '')}</div>
        ${(action.requiredScopes ?? []).length ? `<div class="kv" style="margin-top:10px"><span class="k">requiredScopes</span><span class="v mono">${esc(action.requiredScopes.join(', '))}</span></div>` : ''}
        <pre class="code-block" style="margin-top:10px;max-height:260px;overflow:auto;background:var(--bg-secondary);padding:10px;border-radius:8px;font-size:11px">${esc(JSON.stringify(action.inputSchema ?? {}, null, 2))}</pre>
        <div class="section-title" style="margin-top:12px">连接指南（agent.md 预览）</div>
        <div id="ad-guide" class="muted" style="white-space:pre-wrap;font-size:12px">加载中…</div>`),
    })
    try {
      const guide = await api.get(`/api/connector/catalog/actions/${encodeURIComponent(action.id)}/guide`)
      drawer.body.querySelector('#ad-guide').textContent = guide.guide ?? ''
    } catch {
      drawer.body.querySelector('#ad-guide').textContent = '（guide 获取失败：需要 connector.catalog.read）'
    }
  }

  async function syncCatalog() {
    const result = await api.post('/api/connector/catalog/sync')
    if (!result.ok) return toast(result.error?.message ?? '同步失败', false)
    toast(`providers=${result.providers} actions=${result.actions}`)
    await renderTab()
  }

  // -- 连接 -----------------------------------------------------------------
  async function renderConnections(host) {
    host.innerHTML = `<div id="cn-conns">加载中…</div>`
    const result = await api.get('/api/connector/connections')
    const holder = $('#cn-conns')
    holder.innerHTML = ''
    const headBar = h('div', { class: 'filter-bar', style: 'justify-content:flex-end' })
    const addBtn = h('button', { class: 'btn btn-primary' }, icon('plus', 14), '新建连接')
    addBtn.addEventListener('click', () => connectionWizard())
    headBar.appendChild(addBtn)
    holder.appendChild(headBar)
    if (!(result.connections ?? []).length) {
      holder.appendChild(emptyState({ title: '还没有连接引用', desc: '平台只保存 org:<orgId>: 别名引用与脱敏 profile，凭证全部留在连接器网关保险库' }))
      return
    }
    const grid = h('div', { class: 'grid grid-3', style: 'gap:12px' })
    for (const ref of result.connections) {
      const card = h('div', { class: 'card', style: 'padding:14px;display:flex;flex-direction:column;gap:6px' })
      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center">
          <strong>${esc(ref.provider)}</strong>
          <span class="badge badge-${ref.status === 'active' ? 'success' : ref.status === 'pending' ? 'warning' : 'danger'}">${ref.status}</span>
        </div>
        <div class="mono muted" style="font-size:12px">${esc(ref.alias)}</div>
        <div style="font-size:12px">${AUTH_LABEL[ref.authType] ?? ref.authType}${ref.bridge ? ' · <span class="badge">桥接过渡</span>' : ''}</div>
        ${ref.maskedProfile ? `<div class="mono muted" style="font-size:11px">${esc(Object.entries(ref.maskedProfile).map(([k, v]) => `${k}=${v}`).join(' · ').slice(0, 80))}</div>` : ''}`
      const delBtn = h('button', { class: 'btn btn-danger btn-sm', style: 'margin-top:auto' }, '删除')
      delBtn.addEventListener('click', async () => {
        const ok = await confirmDialog({ title: '删除连接', message: `确认删除 ${ref.alias}？若仍被权限组引用将拒绝（可先解绑）。`, danger: true })
        if (!ok) return
        const deleted = await api.del(`/api/connector/connections/${ref.id}`, {})
        toast(deleted.ok ? '已删除' : (deleted.error?.message ?? '删除失败'), deleted.ok)
        await renderTab()
      })
      card.appendChild(delBtn)
      grid.appendChild(card)
    }
    holder.appendChild(grid)
  }

  async function connectionWizard(providerHint) {
    let providers = []
    try {
      providers = (await api.get('/api/connector/catalog')).providers ?? []
    } catch { /* catalog.read 缺失时向导降级为手填 */ }
    const modal = openModal({
      title: '新建连接（三形态）',
      width: 540,
      content: (() => {
        const wrap = h('div', { style: 'display:flex;flex-direction:column;gap:10px' })
        wrap.innerHTML = `
          ${selectField({ name: 'provider', label: 'Provider', options: [{ value: '', label: providerHint ?? '（目录未同步时手动输入）' }] , value: providerHint ?? '' })}
          ${inputField({ name: 'serviceInput', label: '或直接填 service 标识', placeholder: 'hackernews / github …' })}
          ${selectField({ name: 'authType', label: '认证形态', options: [
            { value: 'no_auth', label: 'no_auth：免凭证虚拟登记' },
            { value: 'oauth', label: 'oauth：代理授权流（自备 App 见指南）' },
            { value: 'api_key', label: 'api_key / custom_credential：表单直达网关（不落盘）' },
          ] })}
          ${inputField({ name: 'aliasSuffix', label: '别名后缀（完整别名 = org:<orgId>:<后缀>）', placeholder: 'main', value: 'main' })}
          ${inputField({ name: 'orgId', label: '归属组织 ID', placeholder: 'org_xxx' })}
          <div id="cw-dynamic"></div>`
        return wrap
      })(),
      onSubmit: null,
    })
    const form = modal.body
    const dynamic = form.querySelector('#cw-dynamic')
    const renderDynamic = () => {
      const type = form.querySelector('[name=authType]').value
      if (type === 'api_key') {
        dynamic.innerHTML = textareaField({ name: 'valuesJson', label: '凭证字段（JSON；原样送入网关后即刻丢弃）', placeholder: '{"apiKey": "…"} 或 {"token": "…"}', value: '' })
      } else if (type === 'oauth') {
        dynamic.innerHTML = inputField({ name: 'requestedScopes', label: 'requestedScopes（逗号分隔，可空）', value: '' })
      } else {
        dynamic.innerHTML = '<div class="muted" style="font-size:12px">免凭证连接直接登记引用。</div>'
      }
    }
    renderDynamic()
    form.querySelector('[name=authType]').addEventListener('change', renderDynamic)
    const submitBtn = h('button', { class: 'btn btn-primary' }, '创建')
    submitBtn.addEventListener('click', async () => {
      const val = (name) => form.querySelector(`[name=${name}]`).value.trim()
      const providerName = val('provider') || val('serviceInput')
      if (!providerName || !val('aliasSuffix') || !val('orgId')) return toast('provider / 别名后缀 / 组织 ID 必填', false)
      const type = val('authType')
      let endpoint = `/api/connector/connections/${type === 'custom_credential' ? 'api-key' : type.replace('_key', '-key')}`
      endpoint = type === 'oauth' ? '/api/connector/connections/oauth' : type === 'no_auth' ? '/api/connector/connections/no-auth' : '/api/connector/connections/api-key'
      const payload = { provider: providerName, aliasSuffix: val('aliasSuffix'), orgId: val('orgId'), authType: type }
      if (type === 'api_key') {
        try { payload.values = JSON.parse(dynamic.querySelector('[name=valuesJson]').value || '{}') } catch { return toast('凭证字段必须是合法 JSON', false) }
        payload.authType = 'api_key'
      }
      if (type === 'oauth') {
        const scopes = dynamic.querySelector('[name=requestedScopes]').value.trim()
        if (scopes) payload.requestedScopes = scopes.split(',').map((item) => item.trim()).filter(Boolean)
      }
      const created = await api.post(endpoint, payload)
      if (created.approvalRequired) {
        toast(`已进入审批门禁：审批单 ${created.approvalId} 通过后再携 approvalId 提交`)
        modal.close()
        return
      }
      if (!created.ok) return toast(created.error?.message ?? '创建失败', false)
      if (type === 'oauth' && created.authorizationUrl) {
        window.open(created.authorizationUrl, '_blank', 'noopener')
        toast('已打开授权页；完成授权后回到本列表点刷新查看状态')
      } else {
        toast('连接已创建（凭证只存于连接器网关）')
      }
      modal.close()
      await renderTab()
    })
    modal.footer.appendChild(submitBtn)
  }

  // -- 权限组（M2 分期） -------------------------------------------------------
  async function renderPermGroups(host) {
    host.innerHTML = `<div id="cn-pgs">加载中…</div>`
    const result = await api.get('/api/connector/perm-groups')
    const holder = $('#cn-pgs')
    holder.innerHTML = ''
    const bar = h('div', { class: 'filter-bar', style: 'justify-content:flex-end' })
    const templateBtn = h('button', { class: 'btn btn-default' }, '安装只读模板')
    templateBtn.addEventListener('click', async () => {
      // 二次确认（评审 2.2-3）：模板同样建立权限组与令牌
      const ok = await confirmDialog({ title: '安装只读模板', message: '将创建「riskCap=read + readOnly」的 hackernews.* 模板权限组，并联动铸造 oct_ 运行时令牌。确认继续？' })
      if (!ok) return
      const rootOrgs = (await api.get('/api/iam/orgs')).data ?? []
      const rootOrg = Array.isArray(rootOrgs) ? rootOrgs.find((org) => !org.parentId) : undefined
      if (!rootOrg) return toast('组织数据未初始化', false)
      const createdTemplate = await api.post('/api/connector/perm-groups', {
        name: `只读模板-${Date.now().toString(36)}`,
        orgId: rootOrg.id,
        policies: { hackernews: { allowedActions: ['hackernews.*'], riskCap: 'read', constraints: { readOnly: true } } },
        subjects: [],
      })
      toast(createdTemplate.ok ? '模板已安装（可在列表编辑 subjects）' : (createdTemplate.error?.message ?? '安装失败'), createdTemplate.ok)
      await renderTab()
    })
    const createBtn = h('button', { class: 'btn btn-primary' }, icon('plus', 14), '新建权限组')
    createBtn.addEventListener('click', () => permGroupModal())
    bar.append(templateBtn, createBtn)
    holder.appendChild(bar)

    if (!(result.groups ?? []).length) {
      holder.appendChild(emptyState({ title: '还没有权限组', desc: '每权限组独立铸造一枚 oct_ 令牌；policies 决定 action pattern 与连接绑定，subjects 决定谁可调用' }))
      return
    }
    const rows = result.groups.map((group) => ({
      id: group.id,
      name: group.name,
      orgId: group.orgId,
      policiesSummary: Object.entries(group.policies).map(([service, policy]) =>
        `${service}:${policy.allowedActions === '*' ? '*' : (policy.allowedActions ?? []).join('|')}@${policy.riskCap}${policy.constraints?.readOnly ? '(ro)' : ''}`).join('<br>'),
      subjects: group.subjects.map((subject) => `${subject.type}:${subject.name ?? subject.id}`).join(', '),
      rateLimitPerMin: group.rateLimitPerMin,
      __raw: group,
    }))
    holder.appendChild(renderTable({
      columns: [
        { key: 'name', label: '名称' },
        { key: 'orgId', label: '组织' },
        { key: 'policiesSummary', label: '策略（pattern@riskCap）', html: true },
        { key: 'subjects', label: '主体' },
      ],
      rows,
      onRowClick: (row) => permGroupModal(row.__raw),
    }))
  }

  function permGroupModal(existing) {
    const isEdit = Boolean(existing)
    const impactLine = h('div', { class: 'muted', style: 'font-size:12px;margin-top:6px' }, isEdit ? '' : '变更影响面：保存前自动预览 N 个令牌 / M 个连接受影响。')
    const modal = openModal({
      title: isEdit ? `编辑权限组：${existing.name}` : '新建权限组',
      width: 620,
      content: (() => {
        const wrap = h('div', { style: 'display:flex;flex-direction:column;gap:10px' })
        wrap.innerHTML = `
          ${inputField({ name: 'name', label: '名称', value: existing?.name ?? '' })}
          ${inputField({ name: 'orgId', label: '组织 ID', value: existing?.orgId ?? '', disabled: isEdit ? 'disabled' : '' })}
          ${textareaField({ name: 'policiesJson', label: 'policies（JSON：{service:{allowedActions:[],riskCap,connections?,constraints?}}）', value: JSON.stringify(existing?.policies ?? { hackernews: { allowedActions: ['hackernews.get_top_stories'], riskCap: 'read', constraints: { readOnly: true } } }, null, 2), rows: 10 })}
          ${textareaField({ name: 'subjectsJson', label: 'subjects（JSON 数组）', value: JSON.stringify(existing?.subjects ?? [], null, 0), rows: 3 })}
          <div style="display:flex;gap:10px">
            ${inputField({ name: 'rateLimitPerMin', label: '限流（次/分/主体）', value: String(existing?.rateLimitPerMin ?? 60) })}
            ${inputField({ name: 'precheckCents', label: '计费预估（分）', value: String(existing?.precheckCents ?? 0) })}
          </div>
        `
        wrap.appendChild(impactLine)
        return wrap
      })(),
    })
    const saveBtn = h('button', { class: 'btn btn-primary' }, isEdit ? '保存（PUT 四数组全发镜像令牌）' : '创建并铸令牌')
    saveBtn.addEventListener('click', async () => {
      const val = (name) => formValue(modal.body, name)
      let policies
      let subjects
      try {
        policies = JSON.parse(val('policiesJson'))
        subjects = JSON.parse(val('subjectsJson'))
      } catch (error) {
        return toast(`JSON 解析失败：${error.message}`, false)
      }
      const basePayload = {
        name: val('name'),
        policies,
        subjects,
        rateLimitPerMin: Number(val('rateLimitPerMin')) || 60,
        precheckCents: Number(val('precheckCents')) || 0,
      }
      const target = isEdit ? `/api/connector/perm-groups/${existing.id}` : '/api/connector/perm-groups'
      const saved = isEdit ? await api.patch(target, basePayload) : await api.post(target, { ...basePayload, orgId: val('orgId') })
      if (!saved.ok) return toast(saved.error?.message ?? '保存失败', false)
      toast(isEdit ? '已保存：令牌策略将在一个巡检周期内收敛' : '已创建并铸发独立 oct_ 令牌')
      modal.close()
      await renderTab()
    })
    modal.footer.appendChild(saveBtn)
    // 编辑态：打开即拉取影响面预览（N 令牌 / M 连接）
    if (isEdit) {
      void api.post(`/api/connector/perm-groups/${existing.id}/impact`).then((impact) => {
        impactLine.textContent = `变更影响面：${impact.tokens} 个令牌 / ${impact.connections} 个连接 / ${impact.subjects} 个主体；在途调用会短暂失败后自动恢复`
      })
    }
  }

  // -- 运行日志 / 对账 ----------------------------------------------------------
  async function renderRuns(host) {
    host.innerHTML = `<div id="cn-runs">加载中…</div>`
    const holder = $('#cn-runs')
    const result = await api.get('/api/connector/runs').catch(() => ({ items: [], knownTokens: 0, error: true }))
    holder.innerHTML = ''
    const bar = h('div', { class: 'filter-bar', style: 'justify-content:flex-end' })
    const ledgerBtn = h('button', { class: 'btn btn-default' }, 'oct_ 台账')
    ledgerBtn.addEventListener('click', async () => {
      const ledgers = (await api.get('/api/connector/tokens')).tokens ?? []
      openDrawer({
        title: `oct_ 运行时令牌台账（${ledgers.length}）`,
        width: 520,
        content: h('div', {}, `
          <div class="muted" style="margin-bottom:8px;font-size:12px">平台只存 ocTokenId 与策略快照哈希；token 值仅铸造时一次性返回且仅驻进程内存，永不落盘。</div>
          ${renderTable({
            columns: [
              { key: 'ocTokenId', label: 'ocTokenId' },
              { key: 'hash', label: '快照哈希' },
              { key: 'lastSyncedAt', label: '最近镜像' },
            ],
            rows: ledgers.map((ledger) => ({ ...ledger, hash: ledger.policySnapshotHash })),
          })}`),
      })
    })
    const reconcileBtn = h('button', { class: 'btn btn-default' }, '运行对账')
    reconcileBtn.addEventListener('click', async () => {
      const outcome = await api.post('/api/connector/reconcile')
      if (!outcome.ok) return toast(outcome.error?.message ?? '对账失败', false)
      toast(`checked=${outcome.checkedRuns} matched=${outcome.matchedMeters} bypass=${outcome.bypassRuns.length}`, outcome.bypassRuns.length === 0)
      await renderTab()
    })
    bar.append(ledgerBtn, reconcileBtn)
    holder.appendChild(bar)

    if (!Array.isArray(result.items)) {
      holder.appendChild(emptyState({ title: 'runs 视图不可用', desc: '需要 connector.runs.read 权限点与健康的网关连接' }))
      return
    }
    holder.appendChild(renderTable({
      columns: [
        { key: 'id', label: 'runId (= executionId)' },
        { key: 'service', label: 'Provider' },
        { key: 'actionId', label: 'Action' },
        { key: 'ok', label: '结果', html: true },
        { key: 'runtimeTokenId', label: 'runtimeTokenId' },
        { key: 'startedAt', label: '时间' },
      ],
      rows: result.items.map((run) => ({ ...run, ok: run.ok ? '<span class="badge badge-success">ok</span>' : '<span class="badge badge-danger">fail</span>', startedAt: fmtTime(run.startedAt ?? '') })),
    }))
  }
}

function formValue(root, name) {
  const node = root.querySelector(`[name=${name}]`)
  return node ? (node.type === 'checkbox' ? String(node.checked) : node.value) : ''
}

function debounce(fn, ms) {
  let timer
  return (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}
