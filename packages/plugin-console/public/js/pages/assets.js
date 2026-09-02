/** 资产运营：企业 AI 资产统一台账 / 健康巡检 / 成本报表。 */
import { api } from '../api.js'
import { icon } from '../icons.js'
import { $, esc, toast, statusBadge } from '../ui.js'
import { filterAssets, platformFacets, assetPlatform } from '../asset-filters.js'

const TYPE_META = {
  mcp: ['MCP 服务', 'plug'],
  agent: ['Agent', 'bot'],
  app: ['AI 应用', 'app'],
  skill: ['Skill', 'sparkles'],
  model: ['模型路由', 'zap'],
  nas: ['NAS 存储', 'server'],
}

/** 金额（分）→ 元展示。 */
const fmtCents = (cents) => `¥${(cents / 100).toFixed(2)}`

// UI-06：生命周期/健康码统一改用 ui.js 的中文徽标（statusBadge，online→已上线、degraded→降级…），
// 不再直接渲染英文码。
function healthBadge(health) {
  return statusBadge(health ?? 'unknown')
}

/** 类型徽章：小图标 + 名称。 */
function typeBadge(type) {
  const meta = TYPE_META[type]
  return `<span class="badge badge-muted no-dot">${icon(meta?.[1] ?? 'box', 12)} ${esc(meta?.[0] ?? type)}</span>`
}

/** 负责人：圆形首字母头像 + 名字。 */
function ownerCell(owner) {
  if (!owner) return '<span class="fs-12 text-4">—</span>'
  const initial = esc(owner.trim().charAt(0).toUpperCase() || '?')
  return `<span class="owner-cell"><span class="avatar-sm">${initial}</span><span class="fs-12 ellipsis">${esc(owner)}</span></span>`
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
  const [inv, report, benefit, retire] = await Promise.all([
    api.get(`/api/assets/inventory?days=${days}${typeFilter ? `&type=${typeFilter}` : ''}`),
    api.get(`/api/assets/report?days=${days}`),
    api.get(`/api/assets/benefit?days=${days}`),
    api.get('/api/assets/retire-reasons?days=90'),
  ])

  content.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">资产运营</div>
        <div class="page-desc">企业 AI 资产统一台账：MCP 服务 / Agent / AI 应用 / Skill / 模型路由 / NAS 存储 一处盘点，运营口径的用量与成本一屏可见。</div>
      </div>
      <div class="page-actions">
        <select id="asset-days" class="input" style="width:auto">
          ${[7, 14, 30, 90].map((d) => `<option value="${d}" ${String(d) === String(days) ? 'selected' : ''}>近 ${d} 天</option>`).join('')}
        </select>
        <button class="btn" id="btn-healthcheck">${icon('activity', 14)} 健康巡检</button>
      </div>
    </div>

    <div class="stat-grid mb-20">
      <div class="stat-card">
        <div class="stat-icon" style="background:var(--brand-50);color:var(--brand-500)">${icon('layers', 18)}</div>
        <div class="stat-value">${inv.items.length}</div>
        <div class="stat-label">纳管资产</div>
        <div class="stat-foot">${Object.entries(inv.summary.byType).map(([t, v]) => `${TYPE_META[t]?.[0] ?? t} ${v.total}`).join(' · ')}</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon" style="background:var(--ok-bg);color:#047857">${icon('activity', 18)}</div>
        <div class="stat-value">${Object.values(inv.summary.byType).reduce((s, v) => s + v.inService, 0)}</div>
        <div class="stat-label">在服务资产</div>
        <div class="stat-foot">已上线 / 灰度中 / 已上架</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon" style="background:${inv.summary.unhealthy > 0 ? 'var(--danger-bg)' : 'var(--ok-bg)'};color:${inv.summary.unhealthy > 0 ? '#b91c1c' : '#047857'}">${icon(inv.summary.unhealthy > 0 ? 'alert' : 'shieldCheck', 18)}</div>
        <div class="stat-value" style="color:${inv.summary.unhealthy > 0 ? 'var(--danger)' : 'inherit'}">${inv.summary.unhealthy}</div>
        <div class="stat-label">健康异常</div>
        <div class="stat-foot">不可用 / 降级</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon" style="background:var(--purple-bg);color:#6d28d9">${icon('coins', 18)}</div>
        <div class="stat-value">${fmtCents(inv.summary.chargeCents30d)}</div>
        <div class="stat-label">${esc(days)} 天资产消耗</div>
        <div class="stat-foot">计量口径（列表价含税）</div>
      </div>
    </div>

    <div class="grid-2 mb-20" style="grid-template-columns:1.1fr 1fr;align-items:start">
      <div class="card">
        <div class="card-head"><span class="card-title">${icon('zap', 15)} 消耗 Top 资产</span><span class="card-sub">近 ${esc(days)} 天 · 计量口径</span></div>
        <div class="card-body" style="padding-top:8px">
          ${report.topResources.slice(0, 8).map((row, i) => `
            <div class="flex" style="padding:9px 0;border-bottom:1px solid var(--border);gap:10px;align-items:center">
              <span class="rank ${i < 3 ? 'rank-top' : ''}">${i + 1}</span>
              <span class="fs-13 ellipsis" style="max-width:40%">${esc(row.label)}</span>
              <span class="fs-11 text-4 mono grow ellipsis">${esc(row.resource)}</span>
              <span class="fs-12 col-num" style="font-weight:600">${fmtCents(row.charge_cents)}</span>
              <span class="fs-11 text-4 col-num" style="min-width:56px;text-align:right">${row.count} 次</span>
            </div>`).join('') || '<span class="text-4 fs-12">暂无计量数据</span>'}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><span class="card-title">${icon('trending', 15)} 日消耗趋势</span><span class="card-sub">全资产合计</span></div>
        <div class="card-body">${trendSvg(report.byDay)}</div>
      </div>
    </div>

    <div class="grid-2 mb-20" style="grid-template-columns:1.35fr 1fr;align-items:start">
      <div class="card">
        <div class="card-head">
          <span class="card-title">${icon('coins', 15)} 效益分析</span>
          <span class="card-sub">毛利 = 列表价收入 − 采购成本 · 近 ${esc(days)} 天</span>
        </div>
        <div class="card-body" style="padding:10px 8px 14px">
          <div class="flex mb-10" style="gap:18px;padding:0 6px">
            <span class="fs-12 text-4">收入 <b class="fs-14" style="color:var(--text-1)">${fmtCents(benefit.totals.charge_cents)}</b></span>
            <span class="fs-12 text-4">成本 <b class="fs-14" style="color:var(--text-1)">${fmtCents(benefit.totals.cost_cents)}</b></span>
            <span class="fs-12 text-4">毛利 <b class="fs-14" style="color:${benefit.totals.margin_cents >= 0 ? 'var(--ok, #047857)' : 'var(--danger)'}">${fmtCents(benefit.totals.margin_cents)}</b></span>
          </div>
          <div class="table-wrap">
            <table class="tbl">
              <thead><tr><th>资产</th><th style="text-align:right">调用</th><th style="text-align:right">收入</th><th style="text-align:right">成本</th><th style="text-align:right">毛利</th><th style="text-align:right">单位 DAU 成本</th></tr></thead>
              <tbody>
                ${benefit.rows.length ? benefit.rows.slice(0, 10).map((row) => `
                  <tr>
                    <td><div class="col-strong">${esc(row.label)}</div><div class="col-sub mono">${esc(row.resource)}</div></td>
                    <td class="col-num fs-12" style="text-align:right">${row.count}</td>
                    <td class="col-num fs-12" style="text-align:right">${fmtCents(row.charge_cents)}</td>
                    <td class="col-num fs-12" style="text-align:right">${fmtCents(row.cost_cents)}</td>
                    <td class="col-num fs-12" style="text-align:right;font-weight:600;color:${row.margin_cents >= 0 ? 'inherit' : 'var(--danger)'}">${fmtCents(row.margin_cents)}</td>
                    <td class="col-num fs-12" style="text-align:right">${row.cost_per_dau_cents !== null && row.cost_per_dau_cents !== undefined ? fmtCents(row.cost_per_dau_cents) : '—'}</td>
                  </tr>`).join('') : `
                  <tr><td colspan="6"><div class="tbl-empty">${icon('coins', 28)}<span>窗口内暂无计量事件（毛利随调用累积）</span></div></td></tr>`}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:16px">
        <div class="card">
          <div class="card-head"><span class="card-title">${icon('users', 15)} 主体分摊（谁在用）</span><span class="card-sub">近 ${esc(days)} 天</span></div>
          <div class="card-body" style="padding-top:8px">
            ${report.byPrincipal.slice(0, 6).map((row) => {
              const max = Math.max(...report.byPrincipal.map((r) => r.charge_cents), 1)
              return `
                <div style="padding:7px 0">
                  <div class="flex fs-12" style="margin-bottom:3px"><span class="ellipsis" style="max-width:60%">${esc(row.label)}</span><span style="margin-left:auto;font-weight:600">${fmtCents(row.charge_cents)}</span></div>
                  <div style="height:6px;border-radius:3px;background:var(--surface-2);overflow:hidden">
                    <div style="height:100%;width:${Math.max((row.charge_cents / max) * 100, 2)}%;border-radius:3px;background:linear-gradient(90deg,#4f6ef7,#7c5cf5)"></div>
                  </div>
                </div>`
            }).join('') || '<span class="text-4 fs-12">暂无计量数据</span>'}
          </div>
        </div>
        <div class="card">
          <div class="card-head"><span class="card-title">${icon('alert', 15)} 下架分析</span><span class="card-sub">近 90 天 · 原因聚合</span></div>
          <div class="card-body" style="padding-top:8px">
            ${retire.reasons?.length ? retire.reasons.slice(0, 5).map((row) => `
              <div class="flex" style="padding:7px 0;border-bottom:1px solid var(--border);gap:8px;align-items:flex-start">
                <span class="badge badge-muted no-dot" style="flex-shrink:0">${row.count} 次</span>
                <span class="grow">
                  <span class="fs-12" style="display:block">${esc(row.reason)}</span>
                  <span class="fs-11 text-4">${Object.entries(row.byType).map(([t, n]) => `${TYPE_META[t]?.[0] ?? t} ${n}`).join(' · ')}${row.samples?.[0] ? ` · 最近 ${esc(row.samples[0].name)}` : ''}</span>
                </span>
              </div>`).join('') : '<span class="text-4 fs-12">窗口内无下架/弃用记录</span>'}
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <span class="card-title">${icon('layers', 15)} 资产目录（<span id="asset-count">${inv.items.length}</span>）</span>
        <div class="card-head-actions">
          <div class="search-input">${icon('search')}<input id="asset-q" class="input" placeholder="搜索名称 / 组织 / 负责人…" style="width:200px" value="${esc(params.get('q') ?? '')}"></div>
        </div>
      </div>
      <div class="card-body" style="padding-top:6px">
        <div class="asset-chips" id="asset-chips">
          <span class="fs-12 text-4" style="margin-right:4px">类型</span>
          <button class="chip active" data-filter="type" data-value="">全部</button>
          ${Object.entries(TYPE_META).map(([t, meta]) => `<button class="chip" data-filter="type" data-value="${t}">${meta[0]}</button>`).join('')}
          <span class="fs-12 text-4" style="margin:0 4px 0 12px">平台</span>
          ${platformFacets(inv.items).map((platform) => `<button class="chip" data-filter="platform" data-value="${esc(platform)}">${esc(platform)}</button>`).join('')}
        </div>
        <div class="asset-flow" id="asset-flow"></div>
      </div>
    </div>`

  // 客户端筛选（单请求 + 纯函数过滤，1000 项毫秒级）；筛选状态仅存内存，刷新回落全量
  const filters = { type: typeFilter, platform: '', q: params.get('q') ?? '' }
  const renderFlow = () => {
    const items = filterAssets(inv.items, filters)
    const holder = $('#asset-flow')
    if (!holder) return
    $('#asset-count').textContent = String(items.length)
    holder.innerHTML = items.length ? items.map((item) => `
      <div class="asset-card" ${item.type === 'nas' ? `data-nas-id="${esc(item.id)}" title="打开 NAS 详情"` : ''} role="listitem">
        <div class="flex" style="gap:12px;align-items:center">
          <div style="width:34px;height:34px;border-radius:9px;background:var(--brand-50);color:var(--brand-500);display:grid;place-items:center;flex-shrink:0">${icon(TYPE_META[item.type]?.[1] ?? 'box', 16)}</div>
          <div class="grow" style="min-width:0">
            <div class="flex" style="gap:8px;align-items:center">
              <span class="fs-13" style="font-weight:600">${esc(item.name)}</span>
              ${typeBadge(item.type)}
              ${statusBadge(item.status)}
              ${healthBadge(item.health)}
              ${item.platform && item.platform !== '' ? `<span class="badge badge-muted no-dot">${esc(item.platform)}</span>` : ''}
            </div>
            <div class="fs-11 text-4 ellipsis" style="margin-top:3px">${esc(item.org)} · ${esc(item.owner || '—')} · ${item.calls} 次 / ${esc(days)} 天 · ${item.chargeCents > 0 ? fmtCents(item.chargeCents) : '无消耗'}</div>
          </div>
          ${item.type === 'nas' ? `<span class="fs-12" style="color:var(--brand-500);flex-shrink:0">详情 ›</span>` : ''}
        </div>
      </div>`).join('') : `
      <div class="tbl-empty">${icon('search', 28)}<span>暂无匹配资产，试试调整筛选或搜索</span></div>`
    holder.querySelectorAll('[data-nas-id]').forEach((el) => {
      el.onclick = () => { location.hash = `#/nas?focus=${encodeURIComponent(el.dataset.nasId)}` }
    })
  }
  renderFlow()
  $('#asset-chips').querySelectorAll('.chip').forEach((chip) => {
    chip.onclick = () => {
      const group = chip.dataset.filter
      filters[group] = chip.dataset.value
      $('#asset-chips').querySelectorAll(`.chip[data-filter="${group}"]`).forEach((item) => item.classList.toggle('active', item === chip))
      renderFlow()
    }
  })
  const go = (extra) => {
    const p = new URLSearchParams()
    p.set('days', $('#asset-days').value)
    const q = $('#asset-q').value.trim()
    if (q) p.set('q', q)
    if (extra) for (const [k, v] of Object.entries(extra)) p.set(k, v)
    location.hash = `#/assets?${p.toString()}`
  }
  $('#asset-days').onchange = () => go()
  let debounce
  $('#asset-q').oninput = () => {
    clearTimeout(debounce)
    debounce = setTimeout(() => { filters.q = $('#asset-q').value.trim(); renderFlow() }, 250)
  }
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
