/** 工作台：角色化首页（待办审批 + 健康看板 + 快捷入口 + 事件流 + 成本趋势）。 */
import { api, session } from '../api.js'
import { icon } from '../icons.js'
import { h, $, $$, esc, fmtNum, fmtCost, fmtPct, timeAgo, statusBadge, sparkline } from '../ui.js'

export async function renderDashboard(content) {
  content.innerHTML = `<div style="padding:60px;text-align:center;color:var(--text-4)">加载中…</div>`
  let d
  try {
    d = await api.get('/api/overview')
  } catch (error) {
    content.innerHTML = `<div class="card card-pad">${esc(error.message)}</div>`
    return
  }

  const hour = new Date().getHours()
  const greet = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好'
  const firstName = session.user?.displayName ?? ''

  content.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">${greet}，${esc(firstName)} <span style="font-size:15px">👋</span></div>
        <div class="page-desc">今天有 <b style="color:var(--warn)">${d.approvals.pending}</b> 个审批待处理、<b style="color:var(--danger)">${d.alerts.unread}</b> 条未读告警，${d.conflicts > 0 ? `以及 <b style="color:var(--brand-600)">${d.conflicts}</b> 条三方同步冲突待确认。` : '平台整体运行平稳。'}</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-default" id="dash-goto-agents">${icon('bot', 14)}查看 Agent</button>
        <button class="btn btn-primary" id="dash-goto-approve">${icon('checkSquare', 14)}处理审批</button>
      </div>
    </div>

    <div class="stat-grid mb-20">
      ${statCard('users', '账号总数', d.iam.users, `待激活 ${d.iam.pendingUsers} 人`, 'var(--brand-500)', 'var(--brand-50)', '#/iam')}
      ${statCard('plug', 'MCP 在线', d.mcp.onlineServices, `成功率 ${fmtPct(d.mcp.successRate)}${d.mcp.unhealthyServices ? ` · 异常 ${d.mcp.unhealthyServices}` : ''}`, 'var(--ok)', 'var(--ok-bg)', '#/mcp')}
      ${statCard('bot', 'Agent 在线', `${d.agents.online}/${d.agents.total}`, `试运行 ${d.agents.trial} · 开发中 ${d.agents.draft}`, 'var(--purple)', 'var(--purple-bg)', '#/agents')}
      ${statCard('sparkles', 'Skill 上架', d.skills.published, `待审批 ${d.skills.pendingApproval} 个`, 'var(--warn)', 'var(--warn-bg)', '#/skills')}
      ${statCard('activity', '累计调用', d.mcp.totalCalls, `P95 ${d.mcp.p95Latency}ms · Token ${fmtNum(d.mcp.tokens)}`, 'var(--info)', 'var(--info-bg)', '#/audit?tab=logs')}
    </div>

    <div class="grid-2 mb-20">
      <div class="card">
        <div class="card-head">
          <span class="card-title">${icon('checkSquare', 15)} 待我审批</span>
          <div class="card-head-actions"><a href="#/approvals" class="fs-12">全部 ›</a></div>
        </div>
        <div class="card-body" id="dash-approvals"></div>
      </div>
      <div class="card">
        <div class="card-head">
          <span class="card-title">${icon('bell', 15)} 平台告警</span>
          <span class="card-sub">${d.alerts.unread} 条未读${d.alerts.critical > 0 ? ` · ${d.alerts.critical} 条严重` : ''}</span>
          <div class="card-head-actions"><a href="#/audit?tab=alerts" class="fs-12">告警中心 ›</a></div>
        </div>
        <div class="card-body" id="dash-alerts"></div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head"><span class="card-title">${icon('trending', 15)} Token 成本趋势（近 14 天）</span>
          <div class="card-head-actions"><a href="#/audit?tab=cost" class="fs-12">成本分析 ›</a></div>
        </div>
        <div class="card-body">
          <div class="flex-between mb-8">
            <div><span class="fs-12 text-3">14 天合计</span><div style="font-size:20px;font-weight:700" id="dash-cost-total"></div></div>
            <div class="fs-12 text-3">按日归集 · 应用 → Agent → MCP 穿透</div>
          </div>
          <div id="dash-cost-chart"></div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><span class="card-title">${icon('zap', 15)} 平台事件流</span>
          <div class="card-head-actions"><span class="card-sub">实时</span></div>
        </div>
        <div class="card-body" id="dash-events"></div>
      </div>
    </div>`

  $('#dash-goto-agents').onclick = () => { location.hash = '#/agents' }
  $('#dash-goto-approve').onclick = () => { location.hash = '#/approvals' }
  $$('.stat-card[data-href]').forEach((card) => {
    card.onclick = () => { location.hash = card.dataset.href }
  })

  // 待办审批
  const approvalsEl = $('#dash-approvals')
  if (d.approvals.items?.length) {
    approvalsEl.innerHTML = d.approvals.items.map((item) => `
      <div class="flex" style="padding:10px 0;border-bottom:1px solid var(--border);cursor:pointer" data-id="${esc(item.id)}">
        <span style="color:var(--warn)">${icon('clock', 16)}</span>
        <div class="grow">
          <div class="fs-13" style="font-weight:500">${esc(item.title)}</div>
          <div class="fs-12 text-4" style="margin-top:2px">${esc(item.requesterName)} 发起 · ${timeAgo(item.createdAt)}</div>
        </div>
        <button class="btn btn-primary btn-sm stop">审批</button>
      </div>`).join('')
    approvalsEl.querySelectorAll('[data-id]').forEach((row) => {
      row.onclick = () => { location.hash = `#/approvals?focus=${row.dataset.id}` }
    })
  } else {
    approvalsEl.innerHTML = emptyRow('check', '暂无待办审批', '所有审批已处理完毕')
  }

  // 告警
  const alertsEl = $('#dash-alerts')
  try {
    const alerts = await api.get('/api/audit/alerts?unread=1')
    const items = alerts.alerts.slice(0, 4)
    if (items.length) {
      alertsEl.innerHTML = items.map((alert) => `
        <div class="flex" style="padding:10px 0;border-bottom:1px solid var(--border)">
          <span style="color:var(--${alert.severity === 'critical' ? 'danger' : alert.severity === 'warning' ? 'warn' : 'info'})">${icon('alert', 16)}</span>
          <div class="grow">
            <div class="fs-13" style="font-weight:500">${esc(alert.title)}</div>
            <div class="fs-12 text-4 ellipsis" style="margin-top:2px">${esc(alert.message)}</div>
          </div>
          <span class="fs-11 text-4">${timeAgo(alert.createdAt)}</span>
        </div>`).join('')
    } else {
      alertsEl.innerHTML = emptyRow('shieldCheck', '一切正常', '当前没有未读告警')
    }
  } catch { alertsEl.innerHTML = emptyRow('alert', '告警加载失败', '') }

  // 成本趋势
  const trend = d.costTrend ?? []
  $('#dash-cost-total').textContent = fmtCost(trend.reduce((s, row) => s + row.costYuan, 0))
  $('#dash-cost-chart').innerHTML = sparkline(trend.map((row) => row.costYuan), { width: 520, height: 90 })

  // 事件流
  const eventsEl = $('#dash-events')
  const EVENT_LABELS = {
    'iam.user.frozen': '账号冻结', 'authn.token.issued': '令牌签发', 'authn.token.revoked': '令牌吊销',
    'mcp.deployed': 'MCP 发布', 'mcp.offlined': 'MCP 下线', 'mcp.unhealthy': 'MCP 熔断', 'mcp.invoked': 'MCP 调用',
    'skill.published': 'Skill 上架', 'skill.submitted': 'Skill 提交', 'skill.installed': 'Skill 安装', 'skill.deprecated': 'Skill 弃用',
    'agent.registered': 'Agent 注册', 'agent.onlined': 'Agent 上线', 'agent.offlined': 'Agent 下线',
    'app.onlined': '应用发布', 'app.offlined': '应用下架', 'approval.created': '新建审批', 'approval.decided': '审批决策',
    'audit.alert.fired': '触发告警', 'iam.connector.synced': '通讯录同步',
  }
  if (d.recentEvents?.length) {
    eventsEl.innerHTML = d.recentEvents.slice(0, 7).map((event) => `
      <div class="flex" style="padding:8px 0;border-bottom:1px solid var(--border)">
        <span class="badge ${eventBadgeClass(event.name)} no-dot" style="min-width:72px;justify-content:center">${esc(EVENT_LABELS[event.name] ?? event.name)}</span>
        <span class="fs-12 ellipsis grow">${esc(event.payload || '—')}</span>
        <span class="fs-11 text-4">${timeAgo(event.at)}</span>
      </div>`).join('')
  } else {
    eventsEl.innerHTML = emptyRow('zap', '暂无事件', '平台事件将实时显示在这里')
  }
}

function eventBadgeClass(name) {
  if (name.includes('unhealthy') || name.includes('alert') || name.includes('frozen') || name.includes('revoked') || name.includes('offlined') || name.includes('offline') || name.includes('deprecated')) return 'badge-danger'
  if (name.includes('deployed') || name.includes('published') || name.includes('onlined') || name.includes('registered')) return 'badge-ok'
  if (name.includes('approval')) return 'badge-warn'
  return 'badge-muted'
}

function statCard(ic, label, value, foot, color, bg, href) {
  return `
    <div class="stat-card" data-href="${href}">
      <div class="stat-icon" style="background:${bg};color:${color}">${icon(ic, 18)}</div>
      <div class="stat-value">${value}</div>
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-foot">${esc(foot)}</div>
    </div>`
}

function emptyRow(ic, title, desc) {
  return `
    <div style="text-align:center;padding:26px 10px">
      <div style="color:var(--ok);margin-bottom:8px">${icon(ic, 26)}</div>
      <div class="fs-13" style="font-weight:500">${esc(title)}</div>
      <div class="fs-12 text-4">${esc(desc)}</div>
    </div>`
}
