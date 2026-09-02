/** 审批中心：全平台 L4 高危操作汇聚（飞书审批式时间线 + IM 卡片语义）。 */
import { api, session } from '../api.js'
import { icon } from '../icons.js'
import { h, $, $$, esc, toast, openDrawer, openModal, collectForm, field, textareaField, statusBadge, timeAgo, emptyState } from '../ui.js'

export async function renderApprovals(content, params, ctx) {
  const data = await api.get('/api/approvals')
  let sla = null
  try { sla = await api.get('/api/approvals/sla?windowDays=30') } catch { /* SLA 看板失败不阻断列表 */ }
  let statusFilter = 'pending'

  content.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">审批中心</div>
        <div class="page-desc">Skill 上架、Agent 上线、L4 高危操作（下线/吊销/删除）全平台汇聚；有审批权限即可单人通过。</div>
      </div>
    </div>
    <div class="tabs">
      <div class="tab active" data-s="pending">待审批 <span class="tab-count">${data.approvals.filter((a) => a.status === 'pending').length}</span></div>
      <div class="tab" data-s="all">全部 <span class="tab-count">${data.approvals.length}</span></div>
    </div>

    ${sla ? `
    <div class="card card-pad mb-20">
      <div class="flex" style="gap:18px;align-items:center;flex-wrap:wrap">
        <div class="card-title" style="margin:0">${icon('clock', 15)} 审批 SLA（近 ${sla.windowDays} 天）</div>
        <div style="font-size:22px;font-weight:700;color:${sla.achievementRate >= 0.9 ? 'var(--ok)' : 'var(--danger)'}">${Math.round(sla.achievementRate * 1000) / 10}%</div>
        <span class="fs-12 text-3">≤2 工作日达成率 · 已决 ${sla.decided} 单${sla.breached.length ? ` · 超期 ${sla.breached.length} 单` : ''}</span>
        <span class="fs-11 text-4">${sla.calendarNote}</span>
      </div>
      ${sla.breached.length ? `<div class="fs-12 mt-8" style="color:var(--danger)">超期单：${sla.breached.slice(0, 3).map((item) => `${esc(item.title)}（${item.businessDays} 工作日）`).join('、')}${sla.breached.length > 3 ? ' 等' : ''}</div>` : ''}
    </div>` : ''}
    <div id="approval-list"></div>`

  $$('.tab').forEach((el) => {
    el.onclick = () => {
      $$('.tab').forEach((t) => t.classList.remove('active'))
      el.classList.add('active')
      statusFilter = el.dataset.s
      renderList()
    }
  })

  function renderList() {
    const list = statusFilter === 'pending' ? data.approvals.filter((a) => a.status === 'pending') : data.approvals
    const holder = $('#approval-list')
    holder.innerHTML = ''
    if (!list.length) {
      holder.appendChild(emptyState({ title: statusFilter === 'pending' ? '没有待办审批' : '暂无审批记录', desc: 'L4 高危操作提交后将自动生成审批单', icon: 'checkSquare' }))
      return
    }
    for (const approval of list) {
      const card = h(`
        <div class="card card-pad mb-8" data-id="${esc(approval.id)}" style="cursor:pointer">
          <div class="flex" style="gap:12px">
            <div style="width:38px;height:38px;border-radius:10px;background:var(--brand-50);color:var(--brand-500);display:grid;place-items:center;flex-shrink:0">
              ${icon(kindIcon(approval.kind), 18)}
            </div>
            <div class="grow">
              <div class="flex" style="gap:8px">
                <span style="font-weight:600">${esc(approval.title)}</span>
                ${statusBadge(approval.status)}
                <span class="badge badge-muted no-dot">${kindLabel(approval.kind)}</span>
                ${approval.riskLevel === 'high' ? '<span class="badge badge-danger no-dot">高风险</span>' : ''}
                ${approval.finalReview ? '<span class="badge badge-ok no-dot" title="公司级终审已通过（审计可追溯）">终审</span>' : ''}
              </div>
              <div class="fs-12 text-3 mt-8">${esc(approval.requesterName)} 发起 · ${timeAgo(approval.createdAt)}</div>
            </div>
            ${approval.status === 'pending' && session.can('approval.decide') ? `
              <div style="flex-shrink:0;display:flex;gap:8px;align-items:center">
                <button class="btn btn-danger-ghost btn-sm stop" data-reject="${esc(approval.id)}">驳回</button>
                <button class="btn btn-primary btn-sm stop" data-approve="${esc(approval.id)}">通过</button>
              </div>` : ''}
          </div>
        </div>`)
      card.onclick = () => openApprovalDetail(approval.id, ctx)
      const approveBtn = card.querySelector('[data-approve]')
      if (approveBtn) approveBtn.onclick = (e) => { e.stopPropagation(); openDecision(approval.id, 'approve', ctx, approval) }
      const rejectBtn = card.querySelector('[data-reject]')
      if (rejectBtn) rejectBtn.onclick = (e) => { e.stopPropagation(); openDecision(approval.id, 'reject', ctx, approval) }
      holder.appendChild(card)
    }
  }
  renderList()
  if (params.get('focus')) void openApprovalDetail(params.get('focus'), ctx)
}

async function openApprovalDetail(id, ctx) {
  const data = await api.get('/api/approvals')
  const approval = data.approvals.find((a) => a.id === id)
  if (!approval) return
  const drawer = openDrawer({
    title: approval.title,
    sub: `${kindLabel(approval.kind)} · ${approval.requesterName} 发起于 ${timeAgo(approval.createdAt)}`,
    body: `
      <div class="mb-14">${statusBadge(approval.status)}</div>
      <div class="card-title mb-8">申请内容</div>
      <div class="code-block" style="max-height:220px">${esc(JSON.stringify(approval.payload, null, 2))}</div>
      <div class="card-title mt-14 mb-8">审批时间线</div>
      <div class="timeline">
        <div class="timeline-item ok">
          <div class="timeline-dot"></div>
          <div class="timeline-title">发起申请</div>
          <div class="timeline-time">${timeAgo(approval.createdAt)} · ${esc(approval.requesterName)}</div>
        </div>
        ${approval.status === 'pending' ? `
          <div class="timeline-item current">
            <div class="timeline-dot"></div>
            <div class="timeline-title">等待审批</div>
            <div class="timeline-body">任意具有审批权限的管理员可处理（发起人本人不可审批）</div>
          </div>` : `
          <div class="timeline-item ${approval.status === 'rejected' ? 'danger' : 'ok'}">
            <div class="timeline-dot"></div>
            <div class="timeline-title">${approval.status === 'rejected' ? '已驳回' : approval.status === 'failed' ? '审批通过但执行失败' : '审批通过并已执行'}</div>
            <div class="timeline-time">${timeAgo(approval.decidedAt)} · ${esc(approval.approverName ?? '')}</div>
            ${approval.opinion ? `<div class="timeline-body">意见：${esc(approval.opinion)}</div>` : ''}
            ${approval.execution ? `<div class="timeline-body mono">${esc(approval.execution.error ?? approval.execution.result)}</div>` : ''}
            ${approval.finalReview ? `
          <div class="timeline-item ok">
            <div class="timeline-dot"></div>
            <div class="timeline-title">公司级终审标记 ✓（审计 action=approval.final_review）</div>
            <div class="timeline-time">${timeAgo(approval.finalReview.at)} · ${esc(approval.finalReview.approverName)}</div>
          </div>` : ''}
          </div>`}
      </div>`,
    foot: approval.status === 'pending' && session.can('approval.decide')
      ? `<button class="btn btn-danger-ghost" id="ap-reject">驳回</button><button class="btn btn-primary" id="ap-approve">通过并执行</button>`
      : '',
  })
  const approveBtn = drawer.el.querySelector('#ap-approve')
  if (approveBtn) approveBtn.onclick = () => { drawer.close(); openDecision(id, 'approve', ctx, approval) }
  const rejectBtn = drawer.el.querySelector('#ap-reject')
  if (rejectBtn) rejectBtn.onclick = () => { drawer.close(); openDecision(id, 'reject', ctx, approval) }
}

function openDecision(id, decision, ctx, approval) {
  const isHighRisk = approval?.riskLevel === 'high'
  const modal = openModal({
    title: decision === 'approve' ? '审批通过' : '驳回申请',
    body: `
      ${decision === 'approve' ? `
        <div class="muted-box mb-14" style="display:flex;gap:8px;border-color:var(--ok-border);background:var(--ok-bg)">
          ${icon('check', 15)}<span>通过后将<b>自动执行</b>对应的高危操作（执行结果会回写审批单）。</span>
        </div>` : ''}
      ${isHighRisk && decision === 'approve' ? `
        <div class="muted-box mb-14" style="display:flex;gap:8px;border-color:var(--danger-border);background:var(--danger-bg)">
          ${icon('alert', 15)}<span><b>高风险审批（L1 公司级终审）</b>：通过前请复核影响面；通过后将自动落公司级终审标记并写入审计。</span>
        </div>
        <label class="flex mb-14" style="gap:8px;align-items:flex-start;cursor:pointer">
          <input type="checkbox" id="apc-confirm" style="margin-top:3px">
          <span class="fs-12 text-2">二次确认：我已完整复核该高风险操作的影响面与回滚方案（不勾选将无法通过，服务端强制）。</span>
        </label>` : ''}
      ${decision === 'approve' && !isHighRisk ? `
        <label class="flex mb-14" style="gap:8px;align-items:flex-start;cursor:pointer">
          <input type="checkbox" id="apc-final" style="margin-top:3px">
          <span class="fs-12 text-2">同时落「公司级终审标记」（审计可追溯，非高风险默认可选）。</span>
        </label>` : ''}
      ${field('审批意见', textareaField('opinion', { placeholder: decision === 'approve' ? '如：已确认影响面，同意执行' : '请说明驳回原因…' }), { required: true })}`,
    foot: `<button class="btn btn-default" data-cancel>取消</button><button class="btn ${decision === 'approve' ? 'btn-primary' : 'btn-danger'}" data-ok>${decision === 'approve' ? '确认通过' : '确认驳回'}</button>`,
  })
  modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
  modal.el.querySelector('[data-ok]').onclick = async (e) => {
    const btn = e.currentTarget
    const opinion = collectForm(modal.body).opinion
    if (!opinion) return toast('请填写审批意见', 'error')
    if (isHighRisk && decision === 'approve' && !modal.body.querySelector('#apc-confirm')?.checked) {
      return toast('高风险审批需勾选二次确认（服务端强制）', 'error')
    }
    const confirmed = isHighRisk && decision === 'approve'
    const finalReview = Boolean(modal.body.querySelector('#apc-final')?.checked)
    btn.classList.add('btn-loading')
    try {
      const result = await api.post(`/api/approvals/${id}/decide`, { decision, opinion, confirmed, finalReview })
      toast(decision === 'approve' ? `审批通过，状态：${result.status}` : '已驳回')
      modal.close(); ctx.rerender()
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      btn.classList.remove('btn-loading')
    }
  }
}

function kindLabel(kind) {
  return {
    'agent.online': 'Agent 上线', 'agent.offline': 'Agent 下线',
    'app.online': '应用发布', 'app.offline': '应用下架',
    'mcp.offline': 'MCP 下线',
  }[kind] ?? kind
}
function kindIcon(kind) {
  if (kind.startsWith('agent')) return 'bot'
  if (kind.startsWith('app')) return 'app'
  if (kind.startsWith('mcp')) return 'plug'
  return 'checkSquare'
}
