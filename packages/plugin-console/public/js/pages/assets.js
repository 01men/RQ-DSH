/** 资产运营：企业 AI 资产统一台账 / 健康巡检 / 成本报表。 */
import { api } from '../api.js'
import { icon } from '../icons.js'
import { $, esc, toast } from '../ui.js'

const TYPE_META = {
  mcp: ['MCP 服务', 'plug'],
  agent: ['Agent', 'bot'],
  app: ['AI 应用', 'app'],
  skill: ['Skill', 'sparkles'],
  model: ['模型路由', 'zap'],
}

/** 金额（分）→ 元展示。 */
const fmtCents = (cents) => `¥${(cents / 100).toFixed(2)}`

function statusBadge(status) {
  const tone = ['online', 'published', 'healthy'].includes(status) ? 'badge-ok'
    : ['gray', 'trial'].includes(status) ? 'badge-info'
    : ['offline', 'down', 'unhealthy'].includes(status) ? 'badge-danger'
    : ['draft', 'pending', 'pending_approval'].includes(status) ? 'badge-warn' : 'badge-muted'
  return `<span class="badge ${tone} no-dot">${esc(status)}</span>`
}

function healthBadge(health) {
  const tone = health === 'healthy' ? 'badge-ok' : health === 'degraded' ? 'badge-warn' : health === 'down' ? 'badge-danger' : 'badge-muted'
  return `<span class="badge ${tone} no-dot">${esc(health ?? 'unknown')}</span>`
}

function trendSvg(byDay) {
  if (!byDay.length) return '<span class="text-4 fs-12">窗口内无计量数据</span>'
  const max = Math.max(...byDay.map((d) => d.charge_cents), 1)
  const w = 100
  const points = byDay.map((d, i) => `${(i / Math.max(byDay.length - 1, 1)) * w},${28 - (d.charge_cents / max) * 24}`)
  return `
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" style="width:100%;height:64px;display:block">
      <polyline points="${points.join(' ')}" fill="none" stroke="var(--brand-500)" stroke-width="1.4" vector-effect="non-scaling-stroke"/>
      <polyline points="0,30 ${points.join(' ')} 100,30" fill="var(--brand-500)" opacity="0.08" stroke="none"/>
    </svg>
    <div class="flex fs-11 text-4" style="justify-content:space-between;margin-top:2px">
      <span>${esc(byDay[0]?.day ?? '')}</span><span>峰值 ${(max / 100).toFixed(2)} 元/日</span><span>${esc(byDay[byDay.length - 1]?.day ?? '')}</span>
    </div>`
}

export async function renderAssets(content, params, { rerender }) {
  const days = params.get('days') ?? 30
  const typeFilter = params.get('type') ?? ''
  const [inv, report] = await Promise.all([
    api.get(`/api/assets/inventory?days=${days}${typeFilter ? `&type=${typeFilter}` : ''}`),
    api.get(`/api/assets/report?days=${days}`),
  ])

  content.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">资产运营</div>
        <div class="page-desc">企业 AI 资产统一台账：MCP 服务 / Agent / AI 应用 / Skill / 模型路由 一处盘点，运营口径的用量与成本一屏可见。</div>
      </div>
      <div class="page-actions">
        <select id="asset-days" class="input" style="width:auto">
          ${[7, 14, 30, 90].map((d) => `<option value="${d}" ${String(d) === String(days) ? 'selected' : ''}>近 ${d} 天</option>`).join('')}
        </select>
        <button class="btn" id="btn-healthcheck">${icon('activity', 14)} 健康巡检</button>
      </div>
    </div>

    <div class="stat-grid mb-20">
      <div class="stat-card"><div class="stat-label">纳管资产</div><div class="stat-value">${inv.items.length}</div><div class="stat-foot">${Object.entries(inv.summary.byType).map(([t, v]) => `${TYPE_META[t]?.[0] ?? t} ${v.total}`).join(' · ')}</div></div>
      <div class="stat-card"><div class="stat-label">在服务资产</div><div class="stat-value">${Object.values(inv.summary.byType).reduce((s, v) => s + v.inService, 0)}</div><div class="stat-foot">online / gray / published</div></div>
      <div class="stat-card"><div class="stat-label">健康异常</div><div class="stat-value" style="color:${inv.summary.unhealthy > 0 ? 'var(--danger)' : 'inherit'}">${inv.summary.unhealthy}</div><div class="stat-foot">down / degraded</div></div>
      <div class="stat-card"><div class="stat-label">${esc(days)} 天资产消耗</div><div class="stat-value">${fmtCents(inv.summary.chargeCents30d)}</div><div class="stat-foot">计量口径（列表价含税）</div></div>
    </div>

    <div class="grid-2 mb-20" style="grid-template-columns:1.1fr 1fr;align-items:start">
      <div class="card">
        <div class="card-head"><span class="card-title">${icon('zap', 15)} 消耗 Top 资产</span><span class="card-sub">近 ${esc(days)} 天 · 计量口径</span></div>
        <div class="card-body" style="padding-top:8px">
          ${report.topResources.slice(0, 8).map((row) => `
            <div class="flex" style="padding:8px 0;border-bottom:1px solid var(--border);gap:8px">
              <span class="fs-13 ellipsis" style="max-width:44%">${esc(row.label)}</span>
              <span class="fs-11 text-4 mono grow">${esc(row.resource)}</span>
              <span class="fs-12" style="font-weight:600">${fmtCents(row.charge_cents)}</span>
              <span class="fs-11 text-4" style="min-width:56px;text-align:right">${row.count} 次</span>
            </div>`).join('') || '<span class="text-4 fs-12">暂无计量数据</span>'}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><span class="card-title">${icon('trending', 15)} 日消耗趋势</span><span class="card-sub">全资产合计</span></div>
        <div class="card-body">${trendSvg(report.byDay)}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <span class="card-title">${icon('layers', 15)} 资产台账（${inv.total}）</span>
        <div class="flex" style="gap:8px">
          <input id="asset-q" class="input" placeholder="搜索名称 / 组织 / 负责人…" style="width:220px" value="${esc(params.get('q') ?? '')}">
          <select id="asset-type" class="input" style="width:auto">
            <option value="">全部类型</option>
            ${Object.entries(TYPE_META).map(([t, meta]) => `<option value="${t}" ${typeFilter === t ? 'selected' : ''}>${meta[0]}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="card-body" style="padding-top:0">
        <table class="table">
          <thead><tr><th>资产</th><th>类型</th><th>状态</th><th>健康</th><th>归属组织</th><th>负责人</th><th style="text-align:right">近 ${esc(days)} 天调用</th><th style="text-align:right">消耗</th></tr></thead>
          <tbody>
            ${inv.items.map((item) => `
              <tr>
                <td><div class="fs-13" style="font-weight:600">${esc(item.name)}</div><div class="fs-11 text-4 mono">${esc(item.slug ?? '')}</div></td>
                <td><span class="badge badge-muted no-dot">${TYPE_META[item.type]?.[0] ?? item.type}</span></td>
                <td>${statusBadge(item.status)}</td>
                <td>${healthBadge(item.health)}</td>
                <td class="fs-12">${esc(item.org)}</td>
                <td class="fs-12">${esc(item.owner)}</td>
                <td class="fs-12" style="text-align:right">${item.calls}</td>
                <td class="fs-13" style="text-align:right;font-weight:600">${item.chargeCents > 0 ? fmtCents(item.chargeCents) : '—'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`

  const go = (extra) => {
    const p = new URLSearchParams()
    p.set('days', $('#asset-days').value)
    if ($('#asset-type').value) p.set('type', $('#asset-type').value)
    const q = $('#asset-q').value.trim()
    if (q) p.set('q', q)
    if (extra) for (const [k, v] of Object.entries(extra)) p.set(k, v)
    location.hash = `#/assets?${p.toString()}`
  }
  $('#asset-days').onchange = () => go()
  $('#asset-type').onchange = () => go()
  let debounce
  $('#asset-q').oninput = () => { clearTimeout(debounce); debounce = setTimeout(() => go(), 300) }
  $('#btn-healthcheck').onclick = async (e) => {
    const btn = e.currentTarget
    btn.disabled = true
    btn.textContent = '巡检中…'
    try {
      const result = await api.post('/api/assets/healthcheck')
      toast(`巡检完成：${result.checked} 项资产，异常 ${result.abnormal} 项`, result.abnormal > 0 ? 'error' : 'success')
      rerender()
    } catch (error) {
      toast(`巡检失败：${error.message}`, 'error')
      btn.disabled = false
      btn.textContent = '健康巡检'
    }
  }
}
