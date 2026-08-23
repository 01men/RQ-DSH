/** Skill 市场：卡片市场 + 详情（版本历史/审批时间线/安装）+ 提交/审批流。 */
import { api, session } from '../api.js'
import { icon } from '../icons.js'
import {
  h, $, $$, esc, toast, openDrawer, openModal, confirmDialog,
  statusBadge, collectForm, field, inputField, selectField, textareaField,
  fmtNum, timeAgo, emptyState,
} from '../ui.js'

const COVERS = ['linear-gradient(135deg,#4f6ef7,#7c5cf5)', 'linear-gradient(135deg,#10b981,#34d399)', 'linear-gradient(135deg,#f59e0b,#fbbf24)', 'linear-gradient(135deg,#8b5cf6,#a78bfa)', 'linear-gradient(135deg,#3b82f6,#60a5fa)', 'linear-gradient(135deg,#ef4444,#f87171)']
const COVER_ICONS = { '办公提效': 'file', '研发效能': 'terminal', '客户服务': 'ticket', '数据分析': 'chart', '人事行政': 'users', '市场情报': 'globe', '法务合规': 'shield', '通用': 'sparkles' }

export async function renderSkills(content, params, ctx) {
  const data = await api.get('/api/skills')

  content.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">Skill 市场</div>
        <div class="page-desc">提交 → 静态扫描 → 两级审批 → 版本化上架。高风险 Skill 需安全团队加签，下载安装即登记依赖。</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-default" id="skill-mine">${icon('user', 14)}我的提交</button>
        ${session.can('skill.approve') ? `<button class="btn btn-default" id="skill-review">${icon('checkSquare', 14)}待审批</button>` : ''}
        <button class="btn btn-primary" id="skill-submit">${icon('plus', 14)}提交 Skill</button>
      </div>
    </div>
    <div class="filter-bar">
      <div class="search-input">${icon('search')}<input class="input" id="skill-q" placeholder="搜索名称 / 标签 / 简介"></div>
      <div class="chips" id="skill-cats">
        <span class="chip active" data-cat="">全部分类</span>
        ${(data.categories ?? []).map((cat) => `<span class="chip" data-cat="${esc(cat)}">${esc(cat)}</span>`).join('')}
      </div>
      <div class="segmented" style="margin-left:auto" id="skill-sort">
        <span class="segmented-item active" data-sort="downloads">按下载</span>
        <span class="segmented-item" data-sort="rating">按评分</span>
        <span class="segmented-item" data-sort="updated">按更新</span>
      </div>
    </div>
    <div class="card-grid" id="skill-cards"></div>`

  let state = { q: '', cat: '', sort: 'downloads', mode: 'market' }

  const refresh = async () => {
    const query = api.qs(state.mode === 'mine' ? { mine: 1 } : state.mode === 'review' ? { pending: 1 } : { q: state.q || undefined, category: state.cat || undefined, sort: state.sort })
    const result = await api.get('/api/skills' + query)
    renderCards(result.skills ?? [])
  }

  function renderCards(skills) {
    const holder = $('#skill-cards')
    holder.innerHTML = ''
    if (!skills.length) {
      holder.appendChild(emptyState({
        title: state.mode === 'review' ? '没有待审批的 Skill' : state.mode === 'mine' ? '你还没有提交过 Skill' : '没有匹配的 Skill',
        desc: state.mode === 'market' ? '换个关键字或分类试试' : '提交第一个 Skill 到市场，让能力复用起来',
        actionText: state.mode === 'market' ? undefined : '提交 Skill',
        onAction: () => $('#skill-submit').click(),
        icon: 'sparkles',
      }))
      return
    }
    for (const [index, skill] of skills.entries()) {
      const cover = COVERS[index % COVERS.length]
      const card = h(`
        <div class="res-card" data-id="${esc(skill.id)}">
          <div style="height:86px;border-radius:9px;background:${skill.status === 'deprecated' ? 'linear-gradient(135deg,#9ca3af,#d1d5db)' : cover};display:grid;place-items:center;color:#fff;position:relative">
            <span style="filter:drop-shadow(0 2px 6px rgba(0,0,0,.25))">${icon(COVER_ICONS[skill.category] ?? 'sparkles', 34)}</span>
            ${skill.riskLevel !== 'low' ? `<span class="badge ${skill.riskLevel === 'high' ? 'badge-danger' : 'badge-warn'} no-dot" style="position:absolute;top:8px;right:8px;background:rgba(255,255,255,.92)">${skill.riskLevel === 'high' ? '高风险' : '中风险'}</span>` : ''}
          </div>
          <div class="res-card-top" style="margin-top:2px">
            <div class="grow">
              <div class="res-name">${esc(skill.name)} ${statusBadge(skill.status)}</div>
              <div class="res-slug">v${esc(skill.currentVersion)} · ${esc(skill.category)}${skill.tags.length ? ' · ' + skill.tags.slice(0, 2).map(esc).join(' / ') : ''}</div>
            </div>
          </div>
          <div class="res-desc">${esc(skill.summary)}</div>
          <div class="res-foot">
            <span class="metric">${icon('user', 13)}${esc(skill.authorName)}</span>
            <span class="metric">${icon('download', 13)}${fmtNum(skill.stats.downloads)}</span>
            <span class="metric">${icon('star', 13)}${skill.stats.rating || '—'}</span>
            <span style="margin-left:auto" class="text-4">${timeAgo(skill.updatedAt)}</span>
          </div>
        </div>`)
      card.onclick = () => openSkillDetail(skill.id, ctx, refresh)
      holder.appendChild(card)
    }
  }

  $('#skill-q').oninput = debounce(() => { state.q = $('#skill-q').value.trim(); state.mode = 'market'; void refresh() }, 250)
  $$('#skill-cats .chip').forEach((chip) => {
    chip.onclick = () => {
      $$('#skill-cats .chip').forEach((c) => c.classList.remove('active'))
      chip.classList.add('active')
      state.cat = chip.dataset.cat
      state.mode = 'market'
      void refresh()
    }
  })
  $$('#skill-sort .segmented-item').forEach((el) => {
    el.onclick = () => {
      $$('#skill-sort .segmented-item').forEach((i) => i.classList.remove('active'))
      el.classList.add('active')
      state.sort = el.dataset.sort
      void refresh()
    }
  })
  $('#skill-mine').onclick = () => { state.mode = state.mode === 'mine' ? 'market' : 'mine'; void refresh() }
  const reviewBtn = $('#skill-review')
  if (reviewBtn) reviewBtn.onclick = () => { state.mode = state.mode === 'review' ? 'market' : 'review'; void refresh() }
  $('#skill-submit').onclick = () => openSubmitModal(ctx, refresh)

  await refresh()
  if (params.get('action') === 'submit') openSubmitModal(ctx, refresh)
  if (params.get('focus')) void openSkillDetail(params.get('focus'), ctx, refresh)
}

async function openSkillDetail(id, ctx, refresh) {
  const [skill, agentData] = await Promise.all([
    api.get(`/api/skills/${id}`),
    api.get('/api/agents').catch(() => ({ agents: [] })),
  ])
  const versions = [...skill.versions].reverse()
  const current = versions[0]

  const drawer = openDrawer({
    title: skill.name,
    sub: `${skill.category} · v${skill.currentVersion} · 作者 ${skill.authorName}`,
    wide: true,
    body: `
      <div class="flex mb-8" style="gap:8px;flex-wrap:wrap">
        ${statusBadge(skill.status)}
        <span class="badge ${skill.riskLevel === 'high' ? 'badge-danger' : skill.riskLevel === 'medium' ? 'badge-warn' : 'badge-ok'} no-dot">${skill.riskLevel === 'high' ? '高风险（需安全加签）' : skill.riskLevel === 'medium' ? '中风险' : '低风险'}</span>
        ${skill.tags.map((tag) => `<span class="badge badge-muted no-dot">${esc(tag)}</span>`).join('')}
      </div>
      <div class="fs-13 mt-14" style="line-height:1.7;color:var(--text-2)">${esc(skill.description || skill.summary)}</div>

      <div class="stat-grid mt-14 mb-20" style="grid-template-columns:repeat(4,1fr)">
        ${miniStat('download', '下载量', fmtNum(skill.stats.downloads))}
        ${miniStat('box', '安装量', fmtNum(skill.stats.installs))}
        ${miniStat('star', '评分', `${skill.stats.rating || '—'}（${skill.stats.ratingCount} 人）`)}
        ${miniStat('layers', '版本数', versions.length)}
      </div>

      <div class="tabs" id="sk-tabs">
        <div class="tab active" data-tab="readme">效果示例</div>
        <div class="tab" data-tab="versions">版本与审批</div>
      </div>
      <div id="sk-tab-body"></div>`,
    foot: `
      ${skill.status === 'published' ? `<button class="btn btn-default" id="sk-download">${icon('download', 14)}下载</button>` : ''}
      ${skill.status === 'published' && session.can('skill.install') ? `<button class="btn btn-primary" id="sk-install">${icon('plus', 14)}安装到 Agent</button>` : ''}
      ${session.can('skill.approve') && (current?.status === 'pending_domain' || current?.status === 'pending_security') ? `<button class="btn btn-primary" id="sk-approve">${icon('check', 14)}审批</button>` : ''}
      ${session.can('skill.approve') && current?.status === 'approved' && skill.status !== 'published' ? `<button class="btn btn-primary" id="sk-publish">${icon('send', 14)}上架</button>` : ''}
      ${session.can('skill.publish') && skill.status === 'published' ? `<button class="btn btn-danger-ghost" id="sk-deprecate">${icon('alert', 14)}弃用</button>` : ''}`,
  })

  const tabBody = drawer.body.querySelector('#sk-tab-body')
  const renderTab = (tab) => {
    if (tab === 'readme') {
      tabBody.innerHTML = `
        <div class="muted-box" style="display:flex;gap:8px;margin-bottom:12px">
          ${icon('info', 15)}<span>SKILL.md 由模型按需加载：何时使用 / 操作步骤 / 输出格式。适用模型：${skill.applicableModels.map(esc).join('、')}</span>
        </div>
        <div class="code-block">${esc(current?.content ?? '（暂无内容）')}</div>`
    }
    if (tab === 'versions') {
      tabBody.innerHTML = `
        <div class="timeline">
          ${versions.map((v) => `
            <div class="timeline-item ${v.status === 'published' ? 'ok' : v.status === 'rejected' ? 'danger' : 'current'}">
              <div class="timeline-dot"></div>
              <div class="timeline-title flex" style="gap:8px">v${esc(v.version)} ${statusBadge(versionStatus(v.status))}</div>
              <div class="timeline-time">提交于 ${timeAgo(v.submittedAt)}${v.publishedAt ? ' · 上架于 ' + timeAgo(v.publishedAt) : ''}</div>
              <div class="timeline-body">${esc(v.changelog)}</div>
              ${v.findings?.length ? `
                <div class="mt-8">
                  ${v.findings.map((f) => `
                    <div class="flex" style="padding:3px 0">
                      <span style="color:var(--${f.level === 'block' ? 'danger' : f.level === 'warn' ? 'warn' : 'info'})">${icon(f.level === 'block' ? 'alert' : f.level === 'warn' ? 'alert' : 'info', 13)}</span>
                      <span class="fs-12">${esc(f.message)}<span class="mono text-4" style="margin-left:6px">${esc(f.rule)}</span></span>
                    </div>`).join('')}
                </div>` : ''}
              ${v.approvals?.length ? `
                <div class="mt-8">
                  ${v.approvals.map((a) => `
                    <div class="flex" style="padding:3px 0">
                      <span style="color:var(--ok)">${icon('check', 13)}</span>
                      <span class="fs-12">${a.level === 'domain' ? '领域审批' : '安全加签'}：${esc(a.approverName)} —— ${esc(a.opinion)}</span>
                    </div>`).join('')}
                </div>` : ''}
              ${v.rejectedReason ? `<div class="fs-12" style="color:var(--danger);padding:4px 0">驳回原因：${esc(v.rejectedReason)}</div>` : ''}
            </div>`).join('')}
        </div>`
    }
  }
  drawer.body.querySelectorAll('#sk-tabs .tab').forEach((el) => {
    el.onclick = () => {
      drawer.body.querySelectorAll('#sk-tabs .tab').forEach((t) => t.classList.remove('active'))
      el.classList.add('active')
      renderTab(el.dataset.tab)
    }
  })
  renderTab('readme')

  const downloadBtn = drawer.el.querySelector('#sk-download')
  if (downloadBtn) downloadBtn.onclick = async () => {
    const result = await api.post(`/api/skills/${skill.id}/download`, {})
    openModal({
      title: `SKILL.md · v${skill.currentVersion}`,
      body: `<div class="code-block" style="max-height:400px">${esc(result.content)}</div><div class="form-hint mt-8">下载已登记（审计可回溯谁下载了哪个版本）</div>`,
      foot: '<button class="btn btn-primary" data-ok>关闭</button>',
    })
  }
  const installBtn = drawer.el.querySelector('#sk-install')
  if (installBtn) installBtn.onclick = () => {
    const modal = openModal({
      title: '安装到 Agent',
      body: `
        ${field('目标 Agent', selectField('agentId', agentData.agents.map((a) => ({ value: a.id, label: `${a.name}（${a.status}）` }))), { required: true })}
        <div class="form-hint">安装后自动登记依赖关系，Agent 的「关联 Skill」属性同步回填。</div>`,
      foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>安装</button>',
    })
    modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
    modal.el.querySelector('[data-ok]').onclick = async () => {
      try {
        await api.post(`/api/skills/${skill.id}/install`, { agentId: collectForm(modal.body).agentId, version: skill.currentVersion })
        toast('安装成功，依赖已登记'); modal.close(); drawer.close(); refresh?.()
      } catch (error) { toast(error.message, 'error') }
    }
  }
  const approveBtn = drawer.el.querySelector('#sk-approve')
  if (approveBtn) approveBtn.onclick = () => {
    const needLevel = current?.status === 'pending_domain' ? 'domain' : 'security'
    const modal = openModal({
      title: `审批 · ${skill.name} v${current.version}`,
      body: `
        <div class="muted-box mb-14" style="display:flex;gap:8px">
          ${icon('info', 15)}
          <span>${needLevel === 'domain' ? '领域负责人审批：评估业务适用性与描述准确性。' : '安全团队加签：该 Skill 包含外联/写文件等高风险行为。'}${skill.riskLevel === 'high' ? '（高风险：两级审批均须通过）' : ''}</span>
        </div>
        ${field('审批意见', textareaField('opinion', { placeholder: '请说明审批依据…' }), { required: true })}`,
      foot: '<button class="btn btn-danger-ghost" data-reject>驳回</button><button class="btn btn-primary" data-ok>通过</button>',
    })
    modal.el.querySelector('[data-reject]').onclick = async () => {
      const opinion = collectForm(modal.body).opinion
      if (!opinion) return toast('请填写意见', 'error')
      await api.post(`/api/skills/${skill.id}/approve`, { decision: 'reject', level: needLevel, opinion })
      toast('已驳回'); modal.close(); drawer.close(); refresh?.()
    }
    modal.el.querySelector('[data-ok]').onclick = async () => {
      const opinion = collectForm(modal.body).opinion
      if (!opinion) return toast('请填写意见', 'error')
      try {
        await api.post(`/api/skills/${skill.id}/approve`, { decision: 'approve', level: needLevel, opinion })
        toast('审批通过'); modal.close(); drawer.close(); refresh?.()
      } catch (error) { toast(error.message, 'error') }
    }
  }
  const publishBtn = drawer.el.querySelector('#sk-publish')
  if (publishBtn) publishBtn.onclick = async () => {
    await api.post(`/api/skills/${skill.id}/publish`, {})
    toast('已上架市场'); drawer.close(); refresh?.()
  }
  const deprecateBtn = drawer.el.querySelector('#sk-deprecate')
  if (deprecateBtn) deprecateBtn.onclick = async () => {
    const result = await confirmDialog({
      title: '弃用 Skill', requireReason: true, danger: true, confirmText: '确认弃用',
      message: '弃用后市场不可安装；存量引用的 Agent 会收到迁移告警。旧版本保留可回滚。',
    })
    if (!result) return
    const response = await api.post(`/api/skills/${skill.id}/deprecate`, { reason: result.reason })
    if (response.referencingAgents?.length) {
      toast(`已弃用；${response.referencingAgents.length} 个 Agent 收到迁移告警`)
    } else {
      toast('已弃用')
    }
    drawer.close(); refresh?.()
  }
}

function openSubmitModal(ctx, refresh) {
  const modal = openModal({
    title: '提交 Skill 到市场', wide: true,
    body: `
      <div class="muted-box mb-14" style="display:flex;gap:8px">
        ${icon('zap', 15)}<span>提交后自动进入流水线：<b>静态扫描</b>（恶意代码 / 密钥泄露检测）→ <b>领域审批</b> → 高风险额外 <b>安全加签</b> → 上架。</span>
      </div>
      <div class="form-grid">
        ${field('名称', inputField('name'), { required: true })}
        ${field('分类', selectField('category', ['办公提效', '研发效能', '客户服务', '数据分析', '人事行政', '市场情报', '法务合规', '通用'].map((c) => ({ value: c, label: c }))))}
        ${field('一句话简介', inputField('summary'), { full: true })}
        ${field('版本号', inputField('version', { value: '1.0.0' }))}
        ${field('标签（逗号分隔）', inputField('tags', { placeholder: '文档,自动化' }))}
      </div>
      ${field('SKILL.md 内容', textareaField('content', { placeholder: '# Skill 名称\n\n## 何时使用\n…\n\n## 操作步骤\n1. …', rows: 8 }), { required: true, hint: '静态扫描将检测破坏性命令、动态执行、密钥泄露等风险模式' })}`,
    foot: '<button class="btn btn-default" data-cancel>取消</button><button class="btn btn-primary" data-ok>提交（进入扫描）</button>',
  })
  modal.el.querySelector('[data-cancel]').onclick = () => modal.close()
  modal.el.querySelector('[data-ok]').onclick = async (e) => {
    const btn = e.currentTarget
    btn.classList.add('btn-loading')
    try {
      const data = collectForm(modal.body)
      const result = await api.post('/api/skills', {
        name: data.name, category: data.category, summary: data.summary, version: data.version,
        content: data.content,
        tags: data.tags ? data.tags.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [],
      })
      modal.close()
      if (result.status === 'rejected') {
        openModal({
          title: '静态扫描未通过（自动驳回）',
          body: `<div class="form-hint" style="margin-bottom:10px">检测到阻断级问题，请修复后重新提交：</div>
            ${result.findings.filter((f) => f.level === 'block').map((f) => `<div class="flex" style="padding:4px 0"><span style="color:var(--danger)">${icon('alert', 14)}</span><span class="fs-13">${esc(f.message)}</span></div>`).join('')}`,
          foot: '<button class="btn btn-primary" data-ok>知道了</button>',
        })
      } else {
        const warns = result.findings?.filter((f) => f.level === 'warn') ?? []
        openModal({
          title: '已提交，等待审批',
          body: warns.length
            ? `<div class="form-hint" style="margin-bottom:8px">扫描发现风险提示（将要求安全加签）：</div>${warns.map((f) => `<div class="flex" style="padding:3px 0"><span style="color:var(--warn)">${icon('alert', 14)}</span><span class="fs-13">${esc(f.message)}</span></div>`).join('')}`
            : `<div class="flex" style="gap:8px;padding:8px 0"><span style="color:var(--ok)">${icon('check', 16)}</span><span>扫描通过，进入领域审批环节。</span></div>`,
          foot: '<button class="btn btn-primary" data-ok>知道了</button>',
        })
      }
      refresh?.()
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      btn.classList.remove('btn-loading')
    }
  }
}

function versionStatus(status) {
  const map = {
    published: 'published', approved: 'approved', rejected: 'rejected',
    pending_domain: 'pending_domain', pending_security: 'pending_security',
    scanning: 'scanning', deprecated: 'deprecated',
  }
  return map[status] ?? status
}

function miniStat(ic, label, value) {
  return `
    <div style="background:var(--surface-2);border-radius:10px;padding:12px 14px">
      <div style="color:var(--brand-500)">${icon(ic, 16)}</div>
      <div style="font-size:16px;font-weight:700;margin-top:6px">${value}</div>
      <div class="stat-label">${esc(label)}</div>
    </div>`
}

function debounce(fn, ms) {
  let timer
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms) }
}
