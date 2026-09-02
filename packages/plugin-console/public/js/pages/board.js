/** 老板战略视图（WP-12 看板 v1）：数据全部来自 portal 只读聚合端点（不开特权接口）。 */
import { api } from '../api.js'
import { icon } from '../icons.js'
import { $, esc, timeAgo } from '../ui.js'

const fmtInt = (value) => new Intl.NumberFormat('zh-CN').format(Number(value ?? 0))

export async function renderBoard(content) {
  content.innerHTML = `<div style="padding:60px;text-align:center;color:var(--text-4)">看板加载中…</div>`
  let board
  try {
    // 走 portal 只读端点（公开聚合，零 PII）：与门户/大屏同一数据面，不申请任何特权权限。
    // portal 契约包装为 {code,message,data}——api.get 兼容解析出 data。
    board = await api.get('/api/portal/board')
    if (!board) throw new Error('看板数据不可用')
  } catch (error) {
    content.innerHTML = `<div class="card card-pad">${esc(error.message)}</div>`
    return
  }

  const funnel = board.funnel ?? {}
  const funnelRows = [
    ['卡片曝光', funnel.exposed, 'behavior：场景卡片区曝光'],
    ['卡片点击', funnel.clicked, 'behavior：点击直达功能页'],
    ['资产调用', funnel.invoked, 'usage：窗口内计量事件'],
    ['调用完成', funnel.completed, 'mcp：ok 调用记录'],
  ]
  const funnelMax = Math.max(...funnelRows.map(([, value]) => Number(value ?? 0)), 1)
  const byDay = board.byDay ?? []

  content.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">战略看板</div>
        <div class="page-desc">老板视图：数据来自门户只读聚合通道（/api/portal/board），窗口近 ${board.windowDays ?? 7} 天，生成于 ${timeAgo(board.generatedAt)}。</div>
      </div>
    </div>

    <div class="stat-grid mb-20">
      ${boardKpi('app', 'AI 应用在线', board.assets?.appsOnline, 'var(--brand-50)', 'var(--brand-500)')}
      ${boardKpi('bot', '数字员工在线', board.assets?.agentsOnline, 'var(--purple-bg)', '#6d28d9')}
      ${boardKpi('sparkles', 'Skill 已上架', board.assets?.skillsPublished, 'var(--warn-bg)', '#b45309')}
      ${boardKpi('plug', 'MCP 在服', board.assets?.mcpServing, 'var(--ok-bg)', '#047857')}
      ${boardKpi('coins', 'WAIC 周消耗', `¥${((board.waic?.chargeCents ?? 0) / 100).toFixed(2)}`, 'var(--info-bg)', '#1d4ed8')}
    </div>

    <div class="grid-2 mb-20" style="grid-template-columns:1.2fr 1fr;align-items:start">
      <div class="card">
        <div class="card-head"><span class="card-title">${icon('trending', 15)} 转化漏斗（behavior + usage 联合口径）</span></div>
        <div class="card-body">
          ${funnelRows.map(([label, value, source]) => `
            <div style="padding:9px 0">
              <div class="flex fs-13" style="margin-bottom:4px"><span>${label}</span>
                <span style="margin-left:auto;font-weight:700">${fmtInt(value)}</span></div>
              <div style="height:10px;border-radius:5px;background:var(--surface-2);overflow:hidden" title="${esc(source)}">
                <div style="height:100%;width:${Math.max((Number(value ?? 0) / funnelMax) * 100, 2)}%;border-radius:5px;background:var(--brand-gradient)"></div>
              </div>
              <div class="fs-11 text-4" style="margin-top:2px">${esc(source)}</div>
            </div>`).join('')}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><span class="card-title">${icon('activity', 15)} 周调用趋势</span><span class="card-sub">usage 按日</span></div>
        <div class="card-body">
          ${byDay.length ? byDay.map((row) => `
            <div class="flex" style="padding:8px 0;border-bottom:1px solid var(--border)">
              <span class="fs-12 mono text-3">${esc(row.day)}</span>
              <span class="fs-12 grow" style="margin-left:12px">${fmtInt(row.count)} 次</span>
              <span class="fs-12 col-num" style="font-weight:600">¥${(row.charge_cents / 100).toFixed(2)}</span>
            </div>`).join('') : '<span class="text-4 fs-12">窗口内无计量数据</span>'}
        </div>
      </div>
    </div>

    <div class="card card-pad">
      <div class="fs-12 text-3">指标口径（D3 定版）：WAIC=usage 周聚合；漏斗=behavior（曝光/点击）+ usage（调用）+ mcp（完成）联合；
      审批周期见「审批中心」SLA 看板；熔断/恢复以 MCP 健康探活为准。本看板仅消费公开聚合端点，无任何个人级数据。</div>
    </div>`
}

function boardKpi(iconName, label, value, bg, color) {
  return `
    <div class="stat-card">
      <div class="stat-icon" style="background:${bg};color:${color}">${icon(iconName, 18)}</div>
      <div class="stat-value">${esc(String(value ?? 0))}</div>
      <div class="stat-label">${esc(label)}</div>
    </div>`
}
