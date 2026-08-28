/** Agent 本体：列表（卡片/表格双视图）+ 详情（概览/配置/权限/监控/审计/生命周期）。 */
import { api, session } from '../api.js'
import { icon } from '../icons.js'
import {
  h, $, $$, esc, toast, openDrawer, openModal, confirmDialog, copyText,
  renderTable, statusBadge, collectForm, field, inputField, selectField, textareaField,
  fmtNum, fmtPct, timeAgo, emptyState, sparkline, lineChart,
} from '../ui.js'

export async function renderAgents(content, params, ctx) {
  const data = await api.get('/api/agents')
  const agents = data.agents
  const schema = data.schema
  let view = 'card'

  content.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">Agent 本体管理</div>
        <div class="page-desc">注册即纳管：颁发唯一 ID 与机器身份凭证；上线走审批，下线联动吊销凭证并通知绑定用户。</div>
      </div>
      <div class="page-actions">
        <div class="segmented" id="agent-view">
          <span class="segmented-item active" data-v="card">${icon('app', 14)}卡片</span>
          <span class="segmented-item" data-v="table">${icon('scroll', 14)}表格</span>
        </div>
        <button class="btn btn-primary" id="agent-add">${icon('plus', 14)}注册 Agent</button>
      </div>
    </div>
    <div class="filter-bar">
      <div class="search-input">${icon('search')}<input class="input" id="agent-q" placeholder="搜索名称 / 标识"></div>
      <div class="chips" id="agent-status">
        <span class="chip active" data-s="">全部</span>
        <span class="chip" data-s="online">已上线</span>
        <span class="chip" data-s="trial">试运行</span>
        <span class="chip" data-s="draft">开发中</span>
        <span class="chip" data-s="offline">已下线</span>
      </div>
      <span class="fs-12 text-3" style="margin-left:auto" id="agent-count"></span>
    </div>
    <div id="agent-list"></div>`

  let filter = { q: '', status: '' }

  const refresh = () => {
    const list = agents.filter((a) => {
      if (filter.status && a.status !== filter.status) return false
      if (filter.q && !`${a.name}${a.slug}`.toLowerCase().includes(filter.q.toLowerCase())) return false
      return true
    })
    $('#agent-count').textContent = `共 ${list.length} 个 Agent`
    const holder = $('#agent-list')
    holder.innerHTML = ''
    if (!list.length) {
      holder.appendChild(emptyState({ title: '没有匹配的 Agent', desc: '调整筛选条件，或注册你的第一个 Agent', actionText: '注册 Agent', onAction: () => $('#agent-add').click(), icon: 'bot' }))
      return
    }
    if (view === 'card') {
      const grid = h('<div class="card-grid"></div>')
      for (const agent of list) {
        const card = h(`
          <div class="res-card" data-id="${esc(agent.id)}">
            <div class="res-card-top">
              <div class="res-icon" style="background:var(--purple-bg);font-size:22px">${esc(agent.attrs['avatar'] ?? '🤖')}</div>
              <div class="grow">
                <div class="res-name">${esc(agent.name)} ${statusBadge(agent.status)}</div>
                <div class="res-slug">${esc(agent.slug)}</div>
              </div>
            </div>
            <div class="res-desc">${esc(agent.attrs['description'] ?? '')}</div>
            <div class="flex" style="gap:6px;flex-wrap:wrap">
              <span class="badge badge-brand no-dot mono">${esc(agent.attrs['model'] ?? '—')}</span>
              ${Array.isArray(agent.attrs['skills']) && agent.attrs['skills'].length ? `<span class="badge badge-muted no-dot">${agent.attrs['skills'].length} 个 Skill</span>` : ''}
              ${agent.boundUserCount ? `<span class="badge badge-muted no-dot">${agent.boundUserCount} 绑定用户</span>` : ''}
            </div>
            <div class="res-foot">
              <span class="metric">${icon('activity', 13)}${fmtNum(agent.metrics.calls)} 调用</span>
              <span class="metric">${icon('check', 13)}${fmtPct(agent.metrics.successRate)}</span>
              <span style="margin-left:auto" class="text-4">${esc(agent.attrs['ownerName'] ?? '')}</span>
            </div>
          </div>`)
        card.onclick = () => openAgentDetail(agent.id, ctx)
        grid.appendChild(card)
      }
      holder.appendChild(grid)
    } else {
      const table = renderTable({
        columns: [
          {
            title: 'Agent', width: '24%',
            render: (a) => `<div class="flex" style="gap:10px"><span style="font-size:18px">${esc(a.attrs['avatar'] ?? '🤖')}</span><div><div class="col-strong">${esc(a.name)}</div><div class="col-sub mono">${esc(a.slug)}</div></div></div>`,
          },
          { title: '状态', width: 90, render: (a) => statusBadge(a.status) },
          { title: '模型', render: (a) => `<span class="mono fs-12">${esc(a.attrs['model'] ?? '—')}</span>` },
          { title: '负责人', render: (a) => esc(a.attrs['ownerName'] ?? '—') },
          { title: '调用', width: 90, render: (a) => `<span class="col-num">${fmtNum(a.metrics.calls)}</span>` },
          { title: '成功率', width: 90, render: (a) => `<span class="col-num">${fmtPct(a.metrics.successRate)}</span>` },
          { title: 'Token', width: 90, render: (a) => `<span class="col-num">${fmtNum(a.metrics.tokens)}</span>` },
          { title: '数据密级', width: 90, render: (a) => `<span class="fs-12">${dataClassLabel(a.attrs['dataClass'])}</span>` },
        ],
        rows: list,
        onRowClick: (id) => openAgentDetail(id, ctx),
      })
      holder.appendChild(table)
    }
  }

  $$('#agent-view .segmented-item').forEach((el) => {
    el.onclick = () => {
      $$('#agent-view .segmented-item').forEach((i) => i.classList.remove('active'))
      el.classList.add('active')
      view = el.dataset.v
      refresh()
    }
  })
  $('#agent-q').oninput = debounce(() => { filter.q = $('#agent-q').value.trim(); refresh() }, 250)
  $$('#agent-status .chip').forEach((chip) => {
    chip.onclick = () => {
      $$('#agent-status .chip').forEach((c) => c.classList.remove('active'))
      chip.classList.add('active')
      filter.status = chip.dataset.s
      refresh()
    }
  })
  $('#agent-add').onclick = () => openAgentCreate(schema, ctx)
  refresh()
  if (params.get('action') === 'create') openAgentCreate(schema, ctx)
  if (params.get('focus')) void openAgentDetail(params.get('focus'), ctx)
}

async function openAgentDetail(id, ctx) {
  const agent = await api.get(`/api/agents/${id}`)
  const drawer = openDrawer({
    title: `${agent.attrs['avatar'] ?? '🤖'} ${agent.name}`,
    sub: `${agent.slug} · ${agent.attrs['ownerName'] ?? ''} · ${agent.attrs['model'] ?? ''}`,
    wide: true,
    body: `
      <div class="flex mb-14" style="gap:8px;flex-wrap:wrap">
        ${statusBadge(agent.status)}
        <span class="badge ${riskClass(agent.attrs['riskLevel'])} no-dot">风险：${riskLabel(agent.attrs['riskLevel'])}</span>
        <span class="badge badge-info no-dot">密级：${dataClassLabel(agent.attrs['dataClass'])}</span>
        <span class="badge badge-muted no-dot">环境：${envLabel(agent.attrs['env'])}</span>
      </div>

      <div class="stat-grid mb-20" style="grid-template-columns:repeat(4,1fr)">
        ${miniStat('activity', '累计调用', fmtNum(agent.metrics.calls))}
        ${miniStat('check', '成功率', fmtPct(agent.metrics.successRate))}
        ${miniStat('coins', 'Token 消耗', fmtNum(agent.metrics.tokens))}
        ${miniStat('clock', '平均响应', agent.metrics.avgLatencyMs + 'ms')}
      </div>

      <div class="tabs" id="ag-tabs">
        <div class="tab active" data-tab="overview">概览</div>
        <div class="tab" data-tab="monitor">监控</div>
        <div class="tab" data-tab="access">权限与绑定</div>
        <div class="tab" data-tab="deps">依赖拓扑</div>
        <div class="tab" data-tab="audit">审计</div>
        <div class="tab" data-tab="lifecycle">生命周期</div>
      </div>
      <div id="ag-tab-body"></div>`,
    foot: footForStatus(agent, ctx),
  })

  const tabBody = drawer.body.querySelector('#ag-tab-body')
  const renderTab = (tab) => {
    if (tab === 'overview') {
      tabBody.innerHTML = `
        <div class="muted-box mb-14">${esc(agent.attrs['description'] ?? '')}</div>
        <div class="desc-grid">
          <div class="desc-item"><span class="k">Agent ID</span><span class="v mono">${esc(agent.id)}</span></div>
          <div class="desc-item"><span class="k">底层模型</span><span class="v">${esc(agent.attrs['model'] ?? '—')}</span></div>
          <div class="desc-item"><span class="k">提示词版本</span><span class="v mono">${esc(agent.attrs['systemPromptVersion'] ?? '未登记')}</span></div>
          <div class="desc-item"><span class="k">机器凭证</span><span class="v">${agent.credential ? `<span class="badge badge-ok no-dot">已颁发</span> <span class="mono fs-12">${esc(agent.credential.clientId)}</span>` : '<span class="text-4">未颁发</span>'}</span></div>
          <div class="desc-item"><span class="k">创建时间</span><span class="v">${timeAgo(agent.createdAt)}</span></div>
          <div class="desc-item"><span class="k">最近活跃</span><span class="v">${agent.metrics.lastActiveAt ? timeAgo(agent.metrics.lastActiveAt) : '—'}</span></div>
        </div>
        ${agent.credential ? `
          <div class="card-title mt-14 mb-8">凭证状态</div>
          <div class="desc-grid">
            <div class="desc-item"><span class="k">状态</span><span class="v">${agent.credential.status === 'active' ? '正常' : '已禁用'}</span></div>
            <div class="desc-item"><span class="k">活跃令牌</span><span class="v">${agent.credential.activeTokens} 个</span></div>
          </div>
          <div class="flex mt-14">
            <button class="btn btn-default btn-sm" id="ag-obo">${icon('fingerprint', 13)}签发 on-behalf-of 令牌</button>
          </div>` : ''}`
      const oboBtn = tabBody.querySelector('#ag-obo')
      if (oboBtn) oboBtn.onclick = async () => {
        try {
          const result = await api.post(`/api/agents/${agent.id}/obo-token`)
          const modal = openModal({
            title: '身份透传令牌（on-behalf-of）',
            body: `
              <div class="form-hint" style="margin-bottom:10px">该令牌携带完整 act 链：用户 → Agent。下游 MCP 可识别真实操作人，审计可还原完整链路。令牌仅本次完整展示，请立即复制保存。</div>
              <div class="code-block" style="white-space:pre-wrap;word-break:break-all">act 链: ${esc(result.actChain.map((a) => `${a.name}(${a.type})`).join(' → '))}

token:    ${esc(result.token)}</div>`,
            foot: `<button class="btn btn-default" id="obo-copy">${icon('copy', 13)}复制完整令牌</button><button class="btn btn-primary" data-ok>关闭</button>`,
          })
          modal.el.querySelector('#obo-copy').onclick = () => void copyText(result.token)
        } catch (error) { toast(error.message, 'error') }
      }
    }
    if (tab === 'monitor') {
      tabBody.innerHTML = `
        <div class="card card-pad mb-14">
          <div class="card-title mb-8">近 14 天调用量</div>
          ${lineChart([agent.metrics.series.map((s) => s.calls)], { width: 640, height: 150 })}
        </div>
        <div class="card card-pad">
          <div class="card-title mb-8">近 14 天 Token 消耗</div>
          ${barChartSafe(agent.metrics.series.map((s) => ({ label: s.date, value: s.tokens })), 640, 150)}
        </div>`
    }
    if (tab === 'access') {
      tabBody.innerHTML = `
        <div class="card-title mb-8">绑定用户（${agent.boundUsers.length}）<span class="fs-12 text-3" style="font-weight:400;margin-left:8px">记录"哪些用户可使用该 Agent"，使用即授权留痕</span></div>
        <div class="mb-14">
          ${agent.boundUsers.map((b) => `
            <div class="flex" style="padding:8px 0;border-bottom:1px solid var(--border)">
              <div class="avatar sm">${esc(b.userName.slice(0, 1))}</div>
              <span class="fs-13 grow">${esc(b.userName)}</span>
              <span class="fs-11 text-4">${timeAgo(b.boundAt)} 由 ${esc(b.boundBy)} 绑定</span>
              <button class="btn btn-ghost btn-sm stop" data-unbind="${esc(b.userId)}" style="color:var(--danger)">${icon('x', 12)}</button>
            </div>`).join('') || '<span class="text-4 fs-12">暂无绑定用户</span>'}
        </div>
        <button class="btn btn-default btn-sm" id="ag-bind">${icon('plus', 13)}绑定用户</button>`
      tabBody.querySelectorAll('[data-unbind]').forEach((btn) => {
        btn.onclick = async () => {
          await api.delete(`/api/agents/${agent.id}/bindings/${btn.dataset.unbind}`)
          toast('已解绑'); drawer.close(); void openAgentDetail(id, ctx)
        }
      })
      tabBody.querySelector('#ag-bind').onclick = async () => {
        const users = await api.get('/api/iam/users')
        const modal = openModal({
          title: '绑定用户',
          body: field('选择用户', selectField('userId', users.users.filter((u) => u.status === 'active').map((u) => ({ value: u.id, label: `${u.displayName}（${u.orgName}）` }))), { required: true }),
          foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>绑定</button>',
        })
        modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
        modal.el.querySelector('[data-ok]').onclick = async () => {
          try {
            await api.post(`/api/agents/${agent.id}/bindings`, { userId: collectForm(modal.body).userId })
            toast('绑定成功（授权已留痕）'); modal.close(); drawer.close(); void openAgentDetail(id, ctx)
          } catch (error) { toast(error.message, 'error') }
        }
      }
    }
    if (tab === 'deps') {
      const topo = agent.topology
      tabBody.innerHTML = `
        <div class="card card-pad">
          <div class="card-title mb-8">${icon('gitBranch', 14)} 依赖拓扑（Agent → Skill）</div>
          ${renderTopologyList(topo)}
          <div class="form-hint mt-8">异常节点标红；由资源依赖图实时计算</div>
        </div>
        ${agent.impact.length ? `
          <div class="card card-pad mt-14" style="border-color:var(--warn-border);background:var(--warn-bg)">
            <div class="card-title mb-8">${icon('alert', 14)} 影响面（若下线）</div>
            ${agent.impact.map((i) => `<div class="fs-13" style="padding:3px 0">· ${esc(i.name)}（${typeLabel(i.type)}）</div>`).join('')}
          </div>` : ''}`
    }
    if (tab === 'audit') {
      tabBody.innerHTML = agent.audit.length ? `
        <div class="timeline">
          ${agent.audit.slice(0, 12).map((log) => `
            <div class="timeline-item">
              <div class="timeline-dot"></div>
              <div class="timeline-title">${esc(log.action)} ${log.result !== 'ok' ? statusBadge(log.result === 'denied' ? 'denied' : 'error') : ''}</div>
              <div class="timeline-time">${timeAgo(log.createdAt)} · ${esc(log.actorName)}</div>
              ${log.detail ? `<div class="timeline-body">${esc(log.detail)}</div>` : ''}
            </div>`).join('')}
        </div>` : '<span class="text-4 fs-12">暂无审计记录</span>'
    }
    if (tab === 'lifecycle') {
      tabBody.innerHTML = `
        <div class="timeline">
          ${agent.lifecycleHistory.map((entry, index) => `
            <div class="timeline-item ${index === agent.lifecycleHistory.length - 1 ? 'current' : 'ok'}">
              <div class="timeline-dot"></div>
              <div class="timeline-title">${esc(entry.action === 'create' ? '注册创建' : actionLabel(entry.action))} → ${esc(stateLabel(entry.to))}</div>
              <div class="timeline-time">${timeAgo(entry.at)} · 操作人 ${esc(entry.actor)}</div>
              ${entry.note ? `<div class="timeline-body">${esc(entry.note)}</div>` : ''}
            </div>`).join('')}
        </div>
        <div class="muted-box mt-14" style="display:flex;gap:8px">
          ${icon('info', 15)}<span>状态机：开发 → 试运行（限定用户组）→ 上线 → 下线 → 归档。上线/下线为 L4 高危操作，强制审批。</span>
        </div>`
    }
  }
  drawer.body.querySelectorAll('#ag-tabs .tab').forEach((el) => {
    el.onclick = () => {
      drawer.body.querySelectorAll('#ag-tabs .tab').forEach((t) => t.classList.remove('active'))
      el.classList.add('active')
      renderTab(el.dataset.tab)
    }
  })
  renderTab('overview')

  // 生命周期操作按钮
  for (const transition of agent.availableTransitions) {
    const btn = drawer.el.querySelector(`[data-action="${transition.action}"]`)
    if (!btn) continue
    btn.onclick = async () => {
      if (transition.action === 'online' || transition.action === 'offline') {
        const isOnline = transition.action === 'online'
        const result = await confirmDialog({
          title: isOnline ? 'Agent 上线（L4）' : 'Agent 下线（L4）',
          requireReason: !isOnline,
          danger: !isOnline,
          confirmText: '提交审批',
          message: isOnline
            ? `上线 <b>${esc(agent.name)}</b> 将生成审批单，有审批权限的管理员通过后自动执行。`
            : `下线 <b>${esc(agent.name)}</b> 后：机器凭证立即吊销、${agent.boundUsers.length} 名绑定用户收到通知、审计数据保留。`,
        })
        if (!result) return
        try {
          const response = await api.post(`/api/agents/${agent.id}/transition`, {
            action: transition.action, note: result.reason ?? '上线申请',
          })
          toast('已创建审批单（审批通过后自动执行）')
          drawer.close(); ctx.rerender()
          void response
        } catch (error) { toast(error.message, 'error') }
      } else {
        try {
          if (transition.action === 'submit_trial') {
            const modal = openModal({
              title: '进入试运行',
              body: field('试运行用户组', inputField('groups', { value: '灰度试点组', placeholder: '用户组名称' }), { required: true, hint: '试运行期间仅该用户组成员可用' }),
              foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>确认</button>',
            })
            modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
            modal.el.querySelector('[data-ok]').onclick = async () => {
              const groupName = collectForm(modal.body).groups
              const groupsData = await api.get('/api/iam/groups')
              const group = groupsData.groups.find((g) => g.name === groupName)
              await api.patch(`/api/agents/${agent.id}`, { attrs: { trialGroups: group ? [group.name] : [groupName] } })
              await api.post(`/api/agents/${agent.id}/transition`, { action: 'submit_trial' })
              toast('已进入试运行'); modal.close(); drawer.close(); ctx.rerender()
            }
            return
          }
          await api.post(`/api/agents/${agent.id}/transition`, { action: transition.action })
          toast('状态已更新'); drawer.close(); ctx.rerender()
        } catch (error) { toast(error.message, 'error') }
      }
    }
  }

  const deleteBtn = drawer.el.querySelector('#ag-delete')
  if (deleteBtn) deleteBtn.onclick = async () => {
    const result = await confirmDialog({
      title: `删除 Agent · ${agent.name}`, requireReason: true, danger: true, confirmText: '确认删除',
      message: `将永久删除 <b>${esc(agent.name)}</b>：解绑全部绑定用户、吊销机器凭证、清理依赖关系，操作不可恢复；用量与审计数据保留。`,
    })
    if (!result) return
    try {
      await api.delete(`/api/agents/${agent.id}`)
      toast('已删除'); drawer.close(); ctx.rerender()
    } catch (error) { toast(error.message, 'error') }
  }
}

function footForStatus(agent, ctx) {
  const buttons = agent.availableTransitions.map((t) => {
    const isL4 = t.action === 'online' || t.action === 'offline'
    return `<button class="btn ${isL4 ? 'btn-primary' : 'btn-default'}" data-action="${esc(t.action)}">${icon(t.action === 'online' ? 'play' : t.action === 'offline' ? 'alert' : 'chevronRight', 14)}${esc(t.label)}</button>`
  }).join('')
  const deleteBtn = ['draft', 'archived'].includes(agent.status)
    ? `<button class="btn btn-danger-ghost" id="ag-delete">${icon('trash', 14)}删除</button>` : ''
  return buttons + deleteBtn || '<button class="btn btn-default" disabled>终态（已归档）</button>'
}

function openAgentCreate(schema, ctx) {
  const groupsByField = new Map()
  for (const fieldSpec of schema.fields) {
    if (!groupsByField.has(fieldSpec.group)) groupsByField.set(fieldSpec.group, [])
    groupsByField.get(fieldSpec.group).push(fieldSpec)
  }
  const groupLabels = Object.fromEntries(schema.groups.map((g) => [g.key, g.label]))
  const modal = openModal({
    title: '注册 Agent', wide: true,
    body: `
      <div class="form-hint" style="margin-bottom:12px">渐进式表单：必填最小集即可创建草稿，其余可后续补全（上线前完成登记即可）。</div>
      <div class="form-grid">
        ${field('Agent 名称', inputField('name', { placeholder: '如：智能客服助手' }), { required: true })}
        ${field('唯一标识', inputField('slug', { placeholder: '小写字母与中划线，留空自动生成' }))}
      </div>
      ${[...groupsByField.entries()].map(([group, fields]) => `
        <div class="card-title mb-8" style="margin-top:6px">${esc(groupLabels[group] ?? group)}</div>
        <div class="form-grid">
          ${fields.map((f) => renderSchemaField(f)).join('')}
        </div>`).join('')}
      <div class="muted-box mt-8" style="display:flex;gap:8px">${icon('key', 15)}<span>注册成功后自动颁发机器身份凭证（Client Credentials），密钥仅展示一次。</span></div>`,
    foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>注册并颁发凭证</button>',
  })
  modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
  modal.el.querySelector('[data-ok]').onclick = async () => {
    const data = collectForm(modal.body)
    const attrs = {}
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('attr_') && value !== '') attrs[key.slice(5)] = value
      if (key.startsWith('tags_') && value) attrs[key.slice(4)] = value.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
    }
    try {
      const result = await api.post('/api/agents', { name: data.name, slug: data.slug || undefined, attrs })
      modal.close()
      if (result.credential) {
        openModal({
          title: '注册成功 · 机器凭证（仅此一次展示）',
          body: `
            <div class="desc-grid mb-8">
              <div class="desc-item"><span class="k">Agent ID</span><span class="v mono">${esc(result.agent.id)}</span></div>
              <div class="desc-item"><span class="k">标识</span><span class="v mono">${esc(result.agent.slug)}</span></div>
            </div>
            <div class="code-block">client_id:     ${esc(result.credential.clientId)}
client_secret: ${esc(result.credential.clientSecret)}</div>
            <div class="form-hint mt-8">请妥善保管；当前状态「开发中」，补全治理属性后可提交试运行/上线。</div>`,
          foot: '<button class="btn btn-primary" data-ok>完成</button>',
        })
      } else {
        toast('注册成功')
      }
      ctx.rerender()
    } catch (error) { toast(error.message, 'error') }
  }

  function renderSchemaField(f) {
    const name = `attr_${f.key}`
    const tagsName = `tags_${f.key}`
    if (f.type === 'enum') {
      return field(f.label, selectField(name, (f.options ?? []).map((o) => ({ value: o.value, label: o.hint ? `${o.label}（${o.hint}）` : o.label })), { value: String(f.defaultValue ?? '') }), { required: f.required, hint: f.hint, full: false })
    }
    if (f.type === 'text') {
      return field(f.label, textareaField(name, { placeholder: f.placeholder, rows: 2 }), { required: f.required, hint: f.hint, full: true })
    }
    if (f.type === 'tags') {
      return field(f.label, inputField(tagsName, { placeholder: '逗号分隔' }), { hint: f.hint, full: false })
    }
    const input = inputField(name, { placeholder: f.placeholder, value: String(f.defaultValue ?? '') })
    return field(f.label, input, { required: f.required, hint: f.hint })
  }
}

// ---------- shared helpers ----------
export function dataClassLabel(cls) {
  return { public: '公开', internal: '内部', confidential: '机密', secret: '绝密' }[cls] ?? (cls ?? '—')
}
export function riskClass(level) {
  return { low: 'badge-ok', medium: 'badge-warn', high: 'badge-danger' }[level] ?? 'badge-muted'
}
export function riskLabel(level) {
  return { low: '低', medium: '中', high: '高' }[level] ?? (level ?? '—')
}
export function envLabel(env) {
  return { sandbox: '平台沙箱', shared: '共享运行时', dedicated: '独占实例' }[env] ?? (env ?? '—')
}
export function typeLabel(type) {
  return { agent: 'Agent', app: '应用', skill: 'Skill', mcp_service: 'MCP' }[type] ?? type
}
export function stateLabel(state) {
  return { draft: '开发中', trial: '试运行', online: '已上线', offline: '已下线', archived: '已归档' }[state] ?? state
}
export function actionLabel(action) {
  return { submit_trial: '进入试运行', online: '上线', offline: '下线', retrial: '恢复试运行', archive: '归档' }[action] ?? action
}
export function miniStat(ic, label, value) {
  return `
    <div style="background:var(--surface-2);border-radius:10px;padding:12px 14px">
      <div style="color:var(--brand-500)">${icon(ic, 16)}</div>
      <div style="font-size:16px;font-weight:700;margin-top:6px">${value}</div>
      <div class="stat-label">${esc(label)}</div>
    </div>`
}
export function renderTopologyList(node) {
  return `
    <div class="flex" style="padding:8px 0">
      <span class="badge ${node.status === 'online' || node.status === 'published' ? 'badge-ok' : node.status === 'unhealthy' ? 'badge-danger' : 'badge-muted'} no-dot">${typeLabel(node.type)}</span>
      <span class="fs-13" style="font-weight:500">${esc(node.name)}</span>
      <span class="fs-12 text-3">${esc(node.statusLabel)}</span>
    </div>
    ${node.children.map((child) => `<div style="margin-left:22px;border-left:2px solid var(--border);padding-left:14px">${renderTopologyList(child)}</div>`).join('')}`
}
export function barChartSafe(items, width, height) {
  // 简单柱状（内联，避免循环依赖 ui.js 的命名冲突）
  if (!items?.length) return '<div class="text-4 fs-12">暂无数据</div>'
  const max = Math.max(...items.map((i) => i.value), 1)
  const gap = 6
  const barW = Math.max(4, (width - gap * (items.length - 1)) / items.length)
  const bars = items.map((item, i) => {
    const barH = Math.max(2, (item.value / max) * (height - 30))
    return `<rect x="${i * (barW + gap)}" y="${height - 20 - barH}" width="${barW}" height="${barH}" rx="3" fill="#8b5cf6" opacity="${0.5 + 0.5 * (item.value / max)}"><title>${esc(item.label)}: ${item.value}</title></rect>`
  }).join('')
  return `<svg width="100%" viewBox="0 0 ${width} ${height}">${bars}</svg>`
}
function debounce(fn, ms) {
  let timer
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms) }
}
