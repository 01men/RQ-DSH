/** MCP 服务：卡片墙 + 详情抽屉（监控图表/工具/版本/权限组）+ 部署向导。 */
import { api, session } from '../api.js'
import { icon } from '../icons.js'
import {
  h, $, $$, esc, toast, openDrawer, openModal, confirmDialog,
  statusBadge, renderTable, collectForm, field, inputField, selectField, textareaField,
  fmtNum, fmtPct, timeAgo, emptyState, sparkline, barChart, lineChart, maybeShowConceptCard,
  multiSelectField, mountSearchableSelects,
} from '../ui.js'

const ICON_COLORS = { kb: ['#eef2ff', '#4f6ef7'], chart: ['#ecfdf5', '#10b981'], ticket: ['#fff7ed', '#f97316'], hr: ['#f5f3ff', '#8b5cf6'], fx: ['#fef2f2', '#ef4444'], mcp: ['#eff6ff', '#3b82f6'] }

export async function renderMcp(content, params, ctx) {
  const data = await api.get('/api/mcp/services')
  const services = data.services

  // 首次访问概念卡（易用性整改：MCP 术语对业务成员有门槛）
  maybeShowConceptCard(content, 'mcp', {
    icon: 'plug',
    title: 'MCP 是什么？',
    subtitle: 'MCP = Agent 连接外部工具与数据的标准接口，可以理解为「万能插头」。',
    points: [
      '供给侧：把知识库、工单、图表等能力以统一规格提供给 Agent 调用。',
      '供给链路：注册登记 → 安全审核 → 测试验证 → 灰度发布 → 运行监控。',
      '平台托管：网关统一鉴权、限流熔断，调用全程计量计费。',
    ],
  })

  content.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">MCP 部署服务</div>
        <div class="page-desc">工具的供给链路：注册登记 → 安全审核 → 测试验证 → 灰度发布 → 运行监控。网关统一鉴权、限流熔断。</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-default" id="mcp-permgroups">${icon('shield', 14)}权限组管理</button>
        <button class="btn btn-primary" id="mcp-deploy-wizard">${icon('plus', 14)}接入 MCP 服务</button>
      </div>
    </div>

    <div class="stat-grid mb-20">
      ${miniStat('server', '服务总数', services.length)}
      ${miniStat('wifi', '在线 / 灰度', services.filter((s) => ['online', 'gray'].includes(s.status)).length)}
      ${miniStat('activity', '累计调用', fmtNum(data.overview.totalCalls))}
      ${miniStat('zap', '成功率', fmtPct(data.overview.successRate))}
      ${miniStat('clock', 'P95 延迟', data.overview.p95Latency + 'ms')}
    </div>

    <div class="card-grid" id="mcp-cards"></div>`

  const cards = $('#mcp-cards')
  if (!services.length) {
    cards.appendChild(emptyState({ title: '还没有 MCP 服务', desc: '接入第一个 MCP 服务，为 Agent 提供工具能力', actionText: '接入 MCP 服务', onAction: () => $('#mcp-deploy-wizard').click() }))
  }
  for (const svc of services) {
    const [bg, color] = ICON_COLORS[svc.icon] ?? ICON_COLORS.mcp
    const health = svc.health?.status ?? 'unknown'
    const card = h(`
      <div class="res-card" data-id="${esc(svc.id)}">
        <div class="res-card-top">
          <div class="res-icon" style="background:${bg};color:${color}">${svcIcon(svc.icon)}</div>
          <div class="grow">
            <div class="res-name">${esc(svc.name)} ${statusBadge(svc.status)}${svc.bridgeFrom ? `<span class="badge badge-warning" title="M0 数据面桥接（open-connector）：仅服务级粗粒度权限组，无 action 级授权 / 连接级绑定 / oct_ 令牌镜像——生产纳管请走 #/connectors 原生链路">桥接过渡</span>` : ''}</div>
            <div class="res-slug">${esc(svc.endpoint || svc.slug)}</div>
          </div>
          <span class="traffic ${trafficClass(health)}" title="健康状态：${health}"></span>
        </div>
        <div class="res-desc">${esc(svc.description || '暂无描述')}</div>
        ${svc.status === 'gray' ? `
          <div>
            <div class="flex-between fs-12 mb-8"><span class="text-3">灰度比例</span><span>${svc.grayPercent}%</span></div>
            <div class="progress"><div class="progress-bar" style="width:${svc.grayPercent}%"></div></div>
          </div>` : ''}
        <div class="res-foot">
          <span class="metric">${icon('box', 13)}${svc.tools.length} 工具</span>
          <span class="metric">${icon('gitBranch', 13)}v${esc(svc.currentVersion)}</span>
          <span class="metric">${icon('activity', 13)}${healthLabel(health)}${svc.health?.latencyMs ? ` ${svc.health.latencyMs}ms` : ''}</span>
          <span style="margin-left:auto">${svc.mode === 'external' ? '<span class="badge badge-muted no-dot">外部注册</span>' : '<span class="badge badge-brand no-dot">平台托管</span>'}</span>
        </div>
      </div>`)
    card.onclick = () => openServiceDetail(svc.id, ctx)
    cards.appendChild(card)
  }

  $('#mcp-deploy-wizard').onclick = () => openDeployWizard(ctx)
  $('#mcp-permgroups').onclick = () => openPermGroups(ctx)

  if (params.get('action') === 'deploy') openDeployWizard(ctx)
  if (params.get('focus')) void openServiceDetail(params.get('focus'), ctx)
}

async function openServiceDetail(id, ctx) {
  const [svcData, metrics, calls, groups] = await Promise.all([
    api.get('/api/mcp/services').then((d) => d.services.find((s) => s.id === id)),
    api.get(`/api/mcp/services/${id}/metrics`),
    api.get('/api/mcp/calls' + api.qs({ serviceId: id, limit: 15 })),
    api.get('/api/mcp/perm-groups'),
  ])
  if (!svcData) return
  const [bg, color] = ICON_COLORS[svcData.icon] ?? ICON_COLORS.mcp

  const drawer = openDrawer({
    title: svcData.name,
    sub: `${svcData.endpoint} · ${svcData.mode === 'external' ? '外部注册' : '平台托管'} · v${svcData.currentVersion}`,
    wide: true,
    body: `
      <div class="flex mb-20" style="gap:14px">
        <div class="res-icon" style="width:52px;height:52px;font-size:26px;background:${bg};color:${color}">${svcIcon(svcData.icon)}</div>
        <div class="grow">
          <div class="flex" style="gap:8px;flex-wrap:wrap">
            ${statusBadge(svcData.status)}
            <span class="badge badge-muted no-dot">${svcData.transport.toUpperCase()}</span>
            <span class="badge ${svcData.health?.breakerOpen ? 'badge-danger' : 'badge-ok'} no-dot">${svcData.health?.breakerOpen ? '熔断开启' : '熔断关闭'}</span>
          </div>
          <div class="fs-12 text-3 mt-8">${esc(svcData.description)}</div>
        </div>
      </div>

      <div class="stat-grid mb-20" style="grid-template-columns:repeat(4,1fr)">
        ${miniStat('activity', '调用量', fmtNum(metrics.calls), true)}
        ${miniStat('check', '成功率', fmtPct(metrics.successRate), true)}
        ${miniStat('clock', 'P95 延迟', metrics.p95Latency + 'ms', true)}
        ${miniStat('coins', 'Token 消耗', fmtNum(metrics.tokens), true)}
      </div>

      <div class="tabs" id="svc-tabs">
        <div class="tab active" data-tab="monitor">监控</div>
        <div class="tab" data-tab="tools">工具 (${svcData.tools.length})</div>
        <div class="tab" data-tab="versions">版本</div>
        <div class="tab" data-tab="calls">调用明细</div>
        <div class="tab" data-tab="grants">授权主体</div>
      </div>
      <div id="svc-tab-body"></div>`,
    foot: `
      <button class="btn btn-default" id="svc-health">${icon('wifi', 14)}健康探测</button>
      ${svcData.mode === 'external' && svcData.exec === 'real' ? `<button class="btn btn-default" id="svc-sync-tools">${icon('refresh', 14)}同步工具</button>` : ''}
      ${svcData.status !== 'offline' ? `<button class="btn btn-default" id="svc-gray">${icon('trending', 14)}${svcData.status === 'gray' ? '调整灰度' : '灰度发布'}</button>` : ''}
      ${svcData.status !== 'offline' ? `<button class="btn btn-danger-ghost" id="svc-offline">${icon('alert', 14)}下线服务</button>` : ''}
      ${svcData.status === 'draft' ? `<button class="btn btn-primary" id="svc-verify">${icon('play', 14)}测试验证</button>` : ''}
      ${svcData.status === 'offline' ? `<button class="btn btn-danger-ghost" id="svc-delete">${icon('trash', 14)}删除服务</button>` : ''}`,
  })

  const tabBody = drawer.body.querySelector('#svc-tab-body')
  const renderTab = (tab) => {
    if (tab === 'monitor') {
      tabBody.innerHTML = `
        <div class="card card-pad mb-14">
          <div class="card-title mb-8">近 60 分钟调用（次/分钟）</div>
          ${barChart(metrics.series.map((s) => ({ label: s.minute, value: s.calls })), { width: 640, height: 150 })}
        </div>
        <div class="grid-2">
          <div class="card card-pad">
            <div class="card-title mb-8">平均延迟（ms）</div>
            ${lineChart([metrics.series.map((s) => s.avgLatency)], { width: 300, height: 130 })}
          </div>
          <div class="card card-pad">
            <div class="card-title mb-8">错误数</div>
            ${barChart(metrics.series.map((s) => ({ label: s.minute, value: s.errors })), { width: 300, height: 130, color: '#ef4444' })}
          </div>
        </div>
        <div class="card card-pad mt-14">
          <div class="card-title mb-8">按调用方统计</div>
          ${metrics.callers.map((c) => `
            <div class="flex" style="padding:6px 0;border-bottom:1px solid var(--border)">
              <span class="badge ${c.callerType === 'agent' ? 'badge-purple' : 'badge-brand'} no-dot">${c.callerType === 'agent' ? 'Agent' : '用户'}</span>
              <span class="fs-13 grow">${esc(c.callerName)}</span>
              <span class="col-num">${fmtNum(c.calls)} 次</span>
            </div>`).join('') || '<span class="text-4 fs-12">暂无调用</span>'}
        </div>`
    }
    if (tab === 'tools') {
      tabBody.innerHTML = svcData.tools.map((tool) => `
        <div class="card card-pad mb-8 flex" style="cursor:default">
          <div class="grow">
            <div class="flex" style="gap:8px">
              <span class="mono" style="font-weight:600">${esc(tool.name)}</span>
              <span class="badge ${riskClass(tool.riskLevel)} no-dot">${riskLabel(tool.riskLevel)}</span>
            </div>
            <div class="fs-12 text-3 mt-8">${esc(tool.description)}</div>
          </div>
          <button class="btn btn-default btn-sm stop" data-try="${esc(tool.name)}">${icon('play', 12)}试调用</button>
        </div>`).join('')
      tabBody.querySelectorAll('[data-try]').forEach((btn) => {
        btn.onclick = () => openTryInvoke(svcData, btn.dataset.try, ctx)
      })
    }
    if (tab === 'versions') {
      const versions = [...svcData.versions].reverse()
      tabBody.innerHTML = `
        <div class="timeline">
          ${versions.map((v) => `
            <div class="timeline-item ${v.status === 'current' ? 'ok' : v.status === 'rolled-back' ? 'danger' : ''}">
              <div class="timeline-dot"></div>
              <div class="timeline-title">v${esc(v.version)} <span class="badge ${v.status === 'current' ? 'badge-ok' : v.status === 'rolled-back' ? 'badge-danger' : 'badge-muted'} no-dot">${versionLabel(v.status)}</span></div>
              <div class="timeline-time">${timeAgo(v.publishedAt)}</div>
              <div class="timeline-body">${esc(v.changelog)}</div>
              ${v.status !== 'current' ? `<button class="btn btn-ghost btn-sm mt-8" data-rollback="${esc(v.version)}">回滚到此版本</button>` : ''}
            </div>`).join('') || '<span class="text-4 fs-12">暂无历史版本</span>'}
        </div>`
      tabBody.querySelectorAll('[data-rollback]').forEach((btn) => {
        btn.onclick = async () => {
          const result = await confirmDialog({ title: '版本回滚', message: `将 <b>${esc(svcData.name)}</b> 回滚到 <b>v${esc(btn.dataset.rollback)}</b>，调用方将在下一次请求生效。`, confirmText: '回滚' })
          if (!result) return
          try {
            await api.post(`/api/mcp/services/${svcData.id}/rollback`, { targetVersion: btn.dataset.rollback })
            toast('已回滚'); drawer.close(); ctx.rerender()
          } catch (error) { toast(error.message, 'error') }
        }
      })
    }
    if (tab === 'calls') {
      tabBody.innerHTML = ''
      const table = renderTable({
        columns: [
          { title: '时间', width: 130, render: (c) => `<span class="fs-12 text-3">${timeAgo(c.at)}</span>` },
          { title: '工具', render: (c) => `<span class="mono fs-12">${esc(c.tool)}</span>` },
          { title: '调用方', render: (c) => esc(c.callerName) },
          { title: '版本', render: (c) => `<span class="fs-12 text-3">v${esc(c.version)}</span>` },
          { title: '状态', width: 100, render: (c) => statusBadge(c.status === 'ok' ? 'ok' : c.status) },
          { title: '延迟', width: 80, render: (c) => `<span class="col-num">${c.latencyMs}ms</span>` },
          { title: 'Token', width: 80, render: (c) => `<span class="col-num">${c.tokens || '—'}</span>` },
        ],
        rows: calls.items,
        onRowClick: () => {},
      })
      tabBody.appendChild(table)
    }
    if (tab === 'grants') {
      const granted = groups.groups.filter((g) => g.policies[svcData.id])
      tabBody.innerHTML = granted.map((g) => `
        <div class="card card-pad mb-8">
          <div class="flex-between mb-8">
            <span style="font-weight:600">${icon('shield', 14)} ${esc(g.name)}</span>
            <span class="fs-12 text-3">${esc(g.description || '')}</span>
          </div>
          <div class="fs-12 text-3 mb-8">工具策略：${policyLabel(g.policies[svcData.id])}</div>
          <div class="flex" style="flex-wrap:wrap;gap:6px">
            ${g.subjects.map((s) => `<span class="badge ${subjectClass(s.type)} no-dot">${esc(s.name ?? s.id)}</span>`).join('')}
          </div>
        </div>`).join('') || '<span class="text-4 fs-12">尚无权限组授权该服务</span>'
    }
  }
  drawer.body.querySelectorAll('#svc-tabs .tab').forEach((el) => {
    el.onclick = () => {
      drawer.body.querySelectorAll('#svc-tabs .tab').forEach((t) => t.classList.remove('active'))
      el.classList.add('active')
      renderTab(el.dataset.tab)
    }
  })
  renderTab('monitor')

  drawer.el.querySelector('#svc-health').onclick = async (e) => {
    const btn = e.currentTarget
    btn.classList.add('btn-loading')
    try {
      const result = await api.post(`/api/mcp/services/${svcData.id}/health`)
      toast(`探测完成：${result.status}（${result.latencyMs}ms）`)
      drawer.close(); ctx.rerender()
    } catch (error) { toast(error.message, 'error') } finally { btn.classList.remove('btn-loading') }
  }
  const syncToolsBtn = drawer.el.querySelector('#svc-sync-tools')
  if (syncToolsBtn) syncToolsBtn.onclick = async (e) => {
    const btn = e.currentTarget
    btn.classList.add('btn-loading')
    try {
      const updated = await api.post(`/api/mcp/services/${svcData.id}/sync-tools`)
      toast(`工具清单已同步：${updated.tools.length} 个工具`)
      drawer.close(); ctx.rerender()
    } catch (error) { toast(error.message, 'error') } finally { btn.classList.remove('btn-loading') }
  }
  const grayBtn = drawer.el.querySelector('#svc-gray')
  if (grayBtn) grayBtn.onclick = () => openGrayDialog(svcData, drawer, ctx)
  const offlineBtn = drawer.el.querySelector('#svc-offline')
  if (offlineBtn) offlineBtn.onclick = async () => {
    const result = await confirmDialog({
      title: '下线 MCP 服务（L4）', requireReason: true, danger: true, confirmText: '提交审批',
      message: `下线 <b>${esc(svcData.name)}</b> 是高危操作，将生成审批单，审批通过后自动执行。所有依赖该服务的 Agent 调用会立即失败。`,
    })
    if (!result) return
    try {
      const response = await api.post(`/api/mcp/services/${svcData.id}/offline`, { reason: result.reason })
      toast('已创建 L4 审批单，等待审批')
      drawer.close(); ctx.rerender()
      void response
    } catch (error) { toast(error.message, 'error') }
  }
  const verifyBtn = drawer.el.querySelector('#svc-verify')
  if (verifyBtn) verifyBtn.onclick = async (e) => {
    const btn = e.currentTarget
    btn.classList.add('btn-loading')
    try {
      await api.post(`/api/mcp/services/${svcData.id}/verify`)
      toast('测试环境验证通过'); drawer.close(); ctx.rerender()
    } catch (error) { toast(error.message, 'error') } finally { btn.classList.remove('btn-loading') }
  }

  const deleteBtn = drawer.el.querySelector('#svc-delete')
  if (deleteBtn) deleteBtn.onclick = async () => {
    const result = await confirmDialog({
      title: `删除 MCP 服务 · ${svcData.name}`, requireReason: true, danger: true, confirmText: '确认删除',
      message: `将永久删除 <b>${esc(svcData.name)}</b> 的服务登记（含工具清单与探活状态），操作不可恢复；调用明细与审计数据保留。`,
    })
    if (!result) return
    try {
      await api.delete(`/api/mcp/services/${svcData.id}`)
      toast('已删除'); drawer.close(); ctx.rerender()
    } catch (error) { toast(error.message, 'error') }
  }
}

function openGrayDialog(svc, drawer, ctx) {
  const modal = openModal({
    title: `灰度发布 · ${svc.name}`,
    body: `
      <div class="muted-box mb-14" style="display:flex;gap:8px">
        ${icon('info', 15)}<span>灰度按调用方标签路由：未命中灰度比例的调用将继续走 <b>v${esc(svc.versions.find((v) => v.status === 'previous')?.version ?? svc.currentVersion)}</b> 稳定版本。</span>
      </div>
      ${field('灰度比例（%）', `<input class="input" type="range" min="0" max="100" step="5" value="${svc.grayPercent || 10}" id="gray-range" oninput="this.nextElementSibling.textContent=this.value+'%'"><div style="font-weight:600;margin-top:4px">${svc.grayPercent || 10}%</div>`)}
      ${field('新版本号', inputField('version', { value: bumpPatch(svc.currentVersion) }))}
      ${field('变更说明', textareaField('changelog', { placeholder: '本次发布内容…' }))}`,
    foot: `<button class="btn btn-default" data-dryrun>预演影响面</button><button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>发布</button>`,
  })
  const body = modal.body
  modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
  modal.el.querySelector('[data-dryrun]').onclick = async () => {
    try {
      const result = await api.post(`/api/mcp/services/${svc.id}/deploy`, { dryRun: true })
      const impact = result.impact?.length
        ? result.impact.map((i) => `<li>${esc(i.name)}（${typeLabel(i.type)}）</li>`).join('')
        : '<li>无直接依赖方，可安全发布</li>'
      modal.close()
      openModal({ title: '影响面预演（dry-run）', body: `<div class="form-hint">以下资源可能受到本次发布影响：</div><ul style="padding-left:18px;line-height:2">${impact}</ul><div class="muted-box mt-14">dry-run 未执行任何变更。</div>`, foot: '<button class="btn btn-primary" data-ok>知道了</button>' })
        .el.querySelector('[data-ok]').onclick = () => openGrayDialog(svc, drawer, ctx)
    } catch (error) { toast(error.message, 'error') }
  }
  modal.el.querySelector('[data-ok]').onclick = async () => {
    const data = collectForm(body)
    try {
      await api.post(`/api/mcp/services/${svc.id}/deploy`, {
        grayPercent: Number(body.querySelector('#gray-range').value),
        version: data.version, changelog: data.changelog,
      })
      toast(`已发布 v${data.version}`); modal.close(); drawer.close(); ctx.rerender()
    } catch (error) { toast(error.message, 'error') }
  }
}

function openDeployWizard(ctx) {
  let step = 1
  const state = { transport: 'http' }
  const modal = openModal({
    title: '接入 MCP 服务', wide: true,
    body: `
      <div class="flex mb-20" style="gap:6px" id="wiz-steps">
        ${wizardStep(1, '选择来源', true)}${wizardArrow()}${wizardStep(2, '配置', false)}${wizardArrow()}${wizardStep(3, '验证发布', false)}
      </div>
      <div id="wiz-body"></div>`,
    foot: `
      <button class="btn btn-default" id="wiz-prev" style="visibility:hidden">上一步</button>
      <button class="btn btn-primary" id="wiz-next">下一步</button>`,
  })
  const bodyEl = modal.body.querySelector('#wiz-body')
  const prevBtn = modal.el.querySelector('#wiz-prev')
  const nextBtn = modal.el.querySelector('#wiz-next')

  const renderStep = () => {
    modal.body.querySelectorAll('#wiz-steps .wiz-step').forEach((el, index) => {
      el.classList.toggle('active', index + 1 === step)
      el.classList.toggle('done', index + 1 < step)
    })
    prevBtn.style.visibility = step === 1 ? 'hidden' : ''
    nextBtn.textContent = step === 3 ? (state.source === 'import' ? '导入并上线' : '验证并发布') : '下一步'
    if (step === 1) {
      bodyEl.innerHTML = `
        <div class="card-grid" style="grid-template-columns:1fr 1fr">
          ${sourceCard('import', '配置导入（JSON）', '粘贴 Claude / Cursor 等工具的 mcpServers 配置，自动注册并发现工具', 'clipboard')}
          ${sourceCard('endpoint', '外部服务注册', '手动登记 endpoint 与传输协议', 'globe')}
          ${sourceCard('template', '平台模板', '容器化托管，提供运行时模板与镜像', 'box')}
          ${sourceCard('image', '自有镜像', '指定容器镜像，由平台托管部署', 'server')}
        </div>`
      bodyEl.querySelectorAll('[data-source]').forEach((card) => {
        card.onclick = () => {
          state.source = card.dataset.source
          bodyEl.querySelectorAll('[data-source]').forEach((c) => c.classList.remove('selected'))
          card.classList.add('selected')
        }
      })
    }
    if (step === 2 && state.source === 'import') {
      bodyEl.innerHTML = `
        <div class="form-grid">
          <div class="form-item full">
            <label class="form-label">MCP 配置 JSON<span class="req">*</span></label>
            <textarea class="form-control" name="config" rows="10" style="font-family:var(--mono);font-size:12px" placeholder='${esc(JSON.stringify({ mcpServers: { 'teambition-mcp': { type: 'streamableHttp', url: 'https://open.teambition.com/api/mcp?userToken=你的令牌' } } }, null, 2))}'>${esc(state.config ?? '')}</textarea>
            <div class="form-hint">支持 Claude Desktop / Cursor / Cherry Studio 等工具通行的 mcpServers 格式；http、streamableHttp、sse 类型均可导入，导入后自动拉取远端工具清单并上线。token 已含在 url 中的配置可直接粘贴。</div>
          </div>
        </div>`
      return
    }
    if (step === 2) {
      const isExternal = state.source === 'endpoint'
      bodyEl.innerHTML = `
        <div class="form-grid">
          ${field('服务名称', inputField('name', { value: state.name }), { required: true })}
          ${field('服务标识', inputField('slug', { value: state.slug, placeholder: '小写字母与中划线' }), { hint: '唯一标识，用于权限组与调用' })}
          ${field(isExternal ? '服务 Endpoint' : '运行地址', inputField('endpoint', { value: state.endpoint, placeholder: isExternal ? 'https://your-mcp.example.com/mcp' : '自动生成' }), { required: isExternal, full: true })}
          <div class="form-item">
            <label class="form-label">传输协议</label>
            <div class="segmented">
              <span class="segmented-item ${state.transport === 'http' ? 'active' : ''}" data-t="http">HTTP</span>
              <span class="segmented-item ${state.transport === 'sse' ? 'active' : ''}" data-t="sse">SSE</span>
              <span class="segmented-item ${state.transport === 'stdio' ? 'active' : ''}" data-t="stdio">stdio</span>
            </div>
          </div>
          ${field('服务描述', textareaField('description', { value: state.description, rows: 2 }), { full: true })}
        </div>`
      bodyEl.querySelectorAll('.segmented-item').forEach((el) => {
        el.onclick = () => {
          state.transport = el.dataset.t
          bodyEl.querySelectorAll('.segmented-item').forEach((i) => i.classList.remove('active'))
          el.classList.add('active')
        }
      })
    }
    if (step === 3 && state.source === 'import') {
      let entries = []
      let parseError = ''
      try {
        const parsed = JSON.parse(state.config)
        const map = parsed?.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : parsed
        entries = Object.entries(map).map(([name, conf]) => ({ name, url: conf?.url ?? '', type: conf?.type ?? 'http' }))
      } catch (error) { parseError = error.message }
      bodyEl.innerHTML = `
        <div class="grid-2">
          <div>
            <div class="card-title mb-8">将导入以下服务</div>
            ${parseError
              ? `<div class="muted-box" style="color:var(--danger)">${esc(parseError)}</div>`
              : entries.map((entry) => `
                <div class="card card-pad mb-8">
                  <div class="flex-between">
                    <span style="font-weight:600">${esc(entry.name)}</span>
                    <span class="badge badge-muted no-dot">${esc(entry.type)}</span>
                  </div>
                  <div class="fs-12 text-3 mt-4 mono" style="word-break:break-all">${esc(entry.url || '（缺少 url，将被跳过）')}</div>
                </div>`).join('')}
            ${checkItem(true, '导入后自动连接服务并发现工具清单')}
            ${checkItem(true, '连接成功将自动测试验证并发布上线（草稿保留可回退）')}
          </div>
          <div>
            <div class="card-title mb-8">导入说明</div>
            <div class="code-block">POST /api/mcp/import
mode: external
exec: real
tools: 远端自动发现（tools/list）</div>
            <div class="form-hint mt-8">导入的服务与手动注册一致：经网关统一鉴权、限流熔断；在「权限组」为用户/Agent 授权后即可调用。</div>
          </div>
        </div>`
      return
    }
    if (step === 3) {
      const yaml = `# 配置预览（api.yaml 片段）
service: ${state.slug || 'my-service'}
mode: ${state.source === 'endpoint' ? 'external' : 'hosted'}
transport: ${state.transport || 'http'}
endpoint: ${state.endpoint || `mcp+http://platform-hosted/${state.slug || 'my-service'}`}
tools: []           # 部署后在「工具」页登记`
      bodyEl.innerHTML = `
        <div class="grid-2">
          <div>
            <div class="card-title mb-8">检查清单</div>
            ${checkItem(Boolean(state.name), '服务名称已填写')}
            ${checkItem(state.source !== 'endpoint' || Boolean(state.endpoint), state.source === 'endpoint' ? 'endpoint 已登记' : '平台托管，自动分配地址')}
            ${checkItem(true, '安全审核：静态扫描通过（演示环境自动通过）')}
            ${checkItem(true, '将进入「草稿」状态，需测试验证后发布')}
          </div>
          <div>
            <div class="card-title mb-8">配置预览</div>
            <div class="code-block">${esc(yaml)}</div>
          </div>
        </div>`
    }
  }
  const collect = () => { Object.assign(state, collectForm(bodyEl)) }
  prevBtn.onclick = () => { if (step > 1) { collect(); step--; renderStep() } }
  nextBtn.onclick = async () => {
    if (step === 1) {
      if (!state.source) return toast('请选择接入来源', 'error')
      step = 2; renderStep(); return
    }
    if (step === 2) {
      collect()
      if (state.source === 'import') {
        if (!state.config?.trim()) return toast('请粘贴 MCP 配置 JSON', 'error')
        try { JSON.parse(state.config) } catch { return toast('配置不是合法 JSON，请检查后重试', 'error') }
        step = 3; renderStep(); return
      }
      if (!state.name) return toast('请填写服务名称', 'error')
      step = 3; renderStep(); return
    }
    collect()
    nextBtn.classList.add('btn-loading')
    try {
      if (state.source === 'import') {
        const result = await api.post('/api/mcp/import', { config: state.config })
        const failures = result.results.filter((item) => !item.ok)
        if (result.imported > 0) toast(`已导入 ${result.imported} 个服务（工具已自动发现并上线）`)
        if (failures.length) {
          toast(`未导入：${failures.map((item) => `${item.name}（${item.error}）`).join('；')}`.slice(0, 160), 'error')
          if (result.imported === 0) return
        }
        modal.close(); ctx.rerender()
        return
      }
      await api.post('/api/mcp/services', {
        name: state.name, slug: state.slug || undefined, description: state.description,
        endpoint: state.endpoint || undefined,
        transport: state.transport || 'http',
        mode: state.source === 'endpoint' ? 'external' : 'hosted',
      })
      toast('服务已创建（草稿），完成验证后即可发布')
      modal.close(); ctx.rerender()
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      nextBtn.classList.remove('btn-loading')
    }
  }
  renderStep()

  function sourceCard(value, title, desc, ic) {
    return `
      <div class="res-card ${state.source === value ? 'selected' : ''}" data-source="${value}">
        <div class="res-card-top">
          <div class="res-icon" style="background:var(--brand-50);color:var(--brand-500)">${icon(ic, 20)}</div>
          <div style="font-weight:600">${title}</div>
        </div>
        <div class="res-desc" style="min-height:0">${desc}</div>
      </div>`
  }
  function checkItem(ok, text) {
    return `<div class="flex" style="padding:6px 0"><span style="color:var(--${ok ? 'ok' : 'text-4)'})">${icon(ok ? 'check' : 'clock', 15)}</span><span class="fs-13 ${ok ? '' : 'text-3'}">${text}</span></div>`
  }
  function wizardStep(n, label) {
    return `<div class="wiz-step ${''}" data-n="${n}"><span class="wiz-dot">${n}</span>${label}</div>`
  }
  function wizardArrow() { return `<span class="wiz-arrow">→</span>` }
}

async function openPermGroups(ctx) {
  const [groups, services] = await Promise.all([
    api.get('/api/mcp/perm-groups'),
    api.get('/api/mcp/services'),
    api.get('/api/agents').catch(() => ({ agents: [] })),
  ])
  const drawer = openDrawer({
    title: 'MCP 权限组',
    sub: '权限组 = 一组 MCP 服务 + Tool 粒度访问策略，可绑定用户组 / Agent / 应用',
    wide: true,
    body: `<div id="pg-list"></div>`,
    foot: `<button class="btn btn-primary" id="pg-add">${icon('plus', 14)}新建权限组</button>`,
  })
  const list = drawer.body.querySelector('#pg-list')
  const renderList = () => {
    list.innerHTML = groups.groups.map((g) => `
      <div class="card card-pad mb-14">
        <div class="flex-between mb-8">
          <div>
            <span style="font-weight:600">${esc(g.name)}</span>
            <span class="fs-12 text-3" style="margin-left:8px">${esc(g.description || '')}</span>
          </div>
          <button class="btn btn-ghost btn-sm" style="color:var(--danger)" data-del="${esc(g.id)}">${icon('trash', 13)}</button>
        </div>
        ${Object.entries(g.policies).map(([serviceId, policy]) => `
          <div class="flex" style="padding:6px 0;border-bottom:1px dashed var(--border)">
            <span class="fs-13 grow">${esc(services.services.find((s) => s.id === serviceId)?.name ?? serviceId)}</span>
            <span class="fs-12 text-3">${policyLabel(policy)}</span>
          </div>`).join('')}
        <div class="flex mt-8" style="flex-wrap:wrap;gap:6px">
          ${g.subjects.map((s) => `<span class="badge ${subjectClass(s.type)} no-dot">${esc(s.name ?? s.id)}</span>`).join('') || '<span class="text-4 fs-12">未绑定主体</span>'}
        </div>
      </div>`).join('') || '<span class="text-4 fs-12">暂无权限组</span>'
    list.querySelectorAll('[data-del]').forEach((btn) => {
      btn.onclick = async () => {
        const result = await confirmDialog({ title: '删除权限组', message: '删除后相关主体的访问授权立即失效。', danger: true })
        if (!result) return
        await api.delete(`/api/mcp/perm-groups/${btn.dataset.del}`)
        toast('已删除'); drawer.close(); ctx.rerender()
      }
    })
  }
  renderList()
  drawer.el.querySelector('#pg-add').onclick = () => {
    const agentsPromise = api.get('/api/agents').catch(() => ({ agents: [] }))
    const groupsPromise = api.get('/api/iam/groups').catch(() => ({ groups: [] }))
    const appsPromise = api.get('/api/apps').catch(() => ({ apps: [] }))
    void Promise.all([agentsPromise, groupsPromise, appsPromise]).then(([agentData, groupData, appData]) => {
      // 主体候选：Agent / 用户组 / 应用 三类（与后端 subject 类型对齐）
      const subjectOptions = [
        ...(agentData.agents ?? []).map((a) => ({ value: `agent:${a.id}`, label: `${a.name}（${a.slug ?? a.id}）`, group: 'Agent' })),
        ...(groupData.groups ?? []).map((g) => ({ value: `user_group:${g.id}`, label: g.name, group: '用户组' })),
        ...(appData.apps ?? []).map((a) => ({ value: `app:${a.id}`, label: a.name, group: '应用' })),
      ]
      const modal = openModal({
        title: '新建 MCP 权限组', wide: true,
        body: `
          <div class="form-grid">
            ${field('名称', inputField('name'), { required: true })}
            ${field('描述', inputField('description'))}
          </div>
          <div class="card-title mb-8" style="margin-top:8px">服务与工具策略</div>
          ${services.services.map((s) => `
            <div class="card card-pad mb-8">
              <label class="flex mb-8"><input type="checkbox" data-service="${esc(s.id)}" style="accent-color:var(--brand-500)"><b>${esc(s.name)}</b></label>
              <div class="flex" style="gap:14px;padding-left:24px">
                <label class="flex fs-12"><input type="checkbox" data-ro="${esc(s.id)}" style="accent-color:var(--brand-500)">只读模式（禁止 write/admin 工具）</label>
                <span class="fs-12 text-3">默认放开全部工具</span>
              </div>
            </div>`).join('')}
          <div class="card-title mb-8">绑定主体</div>
          <div class="fs-12 text-3 mb-8" style="margin-top:8px">绑定后主体立即获得对应工具访问权（用户组经 iam 圈人，Agent 按机器身份命中，应用按客户端身份命中）</div>
          ${field('绑定主体（可多选）', multiSelectField('subjects', subjectOptions, { placeholder: '搜索并选择 Agent / 用户组 / 应用，可多选' }))}`,
        foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>创建</button>',
      })
      mountSearchableSelects(modal.el)
      modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
      modal.el.querySelector('[data-ok]').onclick = async () => {
        const name = collectForm(modal.body).name
        const policies = {}
        modal.body.querySelectorAll('[data-service]:checked').forEach((el) => {
          const serviceId = el.dataset.service
          const ro = modal.body.querySelector(`[data-ro="${serviceId}"]`)?.checked
          policies[serviceId] = { allowedTools: '*', constraints: ro ? { readOnly: true } : {} }
        })
        // 主体值格式 type:id，还原为后端 subjects 数组
        const subjects = (collectForm(modal.body).subjects ?? '').split(',').filter(Boolean).map((v) => {
          const idx = v.indexOf(':')
          return { type: v.slice(0, idx), id: v.slice(idx + 1) }
        })
        try {
          await api.post('/api/mcp/perm-groups', { name, description: collectForm(modal.body).description, policies, subjects })
          toast('权限组已创建'); modal.close(); drawer.close(); ctx.rerender()
        } catch (error) { toast(error.message, 'error') }
      }
    })
  }
}

function openTryInvoke(svc, toolName, ctx) {
  const modal = openModal({
    title: `试调用 · ${toolName}`,
    body: `
      <div class="muted-box mb-14">通过统一网关调用（鉴权 / 限流 / 审计 / 指标全部生效）。参数以 JSON 输入。</div>
      ${field('参数（JSON）', textareaField('args', { value: '{\n  "query": "演示参数"\n}', rows: 5 }))}`,
    foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>调用</button>',
  })
  modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
  modal.el.querySelector('[data-ok]').onclick = async (e) => {
    const btn = e.currentTarget
    btn.classList.add('btn-loading')
    try {
      let args = {}
      try { args = JSON.parse(collectForm(modal.body).args || '{}') } catch { args = {} }
      const result = await api.post('/api/mcp/invoke', { serviceId: svc.id, tool: toolName, args })
      modal.close()
      openModal({
        title: result.ok ? '调用成功' : `调用失败（${result.status}）`,
        body: `<div class="code-block">${esc(JSON.stringify({ status: result.status, latencyMs: result.latencyMs, version: result.version, result: result.result ?? result.error }, null, 2))}</div>`,
        foot: '<button class="btn btn-primary" data-ok>关闭</button>',
      })
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      btn.classList.remove('btn-loading')
    }
  }
}

// ---------- helpers ----------
function miniStat(ic, label, value, compact) {
  return `
    <div class="${compact ? 'flex' : ''}" style="${compact ? 'background:var(--surface-2);border-radius:10px;padding:12px 14px;gap:10px' : ''}">
      <div class="stat-icon" style="${compact ? 'width:30px;height:30px;margin:0;background:var(--brand-50);color:var(--brand-500)' : 'background:var(--brand-50);color:var(--brand-500)'}">${icon(ic, compact ? 15 : 18)}</div>
      <div>
        <div class="stat-value" style="${compact ? 'font-size:17px' : ''}">${value}</div>
        <div class="stat-label">${esc(label)}</div>
      </div>
    </div>`
}
function svcIcon(ic) {
  const map = { kb: 'book', chart: 'chart', ticket: 'ticket', hr: 'users', fx: 'coins' }
  return icon(map[ic] ?? 'plug', 20)
}
function trafficClass(health) {
  return { healthy: 'traffic-green', degraded: 'traffic-yellow', down: 'traffic-red' }[health] ?? 'traffic-gray'
}
function healthLabel(health) {
  return { healthy: '健康', degraded: '降级', down: '不可用' }[health] ?? '未知'
}
function riskClass(level) {
  return { read: 'badge-ok', write: 'badge-warn', admin: 'badge-danger' }[level] ?? 'badge-muted'
}
function riskLabel(level) {
  return { read: '只读', write: '可写', admin: '高危' }[level] ?? level
}
function versionLabel(status) {
  return { current: '当前版本', previous: '历史版本', 'rolled-back': '已回滚' }[status] ?? status
}
function policyLabel(policy) {
  const tools = policy.allowedTools === '*' ? '全部工具' : `${policy.allowedTools.length} 个工具`
  return policy.constraints?.readOnly ? `${tools} · 只读模式` : tools
}
function subjectClass(type) {
  return { user_group: 'badge-brand', agent: 'badge-purple', app: 'badge-info' }[type] ?? 'badge-muted'
}
function typeLabel(type) {
  return { agent: 'Agent', app: '应用', skill: 'Skill', mcp_service: 'MCP' }[type] ?? type
}
function bumpPatch(version) {
  const parts = String(version ?? '1.0.0').replace(/-rc\d+/, '').split('.').map(Number)
  parts[2] = (parts[2] ?? 0) + 1
  return parts.join('.')
}
