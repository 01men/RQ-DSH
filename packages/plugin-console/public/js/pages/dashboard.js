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
        ${d.conflicts > 0 ? `<button class="btn btn-default" id="dash-goto-conflicts" style="color:var(--brand-600)">${icon('link', 14)}处理同步冲突（${d.conflicts}）</button>` : ''}
        <button class="btn btn-default" id="dash-goto-agents">${icon('bot', 14)}查看 Agent</button>
        <button class="btn btn-primary" id="dash-goto-approve">${icon('checkSquare', 14)}处理审批</button>
      </div>
    </div>

    <div class="stat-grid mb-20">
      ${statCard('users', '账号总数', d.iam.users, `待激活 ${d.iam.pendingUsers} 人`, 'var(--brand-500)', 'var(--brand-50)', '#/iam')}
      ${statCard('plug', 'MCP 在线', d.mcp.onlineServices, `成功率 ${fmtPct(d.mcp.successRate)}${d.mcp.unhealthyServices ? ` · 异常 ${d.mcp.unhealthyServices}` : ''}`, 'var(--ok)', 'var(--ok-bg)', '#/mcp', '统计口径：近期 MCP/连接器探活与调用的成功占比。网关未配置或探活失败会拉低该值，不代表平台故障；点击卡片可查看各服务健康明细。')}
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

  $('#dash-goto-agents')?.addEventListener('click', () => { location.hash = '#/agents' })
  $('#dash-goto-approve')?.addEventListener('click', () => { location.hash = '#/approvals' })
  $('#dash-goto-conflicts')?.addEventListener('click', () => { location.hash = '#/iam?tab=conflicts' })
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

  // 事件流（测试 UI-03：事件名中文化 + 摘要人话化，原始 payload 收进「详情」）
  const eventsEl = $('#dash-events')
  const EVENT_LABELS = {
    'iam.user.frozen': '账号冻结', 'iam.user.activated': '账号启用', 'iam.org.changed': '组织变更',
    'iam.permission.changed': '权限变更', 'iam.connector.synced': '通讯录同步',
    'authn.token.issued': '令牌签发', 'authn.token.revoked': '令牌吊销',
    'oidc.authorize.granted': 'SSO 授权通过', 'oidc.authorize.denied': 'SSO 授权拒绝',
    'mcp.deployed': 'MCP 发布', 'mcp.offlined': 'MCP 下线', 'mcp.unhealthy': 'MCP 熔断', 'mcp.invoked': 'MCP 调用',
    'connector.gateway.changed': '连接器网关变更', 'connector.gateway.synced': '连接器目录同步',
    'connector.gateway.unhealthy': '连接器网关异常', 'connector.connected': 'SaaS 连接建立',
    'connector.disconnected': 'SaaS 连接断开', 'connector.invoked': 'SaaS 连接器调用',
    'connector.permgroup.changed': '连接器权限组变更',
    'nas.registered': 'NAS 注册', 'nas.onlined': 'NAS 上线', 'nas.offlined': 'NAS 下线',
    'skill.published': 'Skill 上架', 'skill.submitted': 'Skill 提交', 'skill.installed': 'Skill 安装', 'skill.deprecated': 'Skill 弃用',
    'agent.registered': 'Agent 注册', 'agent.onlined': 'Agent 上线', 'agent.offlined': 'Agent 下线',
    'app.registered': '应用注册', 'app.onlined': '应用发布', 'app.offlined': '应用下架', 'app.updated': '应用更新', 'app.archived': '应用归档',
    'approval.created': '新建审批', 'approval.decided': '审批决策',
    'audit.alert.fired': '触发告警',
    'market.plugin.submitted': '插件提交', 'market.plugin.listed': '插件上架', 'market.plugin.installed': '插件安装',
    'wallet.balance.changed': '钱包余额变动', 'billing.ledger.settled': '账单结算',
    'connect.code.created': '接入码生成', 'connect.client.enrolled': '客户端接入', 'connect.client.disabled': '客户端停用',
    'platform.update.available': '发现平台更新', 'platform.update.applied': '平台更新完成',
  }
  if (d.recentEvents?.length) {
    eventsEl.innerHTML = d.recentEvents.slice(0, 7).map((event) => `
      <div class="flex" style="padding:8px 0;border-bottom:1px solid var(--border)">
        <span class="badge ${eventBadgeClass(event.name)} no-dot" style="min-width:72px;justify-content:center">${esc(eventLabel(event.name, EVENT_LABELS))}</span>
        <span class="fs-12 ellipsis grow">${esc(event.payload || '—')}${event.detail ? `
          <details class="evt-detail"><summary>详情</summary><code>${esc(event.detail)}</code></details>` : ''}</span>
        <span class="fs-11 text-4">${timeAgo(event.at)}</span>
      </div>`).join('')
  } else {
    eventsEl.innerHTML = emptyRow('zap', '暂无事件', '平台事件将实时显示在这里')
  }
}

/** 事件名中文标签：字典命中优先；未收录事件按分段转译兜底（新事件不裸奔英文）。 */
function eventLabel(name, labels) {
  if (labels[name]) return labels[name]
  const SEGMENTS = {
    iam: '账号', authn: '认证', oidc: '单点登录', mcp: 'MCP', nas: 'NAS', audit: '审计',
    skill: '技能', agent: '智能体', app: '应用', usage: '用量', billing: '计费', market: '市场',
    wallet: '钱包', platform: '平台', approval: '审批', connector: '连接器', console: '控制台', connect: '接入',
    user: '用户', org: '组织', permission: '权限', token: '令牌', gateway: '网关', permgroup: '权限组',
    created: '创建', changed: '变更', issued: '签发', revoked: '吊销', deployed: '发布', onlined: '上线',
    offlined: '下线', unhealthy: '异常', invoked: '调用', connected: '连接', disconnected: '断开',
    submitted: '提交', published: '上架', installed: '安装', deprecated: '弃用', registered: '注册',
    updated: '更新', archived: '归档', granted: '通过', denied: '拒绝', fired: '触发', synced: '同步',
    available: '可更新', applied: '已应用', settled: '结算', enrolled: '接入', disabled: '停用', frozen: '冻结', activated: '启用',
  }
  const translated = name.split('.').map((seg) => SEGMENTS[seg] ?? seg).join(' · ')
  return translated === name ? name : translated
}

function eventBadgeClass(name) {
  if (name.includes('unhealthy') || name.includes('alert') || name.includes('frozen') || name.includes('revoked') || name.includes('offlined') || name.includes('offline') || name.includes('deprecated')) return 'badge-danger'
  if (name.includes('deployed') || name.includes('published') || name.includes('onlined') || name.includes('registered')) return 'badge-ok'
  if (name.includes('approval')) return 'badge-warn'
  return 'badge-muted'
}

function statCard(ic, label, value, foot, color, bg, href, footTitle) {
  return `
    <div class="stat-card" data-href="${href}">
      <div class="stat-icon" style="background:${bg};color:${color}">${icon(ic, 18)}</div>
      <div class="stat-value">${value}</div>
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-foot">${esc(foot)}${footTitle ? `<span class="stat-foot-info" title="${esc(footTitle)}" onclick="event.stopPropagation()">${icon('info', 12)}</span>` : ''}</div>
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
