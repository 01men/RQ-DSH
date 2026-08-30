/** NAS 数据权限：规则/矩阵/例外（含过期倒计时）/C 关联组/NAS 锚点映射/check 试算/判定留痕/治理工具。 */
import { api, session } from '../api.js'
import { icon } from '../icons.js'
import {
  h, $, $$, esc, toast, openModal, confirmDialog,
  renderTable, inputField, textareaField, timeAgo, emptyState,
} from '../ui.js'

const OPS = ['read', 'download', 'write', 'modify', 'delete', 'share', 'admin']
const OP_LABEL = { read: '读取', download: '下载', write: '写入', modify: '改动', delete: '删除', share: '分享', admin: '管理' }
const ROLES = ['P', 'D', 'T', 'M']
const ROLE_LABEL = { P: 'P 平台负责人', D: 'D 部门负责人', T: 'T 班组负责人', M: 'M 成员', C: 'C 跨域只读(叠加)' }
const MATRIX_DEFAULT = {
  P: { read: 1, download: 1, write: 1, modify: 1, delete: 1, share: 1, admin: 1 },
  D: { read: 1, download: 1, write: 1, modify: 1, delete: 1, share: 1, admin: 0 },
  T: { read: 1, download: 1, write: 1, modify: 1, delete: 0, share: 0, admin: 0 },
  M: { read: 1, download: 1, write: 1, modify: 0, delete: 0, share: 0, admin: 0 },
}

let rules = null
let nasList = []
let groupNames = new Map()

export async function renderNasAuthz(content) {
  content.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">NAS 数据权限</div>
        <div class="page-desc">组织位置 + 角色层级 RBAC（P/D/T/M + C 叠加）：五步判定序，显式例外优先于角色矩阵；网关与 hermes 双强制点共用同一套规则，全链 fail-closed。</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-default" id="az-reconcile">${icon('refresh', 14)}组织目录对账</button>
        <button class="btn btn-default" id="az-vacancy">${icon('users', 14)}负责人悬空扫描</button>
        <button class="btn btn-primary" id="az-simulate">${icon('search', 14)}check 试算</button>
      </div>
    </div>
    <div id="az-body"></div>`

  await loadAll()
  $('#az-reconcile').onclick = () => runGovern('/api/nas/authz/reconcile', '组织目录对账')
  $('#az-vacancy').onclick = () => runGovern('/api/nas/authz/leader-vacancy-scan', '负责人悬空扫描')
  $('#az-simulate').onclick = () => openSimulate()
  renderBody()
}

async function loadAll() {
  const [rulesResp, nasResp, groupsResp] = await Promise.all([
    api.get('/api/nas/authz/rules'),
    api.get('/api/nas').catch(() => ({ items: [] })),
    api.get('/api/iam/groups').catch(() => ({ groups: [] })),
  ])
  rules = rulesResp
  nasList = nasResp.items ?? []
  groupNames = new Map((groupsResp.groups ?? []).map((group) => [group.id, group.name]))
}

function renderBody() {
  const body = $('#az-body')
  body.innerHTML = `
    <div class="grid grid-2">
      <div class="card" id="az-gates"></div>
      <div class="card" id="az-matrix"></div>
    </div>
    <div class="card" id="az-exceptions" style="margin-top:12px"></div>
    <div class="grid grid-2" style="margin-top:12px">
      <div class="card" id="az-cgroups"></div>
      <div class="card" id="az-anchors"></div>
    </div>
    <div class="card" id="az-decisions" style="margin-top:12px"></div>`

  renderGates()
  renderMatrix()
  renderExceptions()
  renderCGroups()
  renderAnchors()
  renderDecisions()
}

// -- 灰度开关 ---------------------------------------------------------------

function renderGates() {
  const holder = $('#az-gates')
  const gate = (key, label, desc) => `
    <div class="flex items-center justify-between" style="padding:8px 0">
      <div>
        <div class="fs-13" style="font-weight:600">${label}</div>
        <div class="fs-11 text-4">${desc}</div>
      </div>
      <button class="btn btn-sm ${rules[key] ? 'btn-warning' : 'btn-default'}" data-gate="${key}">${rules[key] ? '已开启' : '已关闭'}</button>
    </div>`
  holder.innerHTML = `
    <div class="fs-13" style="font-weight:700;margin-bottom:6px">灰度开关（version ${rules.version}）</div>
    ${gate('observeOnly', '观察模式 observeOnly', 'deny 只告警不拦截（G0）；关闭后网关/hermes 按判定强制执行')}
    ${gate('degradeAllToReadonly', '全量降级只读 degradeAllToReadonly', '所有 allow 视作 readonly（G3 应急降级）')}
    <div class="fs-11 text-4" style="margin-top:6px">最近更新：${rules.updatedBy ? esc(rules.updatedBy) : '—'} · ${rules.updatedAt ? timeAgo(rules.updatedAt) : '—'}</div>`

  $$('#az-gates [data-gate]').forEach((btn) => {
    btn.onclick = async () => {
      const key = btn.dataset.gate
      const next = !rules[key]
      if (key === 'degradeAllToReadonly' && next) {
        const confirmed = await confirmDialog({ title: '开启全量降级只读', message: '开启后所有用户写类操作将被拒绝（应急降级 G3）。确认开启？', danger: true, confirmText: '开启降级' })
        if (!confirmed) return
      }
      try {
        rules = await api.put('/api/nas/authz/rules', { ifVersion: rules.version, [key]: next })
        toast(`已${next ? '开启' : '关闭'}（version ${rules.version}）`, 'ok')
        renderBody()
      } catch (error) {
        toast(error.message, 'error')
      }
    }
  })
}

// -- 操作矩阵 ---------------------------------------------------------------

function renderMatrix() {
  const holder = $('#az-matrix')
  const cell = (role, op) => {
    const override = rules.matrixOverrides?.[role]?.[op]
    const base = MATRIX_DEFAULT[role][op]
    const value = typeof override === 'boolean' ? override : Boolean(base)
    const mark = value ? '<span style="color:var(--ok,#16a34a)">✓</span>' : '<span class="text-5">✗</span>'
    return `<td class="col-num" title="${typeof override === 'boolean' ? `覆盖自内置 ${base ? '✓' : '✗'}` : '内置默认'}">${mark}</td>`
  }
  holder.innerHTML = `
    <div class="fs-13" style="font-weight:700;margin-bottom:6px">操作矩阵（内置默认 + 覆盖项）</div>
    <table class="table">
      <thead><tr><th>角色</th>${OPS.map((op) => `<th>${OP_LABEL[op]}</th>`).join('')}</tr></thead>
      <tbody>
        ${ROLES.map((role) => `<tr><td class="fs-12">${ROLE_LABEL[role]}</td>${OPS.map((op) => cell(role, op)).join('')}</tr>`).join('')}
        <tr><td class="fs-12">${ROLE_LABEL.C}</td><td colspan="7" class="fs-11 text-4">read/download 放行（跨域），写类一律拒绝；白名单目录写需显式例外</td></tr>
      </tbody>
    </table>
    <div class="fs-11 text-4" style="margin-top:6px">readonly 语义 = read/download 放行、写类拒绝。admin 为平台规则管理权限点，网关侧恒 deny。</div>`
}

// -- 例外列表 ---------------------------------------------------------------

function expireCountdown(iso) {
  if (!iso) return '<span class="text-4">永久</span>'
  const rest = new Date(iso).getTime() - Date.now()
  if (rest <= 0) return '<span style="color:var(--danger,#dc2626)">已过期</span>'
  const days = Math.floor(rest / 86_400_000)
  const hours = Math.floor((rest % 86_400_000) / 3_600_000)
  return `<span class="fs-12">${days}天${hours}时后到期</span>`
}

function renderExceptions() {
  const holder = $('#az-exceptions')
  const items = rules.exceptions ?? []
  holder.innerHTML = `
    <div class="flex items-center justify-between" style="margin-bottom:6px">
      <div class="fs-13" style="font-weight:700">资源级例外（显式 allow / deny，可过期）</div>
      <button class="btn btn-sm btn-primary" id="az-exc-add">${icon('plus', 12)}新建例外</button>
    </div>
    <div id="az-exc-table"></div>`
  const table = $('#az-exc-table')
  if (!items.length) {
    table.appendChild(emptyState({ title: '暂无例外', desc: '例外用于显式拒绝/授权：C 跨域白名单写、临时授权、share 审批产物等', icon: 'shield' }))
  } else {
    table.appendChild(renderTable({
      columns: [
        { title: '效果', width: 70, render: (item) => item.effect === 'allow' ? '<span style="color:var(--ok,#16a34a)">allow</span>' : '<span style="color:var(--danger,#dc2626)">deny</span>' },
        { title: 'NAS / 路径', render: (item) => `<div class="fs-12 mono">${esc(nasName(item.nasId))}</div><div class="fs-11 text-3 mono">${esc(item.path)}</div>` },
        { title: '操作', render: (item) => `<span class="fs-12">${item.ops.map((op) => OP_LABEL[op] ?? op).join('、')}</span>` },
        { title: '限定用户', render: (item) => `<span class="fs-12">${item.userIds?.length ? item.userIds.map((id) => esc(id)).join('、') : '全部'}</span>` },
        { title: '有效期', width: 130, render: (item) => expireCountdown(item.expiresAt) },
        { title: '事由', render: (item) => `<span class="fs-12 text-3">${esc(item.note ?? '—')}</span>` },
        { title: '', width: 60, render: (item) => `<button class="btn btn-sm btn-default" data-del="${esc(item.id)}">删除</button>` },
      ],
      rows: items,
    }))
  }
  $('#az-exc-add').onclick = () => openExceptionEditor()
  $$('#az-exc-table [data-del]').forEach((btn) => {
    btn.onclick = async () => {
      const confirmed = await confirmDialog({ title: '删除例外', message: `删除例外 ${btn.dataset.del}？删除立即生效并升版本留痕。`, danger: true })
      if (!confirmed) return
      try {
        rules = await api.put('/api/nas/authz/rules', { ifVersion: rules.version, exceptions: rules.exceptions.filter((item) => item.id !== btn.dataset.del) })
        toast('例外已删除', 'ok')
        renderBody()
      } catch (error) { toast(error.message, 'error') }
    }
  })
}

function openExceptionEditor(existing) {
  const modal = openModal({
    title: existing ? '编辑例外' : '新建例外',
    body: `
      ${selectField('effect', [{ value: 'deny', label: 'deny（显式拒绝）' }, { value: 'allow', label: 'allow（显式授权）' }], { value: existing?.effect ?? 'deny' })}
      ${inputField('nasId', { placeholder: 'NAS 资产 ID', value: existing?.nasId ?? '' })}
      ${inputField('path', { placeholder: '/路径前缀，/* 结尾通配子树，* 通配全部', value: existing?.path ?? '' })}
      ${inputField('ops', { placeholder: '操作，逗号分隔：read,download,write,modify,delete,share,admin', value: (existing?.ops ?? []).join(',') })}
      ${inputField('userIds', { placeholder: '限定用户 ID（可选，逗号分隔；留空=对全部用户生效）', value: (existing?.userIds ?? []).join(',') })}
      ${inputField('expiresAt', { placeholder: '到期时间 ISO（可选，如 2026-09-30T00:00:00Z）', value: existing?.expiresAt ?? '' })}
      ${inputField('note', { placeholder: '事由（审计留痕）', value: existing?.note ?? '' })}`,
    foot: `<button class="btn btn-primary" id="az-exc-save">保存</button>`,
  })
  $('#az-exc-save').onclick = async () => {
    const read = (name) => {
      const node = modal.querySelector(`[name="${name}"]`)
      return node ? node.value.trim() : ''
    }
    const record = {
      ...(existing ? { id: existing.id } : {}),
      effect: read('effect') || 'deny',
      nasId: read('nasId'),
      path: read('path'),
      ops: read('ops').split(',').map((item) => item.trim()).filter(Boolean),
      ...(read('userIds') ? { userIds: read('userIds').split(',').map((item) => item.trim()).filter(Boolean) } : {}),
      ...(read('expiresAt') ? { expiresAt: read('expiresAt') } : {}),
      ...(read('note') ? { note: read('note') } : {}),
    }
    if (!record.nasId || !record.path || record.ops.length === 0) {
      toast('nasId / path / ops 必填', 'error')
      return
    }
    try {
      rules = await api.put('/api/nas/authz/rules', { ifVersion: rules.version, exceptions: [...rules.exceptions.filter((item) => item.id !== record.id), record] })
      modal.remove()
      toast('例外已保存', 'ok')
      renderBody()
    } catch (error) { toast(error.message, 'error') }
  }
}

// -- C 关联动态组 -----------------------------------------------------------

function renderCGroups() {
  const holder = $('#az-cgroups')
  const items = (rules.cGroups ?? []).map((id) => ({ id, name: groupNames.get(id) ?? id }))
  holder.innerHTML = `
    <div class="flex items-center justify-between" style="margin-bottom:6px">
      <div class="fs-13" style="font-weight:700">C 角色关联动态用户组</div>
      <button class="btn btn-sm btn-default" id="az-cg-add">${icon('plus', 12)}关联组</button>
    </div>
    <div class="fs-11 text-4" style="margin-bottom:8px">组内成员获得跨域只读（read/download）；组重算漂移任何幅度都会发 cGroupDrift 告警。</div>
    <div id="az-cg-list">${items.length ? items.map((item) => `
      <div class="flex items-center justify-between" style="padding:6px 0;border-bottom:1px solid var(--line,#eee)">
        <span class="fs-12">${esc(item.name)}</span>
        <button class="btn btn-sm btn-default" data-cg="${esc(item.id)}">移除</button>
      </div>`).join('') : '<div class="fs-12 text-4">尚未关联动态组</div>'}</div>`

  $('#az-cg-add').onclick = () => {
    const modal = openModal({
      title: '关联 C 角色动态用户组',
      body: `${inputField('groupName', { placeholder: '动态用户组名称（如：跨域协作者）' })}`,
      foot: '<button class="btn btn-primary" id="az-cg-save">关联</button>',
    })
    $('#az-cg-save').onclick = async () => {
      const name = modal.querySelector('[name="groupName"]')?.value?.trim()
      if (!name) { toast('请填写组名', 'error'); return }
      try {
        rules = await api.put('/api/nas/authz/rules', { ifVersion: rules.version, cGroups: [...rules.cGroups ?? [], name] })
        modal.remove()
        await loadAll()
        renderBody()
        toast('已关联（按组名解析）', 'ok')
      } catch (error) { toast(error.message, 'error') }
    }
  }
  $$('#az-cg-list [data-cg]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        rules = await api.put('/api/nas/authz/rules', { ifVersion: rules.version, cGroups: (rules.cGroups ?? []).filter((id) => id !== btn.dataset.cg) })
        toast('已移除', 'ok')
        renderBody()
      } catch (error) { toast(error.message, 'error') }
    }
  })
}

// -- NAS 接入组织锚点 -------------------------------------------------------

function renderAnchors() {
  const holder = $('#az-anchors')
  holder.innerHTML = `
    <div class="fs-13" style="font-weight:700;margin-bottom:6px">NAS 接入组织锚点（作用域推导）</div>
    <div id="az-anchor-list"></div>`
  const list = $('#az-anchor-list')
  if (!nasList.length) {
    list.appendChild(emptyState({ title: '暂无 NAS 资产', desc: '先在 NAS 存储页纳管资产', icon: 'server' }))
    return
  }
  list.appendChild(renderTable({
    columns: [
      { title: '资产', render: (item) => `<div class="fs-13" style="font-weight:600">${esc(item.name)}</div><div class="fs-11 text-4 mono">${esc(item.id)}</div>` },
      { title: 'orgRoot', render: (item) => `<span class="fs-12 mono">${esc(item.attrs?.orgRoot || '（未配置 → 全 deny）')}</span>` },
      { title: 'orgPathOverrides', render: (item) => {
        const raw = item.attrs?.orgPathOverrides
        const text = typeof raw === 'string' && raw.trim() ? raw : (raw && typeof raw === 'object' ? JSON.stringify(raw) : '')
        return `<span class="fs-11 text-3 mono">${esc(text || '—')}</span>`
      } },
      { title: '', width: 70, render: () => '<button class="btn btn-sm btn-default" data-edit="1">编辑</button>' },
    ],
    rows: nasList,
    onRowClick: (id) => openAnchorEditor(nasList.find((item) => item.id === id)),
  }))
  $$('#az-anchor-list [data-edit]').forEach((btn, index) => {
    btn.onclick = (event) => {
      event.stopPropagation()
      openAnchorEditor(nasList[index])
    }
  })
}

function openAnchorEditor(nas) {
  const raw = nas?.attrs?.orgPathOverrides
  const overridesText = typeof raw === 'string' ? raw : (raw && typeof raw === 'object' ? JSON.stringify(raw, null, 2) : '')
  const modal = openModal({
    title: `接入组织锚点：${nas?.name ?? ''}`,
    body: `
      <div class="fs-11 text-4" style="margin-bottom:8px">orgRoot = 平台级组织名或 orgId（作用域推导锚点）；orgPathOverrides = orgId → 目录前缀映射，优先于名字推导（组织改名不漂移）。</div>
      ${inputField('orgRoot', { placeholder: '如「智造平台」；留空 = 该 NAS 全 deny', value: nas?.attrs?.orgRoot ?? '' })}
      ${textareaField('orgPathOverrides', { placeholder: '{"org_xxx": "/生产"}', value: overridesText, rows: 4 })}`,
    foot: '<button class="btn btn-primary" id="az-anchor-save">保存</button>',
  })
  $('#az-anchor-save').onclick = async () => {
    const orgRoot = modal.querySelector('[name="orgRoot"]')?.value?.trim() ?? ''
    const overrides = modal.querySelector('[name="orgPathOverrides"]')?.value?.trim() ?? ''
    if (overrides && !overrides.trim().startsWith('{')) {
      toast('orgPathOverrides 必须是 JSON 对象', 'error')
      return
    }
    try {
      await api.patch(`/api/nas/${nas.id}`, { attrs: { orgRoot, ...(overrides ? { orgPathOverrides: overrides } : { orgPathOverrides: '' }) } })
      modal.remove()
      await loadAll()
      renderBody()
      toast('锚点已更新', 'ok')
    } catch (error) { toast(error.message, 'error') }
  }
}

// -- 判定留痕 ---------------------------------------------------------------

async function renderDecisions() {
  const holder = $('#az-decisions')
  holder.innerHTML = `
    <div class="flex items-center justify-between" style="margin-bottom:6px">
      <div class="fs-13" style="font-weight:700">判定留痕（deny 全量 + delete/share/admin 高危；普通记录 90 天滚动、高危永久）</div>
      <button class="btn btn-sm btn-default" id="az-dec-refresh">${icon('refresh', 12)}刷新</button>
    </div>
    <div id="az-dec-table"><div class="fs-12 text-4">加载中…</div></div>`
  $('#az-dec-refresh').onclick = () => { void renderDecisions() }
  const data = await api.get('/api/nas/authz/decisions?limit=50').catch(() => ({ items: [] }))
  const table = $('#az-dec-table')
  table.innerHTML = ''
  const items = data.items ?? []
  if (!items.length) {
    table.appendChild(emptyState({ title: '暂无判定留痕', desc: 'deny 与高危操作判定会异步落痕', icon: 'scroll' }))
    return
  }
  table.appendChild(renderTable({
    columns: [
      { title: '时间', width: 100, render: (item) => `<span class="fs-11 text-4">${timeAgo(item.createdAt)}</span>` },
      { title: '判定', width: 60, render: (item) => item.decision === 'allow' ? '<span style="color:var(--ok,#16a34a)">allow</span>' : '<span style="color:var(--danger,#dc2626)">deny</span>' },
      { title: '用户 / 角色', width: 140, render: (item) => `<span class="fs-12">${esc(item.userName ?? item.userId)}${item.role ? ` · ${item.role}${item.override ? '(破窗)' : ''}` : ''}</span>` },
      { title: 'NAS / 路径', render: (item) => `<div class="fs-12 mono">${esc(nasName(item.nasId))}</div><div class="fs-11 text-3 mono">${esc((item.paths ?? []).join('、'))}</div>` },
      { title: '操作', width: 70, render: (item) => `<span class="fs-12">${OP_LABEL[item.op] ?? item.op}${item.highRisk ? ' <span class="fs-10 text-4">(高危)</span>' : ''}</span>` },
      { title: '理由', render: (item) => `<span class="fs-11 text-3">${esc((item.reasons ?? []).join('；')).slice(0, 120)}</span>` },
    ],
    rows: items,
  }))
}

// -- 试算与治理工具 ---------------------------------------------------------

function openSimulate() {
  const modal = openModal({
    title: 'check 试算',
    body: `
      <div class="fs-11 text-4" style="margin-bottom:8px">与网关/hermes 强制点同一套判定：输入用户与路径，返回决策、角色、作用域与 reasons。</div>
      ${selectField('nasId', nasList.map((item) => ({ value: item.id, label: item.name })))}
      ${inputField('userId', { placeholder: '平台 userId 或钉钉 userId' })}
      ${inputField('paths', { placeholder: '路径（多条用逗号分隔）', value: '/' })}
      ${selectField('op', OPS.map((op) => ({ value: op, label: OP_LABEL[op] })))}
      <label class="fs-12" style="display:flex;gap:6px;align-items:center;margin-top:6px"><input type="checkbox" id="az-sim-override"> override 破窗（需 nas.authz.write，强制留痕）</label>
      <div id="az-sim-result" style="margin-top:10px"></div>`,
    foot: '<button class="btn btn-primary" id="az-sim-run">判定</button>',
  })
  $('#az-sim-run').onclick = async () => {
    const read = (name) => modal.querySelector(`[name="${name}"]`)?.value?.trim() ?? ''
    const result = $('#az-sim-result')
    result.innerHTML = '<div class="fs-12 text-4">判定中…</div>'
    try {
      const data = await api.post('/api/nas/authz/check', {
        nasId: read('nasId'),
        userId: read('userId'),
        paths: read('paths').split(',').map((item) => item.trim()).filter(Boolean),
        op: read('op'),
        ...(modal.querySelector('#az-sim-override')?.checked ? { override: true } : {}),
      })
      result.innerHTML = `
        <div class="fs-13" style="font-weight:700">${data.decision === 'allow' ? '<span style="color:var(--ok,#16a34a)">ALLOW</span>' : '<span style="color:var(--danger,#dc2626)">DENY</span>'}
          <span class="fs-12 text-3">${data.role ? `角色 ${ROLE_LABEL[data.role] ?? data.role}` : '无主角色'}${data.cTag ? ' · C 叠加' : ''}${data.observeOnly ? ' · 观察模式' : ''}</span></div>
        <div class="fs-11 text-4" style="margin:4px 0">作用域：${data.scope?.length ? data.scope.map((item) => esc(item)).join('、') : '（无）'}</div>
        ${(data.reasons ?? []).map((reason) => `<div class="fs-11 text-3">· ${esc(reason)}</div>`).join('')}
        <div class="fs-11 text-4" style="margin-top:6px">作用域快照：${hEscape(JSON.stringify(data.scope ?? []))}</div>`
    } catch (error) {
      result.innerHTML = `<div class="fs-12" style="color:var(--danger,#dc2626)">${esc(error.message)}</div>`
    }
  }
}

async function runGovern(path, label) {
  try {
    const data = await api.post(path)
    const rows = data.report ?? data.vacant ?? []
    if (!rows.length) { toast(`${label}：无发现`, 'ok'); return }
    openDrawer({
      title: `${label}结果（${rows.length}）`,
      body: `<div>${rows.map((row) => `
        <div style="padding:8px 0;border-bottom:1px solid var(--line,#eee)">
          <div class="fs-12" style="font-weight:600">${esc(row.nasName ?? row.orgName ?? '')}</div>
          ${(row.findings ?? []).map((finding) => `<div class="fs-11 text-3">· ${esc(finding.detail)}</div>`).join('') || '<div class="fs-11 text-4">（无明细）</div>'}
        </div>`).join('')}</div>`,
    })
  } catch (error) {
    toast(error.message, 'error')
  }
}

function nasName(id) {
  return nasList.find((item) => item.id === id)?.name ?? id
}

function hEscape(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// session 引用占位：与其它页面一致的导入形态（未来按用户收敛视图时使用）
void session
