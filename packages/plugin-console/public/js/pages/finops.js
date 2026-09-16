/** FinOps 财务视图（M2 CFO 视图 v1）：成本穿透 + 环比 + 空转检测，内部成本参考口径。 */
import { api } from '../api.js'
import { icon } from '../icons.js'
import { $, esc, toast, fmtNum, fmtCost } from '../ui.js'

/** 环比徽标：涨红降绿（成本视角），无可比基数显示 —。 */
function deltaBadge(deltaPct) {
  if (deltaPct === null || deltaPct === undefined) return '<span class="fs-12 text-4">—</span>'
  if (deltaPct === 0) return '<span class="fs-12 text-4">持平</span>'
  const up = deltaPct > 0
  return `<span class="badge no-dot" style="${up ? 'background:var(--danger-bg);color:#b91c1c' : 'background:var(--ok-bg);color:#047857'}">${up ? icon('arrowUp', 11) : icon('arrowDown', 11)} ${Math.abs(deltaPct)}%</span>`
}

function emptyRow(cols, text) {
  return `<tr><td colspan="${cols}"><div class="tbl-empty">${icon('chart', 28)}<span>${esc(text)}</span></div></td></tr>`
}

export async function renderFinops(content, params, { rerender }) {
  const month = params.get('month') || new Date().toISOString().slice(0, 7)
  let data
  try {
    data = await api.get(`/api/finops/overview?month=${encodeURIComponent(month)}`)
  } catch (error) {
    content.innerHTML = `
      <div class="page-head"><div><div class="page-title">FinOps 财务视图</div></div></div>
      <div class="card"><div class="card-body"><div class="tbl-empty">${icon('alert', 28)}<span>报表加载失败：${esc(error.message)}</span></div>
      <div style="text-align:center"><button class="btn" id="finops-retry">${icon('refresh', 14)} 重试</button></div></div></div>`
    $('#finops-retry').onclick = () => rerender()
    return
  }
  const { penetration, idle } = data
  const dimTotal = penetration.totals

  const modelCount = penetration.byModel.length
  const orgCount = penetration.byOrg.length

  content.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">FinOps 财务视图</div>
        <div class="page-desc">给管理者的一页纸：钱花在哪（部门 × 模型成本穿透）、花得值不值（空转检测）。
        金额为<b>内部成本参考</b>（零价快照口径，不对外结算）。</div>
      </div>
      <div class="page-actions">
        <input type="month" id="finops-month" class="input" style="width:auto" value="${esc(month)}" max="${esc(new Date().toISOString().slice(0, 7))}">
        <a class="btn" id="finops-csv" href="/api/finops/report/monthly?month=${encodeURIComponent(month)}&format=csv" title="导出本报表 CSV（Excel 可直接打开）">${icon('download', 14)} 导出 CSV</a>
      </div>
    </div>

    <div class="stat-grid mb-20">
      <div class="stat-card">
        <div class="stat-icon" style="background:var(--purple-bg);color:#6d28d9">${icon('coins', 18)}</div>
        <div class="stat-value">${fmtCost(dimTotal.cost_cents / 100)}</div>
        <div class="stat-label">本月内部成本</div>
        <div class="stat-foot">上月同期 ${fmtCost(dimTotal.prev_cost_cents / 100)} · ${deltaBadge(dimTotal.delta_pct)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon" style="background:var(--brand-50);color:var(--brand-500)">${icon('zap', 18)}</div>
        <div class="stat-value">${fmtNum(dimTotal.events)}</div>
        <div class="stat-label">计量事件</div>
        <div class="stat-foot">tokens 合计 ${fmtNum(dimTotal.tokens)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon" style="background:${idle.idle.cost_cents > 0 ? 'var(--danger-bg)' : 'var(--ok-bg)'};color:${idle.idle.cost_cents > 0 ? '#b91c1c' : '#047857'}">${icon('wifi', 18)}</div>
        <div class="stat-value">${fmtCost(idle.idle.cost_cents / 100)}</div>
        <div class="stat-label">疑似空转成本</div>
        <div class="stat-foot">占模型调用成本 ${idle.idle.share_pct}% · ${idle.idle.events} 次调用</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon" style="background:var(--ok-bg);color:#047857">${icon('building', 18)}</div>
        <div class="stat-value">${orgCount} <span class="fs-14 text-4">部门</span> / ${modelCount} <span class="fs-14 text-4">模型</span></div>
        <div class="stat-label">参与消耗的维度</div>
        <div class="stat-foot">${modelCount > 0 ? `成本最高模型：${esc(penetration.byModel[0].dimension)}` : '本月暂无模型消耗'}</div>
      </div>
    </div>

    <div class="grid-2 mb-20" style="grid-template-columns:1.4fr 1fr;align-items:start">
      <div class="card">
        <div class="card-head"><span class="card-title">${icon('building', 15)} 部门成本穿透</span><span class="card-sub">${esc(penetration.month)} · 按成本降序</span></div>
        <div class="card-body" style="padding-top:6px">
          <div class="table-wrap">
            <table class="tbl">
              <thead><tr><th>部门</th><th style="text-align:right">调用</th><th style="text-align:right">tokens</th><th style="text-align:right">内部成本</th><th style="text-align:right">环比上月</th><th>主要模型</th></tr></thead>
              <tbody>
                ${penetration.byOrg.length ? penetration.byOrg.slice(0, 12).map((row) => `
                  <tr>
                    <td><div class="col-strong">${esc(row.dimension || '（未归口）')}</div></td>
                    <td class="col-num fs-12" style="text-align:right">${fmtNum(row.events)}</td>
                    <td class="col-num fs-12" style="text-align:right">${fmtNum(row.tokens)}</td>
                    <td class="col-num fs-12" style="text-align:right;font-weight:600">${fmtCost(row.cost_cents / 100)}</td>
                    <td class="col-num" style="text-align:right">${deltaBadge(row.delta_pct)}</td>
                    <td class="fs-11 text-4">${(row.topModels ?? []).map((m) => `<div class="mono" style="white-space:nowrap">${esc(m.model)} <span class="text-4">${m.share}%</span></div>`).join('') || '—'}</td>
                  </tr>`).join('') : emptyRow(6, `${penetration.month} 暂无计量数据——资产开始调用后成本自动累积`)}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><span class="card-title">${icon('bot', 15)} 模型成本排行</span><span class="card-sub">${esc(penetration.month)}</span></div>
        <div class="card-body" style="padding-top:8px">
          ${penetration.byModel.length ? penetration.byModel.slice(0, 8).map((row) => {
            const max = Math.max(...penetration.byModel.map((r) => r.cost_cents), 1)
            return `
              <div style="padding:7px 0">
                <div class="flex fs-12" style="margin-bottom:3px;gap:8px">
                  <span class="ellipsis mono" style="max-width:45%">${esc(row.dimension)}</span>
                  ${deltaBadge(row.delta_pct)}
                  <span style="margin-left:auto;font-weight:600">${fmtCost(row.cost_cents / 100)}</span>
                </div>
                <div style="height:6px;border-radius:3px;background:var(--surface-2);overflow:hidden">
                  <div style="height:100%;width:${Math.max((row.cost_cents / max) * 100, 2)}%;border-radius:3px;background:linear-gradient(90deg,#4f6ef7,#7c5cf5)"></div>
                </div>
              </div>`
          }).join('') : `<div class="tbl-empty">${icon('bot', 28)}<span>${penetration.month} 暂无模型调用计量</span></div>`}
        </div>
      </div>
    </div>

    <div class="card mb-20">
      <div class="card-head"><span class="card-title">${icon('chart', 15)} 部门 × 模型成本矩阵</span><span class="card-sub">内部成本（分）· Top 8 × Top 8 + 其他</span></div>
      <div class="card-body" style="padding-top:6px">
        ${(() => {
          const { orgs, models, cells } = penetration.matrix
          if (!orgs.length || !models.length) return `<div class="tbl-empty">${icon('chart', 28)}<span>${penetration.month} 暂无数据</span></div>`
          const flat = cells.flat().filter((v) => Number.isFinite(v))
          const max = Math.max(...flat, 1)
          const heat = (v) => v <= 0 ? '' : `background:rgba(79,110,247,${Math.max(0.06, (v / max) * 0.55).toFixed(2)})`
          return `
            <div class="table-wrap">
              <table class="tbl" style="font-size:11px">
                <thead><tr><th style="position:sticky;left:0">部门 \\ 模型</th>${models.map((m) => `<th class="mono" style="text-align:right">${esc(m)}</th>`).join('')}<th style="text-align:right">其他</th></tr></thead>
                <tbody>
                  ${orgs.map((org, i) => `
                    <tr>
                      <td class="col-strong" style="position:sticky;left:0">${esc(org)}</td>
                      ${models.map((_, j) => `<td class="col-num mono" style="text-align:right;${heat(cells[i][j])}">${cells[i][j] || '·'}</td>`).join('')}
                      <td class="col-num mono text-4" style="text-align:right">${cells[i][models.length] || '·'}</td>
                    </tr>`).join('')}
                  <tr>
                    <td class="col-strong text-4" style="position:sticky;left:0">其他</td>
                    ${models.map((_, j) => `<td class="col-num mono text-4" style="text-align:right">${cells[orgs.length][j] || '·'}</td>`).join('')}
                    <td class="col-num mono" style="text-align:right;font-weight:600">${cells[orgs.length][models.length] || '·'}</td>
                  </tr>
                </tbody>
              </table>
            </div>`
        })()}
      </div>
    </div>

    <div class="card mb-20">
      <div class="card-head">
        <span class="card-title">${icon('wifi', 15)} 空转检测（近似口径）</span>
        <span class="card-sub">判定：模型调用后 ${idle.idleWindowMinutes} 分钟内同一主体无任何后续动作（技能/工具/存储等）且无同 trace 关联动作</span>
      </div>
      <div class="card-body" style="padding-top:8px">
        <div class="badge no-dot" style="background:var(--warn-bg,#fef3c7);color:#92400e;margin-bottom:10px">${icon('info', 13)}
          近似口径说明：纯对话（模型回复后用户直接离开）也会计入，本表用于发现「值得关注」的空转线索，<b>需人工复核</b>，不作为考核依据。
          精确口径将在「任务结果回传」上线后自动替换。
        </div>
        <div class="table-wrap">
          <table class="tbl">
            <thead><tr><th>对象</th><th style="text-align:right">总调用</th><th style="text-align:right">疑似空转</th><th style="text-align:right">空转占比</th><th style="text-align:right">空转成本</th></tr></thead>
            <tbody>
              ${(() => {
                const rows = [
                  ...idle.byModel.map((r) => ({ label: r.model, sub: '模型', ...r })),
                  ...idle.byOrg.map((r) => ({ label: r.org || '（未归口）', sub: '部门', ...r })),
                ].filter((r) => r.idle_events > 0).sort((a, b) => b.idle_cost_cents - a.idle_cost_cents)
                if (!rows.length) return emptyRow(5, '未检出疑似空转调用——或窗口内尚无模型调用数据')
                return rows.slice(0, 10).map((row) => `
                  <tr>
                    <td><div class="col-strong mono ellipsis" style="max-width:280px">${esc(row.label)}</div><div class="col-sub fs-11 text-4">${esc(row.sub)}</div></td>
                    <td class="col-num fs-12" style="text-align:right">${fmtNum(row.events)}</td>
                    <td class="col-num fs-12" style="text-align:right">${fmtNum(row.idle_events)}</td>
                    <td class="col-num fs-12" style="text-align:right">${row.events > 0 ? Math.round((row.idle_events / row.events) * 1000) / 10 : 0}%</td>
                    <td class="col-num fs-12" style="text-align:right;font-weight:600">${fmtCost(row.idle_cost_cents / 100)}</td>
                  </tr>`).join('')
              })()}
            </tbody>
          </table>
        </div>
        ${idle.samples.length ? `
          <details style="margin-top:10px">
            <summary class="fs-12 text-4" style="cursor:pointer">疑似空转样本（最近 ${idle.samples.length} 条，点击展开人工复核）</summary>
            <div class="table-wrap" style="margin-top:6px">
              <table class="tbl" style="font-size:11px">
                <thead><tr><th>时间</th><th>主体</th><th>部门</th><th>模型</th><th style="text-align:right">tokens</th><th style="text-align:right">成本（分）</th></tr></thead>
                <tbody>
                  ${idle.samples.map((s) => `
                    <tr>
                      <td class="mono fs-11">${esc(s.occurred_at.replace('T', ' ').slice(0, 16))}</td>
                      <td class="mono fs-11">${esc(s.subject)}</td>
                      <td class="fs-11">${esc(s.org || '—')}</td>
                      <td class="mono fs-11">${esc(s.resource)}</td>
                      <td class="col-num mono" style="text-align:right">${fmtNum(s.tokens)}</td>
                      <td class="col-num mono" style="text-align:right">${s.cost_cents}</td>
                    </tr>`).join('')}
                </tbody>
              </table>
            </div>
          </details>` : ''}
      </div>
    </div>

    <div class="card">
      <div class="card-head"><span class="card-title">${icon('users', 15)} 消耗主体 Top 10</span><span class="card-sub">${esc(penetration.month)} · 用户与 Agent 合计</span></div>
      <div class="card-body" style="padding-top:6px">
        <div class="table-wrap">
          <table class="tbl">
            <thead><tr><th>主体</th><th>部门</th><th style="text-align:right">调用</th><th style="text-align:right">内部成本</th></tr></thead>
            <tbody>
              ${penetration.topSubjects.length ? penetration.topSubjects.map((row) => `
                <tr>
                  <td class="mono fs-12">${esc(row.subject)}</td>
                  <td class="fs-12">${esc(row.org || '—')}</td>
                  <td class="col-num fs-12" style="text-align:right">${fmtNum(row.events)}</td>
                  <td class="col-num fs-12" style="text-align:right;font-weight:600">${fmtCost(row.cost_cents / 100)}</td>
                </tr>`).join('') : emptyRow(4, `${penetration.month} 暂无计量数据`)}
            </tbody>
          </table>
        </div>
      </div>
    </div>`

  $('#finops-month').onchange = () => {
    const next = $('#finops-month').value
    if (!next) return
    location.hash = `#/finops?month=${next}`
  }
}
