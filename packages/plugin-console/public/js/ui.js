/** 组件库：Toast / Drawer / Modal / 图表 / 徽章 / 空状态 / 表格 / 下拉。 */
import { icon, PATHS } from './icons.js'

// ---------- 基础 DOM 助手 ----------
export function h(html) {
  const tpl = document.createElement('template')
  tpl.innerHTML = html.trim()
  return tpl.content.firstElementChild
}
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}
export function $(selector, root = document) { return root.querySelector(selector) }
export function $$(selector, root = document) { return [...root.querySelectorAll(selector)] }

// ---------- 格式化 ----------
export function fmtNum(value) {
  const n = Number(value ?? 0)
  if (n >= 1e8) return (n / 1e8).toFixed(1) + ' 亿'
  if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 万'
  return n.toLocaleString('zh-CN')
}
export function fmtCost(value) {
  return `¥${Number(value ?? 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
export function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
export function timeAgo(iso) {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return Math.floor(diff / 60_000) + ' 分钟前'
  if (diff < 86400_000) return Math.floor(diff / 3600_000) + ' 小时前'
  if (diff < 7 * 86400_000) return Math.floor(diff / 86400_000) + ' 天前'
  return fmtTime(iso)
}
export function fmtPct(value) {
  return `${Math.round(Number(value ?? 0) * 1000) / 10}%`
}

// ---------- 状态徽章 ----------
const STATUS_MAP = {
  online: ['badge-ok', '已上线'], published: ['badge-ok', '已上架'], active: ['badge-ok', '正常'], healthy: ['badge-ok', '健康'], ok: ['badge-ok', '成功'],
  gray: ['badge-info', '灰度中'], trial: ['badge-info', '试运行'], pending: ['badge-warn', '待激活'], pending_approval: ['badge-warn', '待审批'],
  verifying: ['badge-info', '验证中'], scanning: ['badge-info', '扫描中'], pending_domain: ['badge-warn', '待领域审批'], pending_security: ['badge-warn', '待安全加签'],
  draft: ['badge-muted', '开发中'], archived: ['badge-muted', '已归档'], deprecated: ['badge-muted', '已弃用'], unknown: ['badge-muted', '未知'],
  degraded: ['badge-warn', '降级'], offline: ['badge-warn', '已下线'], down: ['badge-danger', '不可用'], unhealthy: ['badge-danger', '异常'],
  rejected: ['badge-danger', '已驳回'], error: ['badge-danger', '失败'], denied: ['badge-danger', '拒绝'], frozen: ['badge-danger', '已冻结'],
  deactivated: ['badge-muted', '已注销'], approved: ['badge-ok', '已通过'], executed: ['badge-ok', '已执行'], failed: ['badge-danger', '执行失败'],
}
export function statusBadge(status, label) {
  const [cls, text] = STATUS_MAP[status] ?? ['badge-muted', status]
  return `<span class="badge ${cls}">${esc(label ?? text)}</span>`
}
export function resultBadge(result) {
  const map = { ok: ['badge-ok', '成功'], denied: ['badge-danger', '拒绝'], error: ['badge-danger', '异常'] }
  const [cls, text] = map[result] ?? ['badge-muted', result]
  return `<span class="badge ${cls} no-dot">${text}</span>`
}
export function auditTypeBadge(type) {
  const map = { auth: ['badge-brand', '认证'], authz: ['badge-purple', '授权'], invoke: ['badge-info', '调用'], change: ['badge-warn', '变更'] }
  const [cls, text] = map[type] ?? ['badge-muted', type]
  return `<span class="badge ${cls} no-dot">${text}</span>`
}

// ---------- Toast ----------
let toastWrap
export function toast(message, type = 'success') {
  if (!toastWrap) {
    toastWrap = h('<div class="toast-wrap"></div>')
    document.body.appendChild(toastWrap)
  }
  const el = h(`<div class="toast toast-${type}">${icon(type === 'success' ? 'check' : type === 'error' ? 'alert' : 'info')}<span>${esc(message)}</span></div>`)
  toastWrap.appendChild(el)
  setTimeout(() => {
    el.classList.add('out')
    setTimeout(() => el.remove(), 300)
  }, 2600)
}

// ---------- Drawer ----------
export function openDrawer({ title, sub, body, foot, wide, onClose }) {
  closeDrawer()
  const mask = h('<div class="drawer-mask"></div>')
  const drawer = h(`
    <div class="drawer ${wide ? 'drawer-wide' : ''}">
      <div class="drawer-head">
        <div class="grow">
          <div class="drawer-title">${title}</div>
          ${sub ? `<div class="drawer-sub">${sub}</div>` : ''}
        </div>
        <button class="drawer-close" title="关闭">${icon('x')}</button>
      </div>
      <div class="drawer-body"></div>
      ${foot ? '<div class="drawer-foot"></div>' : ''}
    </div>`)
  const bodyEl = drawer.querySelector('.drawer-body')
  if (typeof body === 'string') bodyEl.innerHTML = body
  else if (body) bodyEl.appendChild(body)
  if (foot) {
    const footEl = drawer.querySelector('.drawer-foot')
    if (typeof foot === 'string') footEl.innerHTML = foot
    else footEl.appendChild(foot)
  }
  const close = () => {
    drawer.classList.remove('show')
    mask.classList.remove('show')
    setTimeout(() => { drawer.remove(); mask.remove(); onClose?.() }, 260)
  }
  drawer.querySelector('.drawer-close').onclick = close
  mask.onclick = close
  document.body.append(mask, drawer)
  requestAnimationFrame(() => { mask.classList.add('show'); drawer.classList.add('show') })
  return { el: drawer, body: bodyEl, close }
}

export function closeDrawer() {
  document.querySelectorAll('.drawer').forEach((el) => el.remove())
  document.querySelectorAll('.drawer-mask').forEach((el) => el.remove())
}

// ---------- Modal ----------
export function openModal({ title, body, foot, wide, onClose }) {
  closeModal()
  const mask = h('<div class="modal-mask"></div>')
  const modal = h(`
    <div class="modal ${wide ? 'modal-lg' : ''}">
      <div class="modal-head"><div class="modal-title">${title}</div></div>
      <div class="modal-body"></div>
      ${foot ? '<div class="modal-foot"></div>' : '<div style="height:14px"></div>'}
    </div>`)
  const bodyEl = modal.querySelector('.modal-body')
  if (typeof body === 'string') bodyEl.innerHTML = body
  else if (body) bodyEl.appendChild(body)
  if (foot) {
    const footEl = modal.querySelector('.modal-foot')
    if (typeof foot === 'string') footEl.innerHTML = foot
    else footEl.appendChild(foot)
    // 默认行为：foot 按钮点击即关闭；调用方后续绑定的 onclick 会覆盖此默认值
    const cancelBtn = footEl.querySelector('[data-cancel]')
    if (cancelBtn) cancelBtn.onclick = () => close()
    const okBtn = footEl.querySelector('[data-ok]')
    if (okBtn) okBtn.onclick = () => close()
  }
  const close = () => { modal.classList.remove('show'); mask.classList.remove('show'); setTimeout(() => { modal.remove(); mask.remove(); onClose?.() }, 200) }
  mask.onclick = (e) => { if (e.target === mask) close() }
  document.body.appendChild(mask)
  mask.appendChild(modal)
  requestAnimationFrame(() => { mask.classList.add('show'); modal.classList.add('show') })
  return { el: modal, body: bodyEl, close }
}

export function closeModal() {
  document.querySelectorAll('.modal').forEach((el) => el.remove())
  document.querySelectorAll('.modal-mask').forEach((el) => el.remove())
}

/** 确认弹窗（支持必填原因，用于 L4 高危操作）。 */
export function confirmDialog({ title, message, requireReason, danger, confirmText = '确认' }) {
  return new Promise((resolve) => {
    const modal = openModal({
      title,
      body: `
        <div class="muted-box" style="display:flex;gap:10px;align-items:flex-start">
          <span style="color:var(--${danger ? 'danger' : 'warn'});flex-shrink:0;margin-top:1px">${icon('alert', 17)}</span>
          <div>${message}</div>
        </div>
        ${requireReason ? `
        <div class="form-item" style="margin-top:14px;margin-bottom:0">
          <label class="form-label">操作原因<span class="req">*</span></label>
          <textarea class="form-control" id="dlg-reason" placeholder="将写入审计日志，请说明本次操作的业务背景"></textarea>
          <div class="form-hint">高危操作的原因将永久留痕，供审计回溯</div>
        </div>` : ''}`,
      foot: `<button class="btn btn-default" id="dlg-cancel">取消</button>
             <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="dlg-ok">${esc(confirmText)}</button>`,
      onClose: () => resolve(null),
    })
    modal.el.querySelector('#dlg-cancel').onclick = () => { modal.close(); resolve(null) }
    modal.el.querySelector('#dlg-ok').onclick = () => {
      const reason = modal.body.querySelector('#dlg-reason')?.value.trim()
      if (requireReason && !reason) {
        toast('请填写操作原因（审计要求）', 'error')
        return
      }
      modal.close()
      resolve({ ok: true, reason })
    }
  })
}

// ---------- 空状态 ----------
export function emptyState({ title, desc, actionText, onAction, icon: ic = 'box' }) {
  const el = h(`
    <div class="empty">
      <div class="empty-ill">${gradientIll(ic)}</div>
      <h3>${esc(title)}</h3>
      <p>${esc(desc)}</p>
      ${actionText ? `<button class="btn btn-primary">${icon('plus', 14)}${esc(actionText)}</button>` : ''}
    </div>`)
  if (actionText && onAction) el.querySelector('button').onclick = onAction
  return el
}

function gradientIll(ic) {
  return `
    <svg viewBox="0 0 128 96" width="128" height="96">
      <defs>
        <linearGradient id="eg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#c7d2fe"/><stop offset="1" stop-color="#e0e7ff"/>
        </linearGradient>
      </defs>
      <rect x="14" y="18" width="100" height="62" rx="10" fill="url(#eg)"/>
      <rect x="24" y="30" width="44" height="7" rx="3.5" fill="#fff" opacity=".9"/>
      <rect x="24" y="43" width="64" height="7" rx="3.5" fill="#fff" opacity=".75"/>
      <rect x="24" y="56" width="52" height="7" rx="3.5" fill="#fff" opacity=".6"/>
      <circle cx="97" cy="61" r="15" fill="#4f6ef7" opacity=".14"/>
      <g transform="translate(89,53)" stroke="#4f6ef7" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round">
        ${iconRaw(ic, 16)}
      </g>
    </svg>`
}
function iconRaw(name, size) {
  // 复用 icons 中的 path（避免嵌套 svg）：此处直接内嵌一个子 svg
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${PATH_CACHE[name] ?? ''}</svg>`
}
const PATH_CACHE = PATHS

// ---------- SVG 图表 ----------
export function sparkline(values, { width = 220, height = 48, color = '#4f6ef7', fill = true } = {}) {
  if (!values?.length) return '<span class="text-4 fs-12">暂无数据</span>'
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const span = max - min || 1
  const step = values.length > 1 ? width / (values.length - 1) : width
  const points = values.map((v, i) => [i * step, height - 4 - ((v - min) / span) * (height - 10)])
  const line = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join('')
  const area = `${line}L${width},${height}L0,${height}Z`
  const gid = 'g' + Math.random().toString(36).slice(2, 8)
  return `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="display:block">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${color}" stop-opacity=".22"/><stop offset="1" stop-color="${color}" stop-opacity="0"/>
      </linearGradient></defs>
      ${fill ? `<path d="${area}" fill="url(#${gid})"/>` : ''}
      <path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${points.at(-1)[0]}" cy="${points.at(-1)[1]}" r="3" fill="${color}"/>
    </svg>`
}

export function barChart(items, { width = 560, height = 170, color = '#4f6ef7', format = (v) => v } = {}) {
  if (!items?.length) return '<div class="text-4 fs-12" style="padding:20px">暂无数据</div>'
  const max = Math.max(...items.map((i) => i.value), 1)
  const gap = 6
  const barW = Math.max(4, (width - gap * (items.length - 1)) / items.length)
  const bars = items.map((item, i) => {
    const barH = Math.max(2, (item.value / max) * (height - 34))
    const x = i * (barW + gap)
    const y = height - 22 - barH
    const w = barW
    return `
      <rect x="${x}" y="${y}" width="${w}" height="${barH}" rx="3" fill="${color}" opacity="${0.55 + 0.45 * (item.value / max)}">
        <title>${esc(item.label)}: ${esc(format(item.value))}</title>
      </rect>
      ${items.length <= 16 || i % Math.ceil(items.length / 12) === 0 ? `<text x="${x + w / 2}" y="${height - 7}" font-size="9" fill="#8a8f99" text-anchor="middle">${esc(item.label.slice(5))}</text>` : ''}`
  }).join('')
  return `<svg width="100%" viewBox="0 0 ${width} ${height}" style="display:block">${bars}</svg>`
}

export function lineChart(series, { width = 560, height = 170, colors = ['#4f6ef7', '#10b981', '#f59e0b'], labels = [] } = {}) {
  const all = series.flat()
  if (!all.length) return '<div class="text-4 fs-12" style="padding:20px">暂无数据</div>'
  const max = Math.max(...all, 1)
  const n = Math.max(...series.map((s) => s.length))
  const step = n > 1 ? width / (n - 1) : width
  const paths = series.map((values, si) => {
    const points = values.map((v, i) => [i * step, height - 26 - (v / max) * (height - 44)])
    const line = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join('')
    return `<path d="${line}" fill="none" stroke="${colors[si % colors.length]}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
  }).join('')
  return `<svg width="100%" viewBox="0 0 ${width} ${height}" style="display:block">${paths}</svg>`
}

export function donut(segments, size = 120) {
  const total = segments.reduce((s, seg) => s + seg.value, 0) || 1
  const r = size / 2 - 10
  const c = 2 * Math.PI * r
  let offset = 0
  const arcs = segments.map((seg) => {
    const len = (seg.value / total) * c
    const arc = `<circle r="${r}" cx="${size / 2}" cy="${size / 2}" fill="none" stroke="${seg.color}" stroke-width="12" stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${size / 2} ${size / 2})"><title>${esc(seg.label)}: ${esc(String(seg.value))}</title></circle>`
    offset += len
    return arc
  }).join('')
  return `<svg width="${size}" height="${size}">${arcs}</svg>`
}

// ---------- 表格 ----------
export function renderTable({ columns, rows, rowKey = (row, i) => row.id ?? i, onRowClick, empty = '暂无数据' }) {
  if (!rows?.length) {
    const el = h('<div class="card"></div>')
    el.appendChild(emptyState({ title: empty, desc: '当前筛选条件下没有匹配记录', icon: 'search' }))
    return el
  }
  const head = columns.map((col) => `<th style="${col.width ? `width:${col.width}` : ''}">${col.title}</th>`).join('')
  const body = rows.map((row, i) => `
    <tr data-key="${esc(String(rowKey(row, i)))}">
      ${columns.map((col) => `<td class="${col.cls ?? ''}">${col.render ? col.render(row, i) : esc(row[col.key])}</td>`).join('')}
    </tr>`).join('')
  const el = h(`
    <div class="card table-wrap">
      <table class="tbl">
        <thead><tr>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`)
  if (onRowClick) {
    el.querySelectorAll('tbody tr').forEach((tr) => {
      tr.onclick = (e) => {
        if (e.target.closest('button, a, input, select, .stop')) return
        onRowClick(rowKey(rowOf(tr, rows, rowKey)), rowOf(tr, rows, rowKey))
      }
    })
  }
  return el
}
function rowOf(tr, rows, rowKey) {
  const key = tr.dataset.key
  return rows.find((row, i) => String(rowKey(row, i)) === key)
}

// ---------- 下拉菜单 ----------
export function attachDropdown(anchorEl, menuBuilder) {
  let menu = null
  const close = (e) => {
    if (menu && !menu.contains(e.target) && !anchorEl.contains(e.target)) {
      menu.remove(); menu = null
      document.removeEventListener('click', close)
    }
  }
  anchorEl.addEventListener('click', (e) => {
    e.stopPropagation()
    if (menu) { menu.remove(); menu = null; return }
    menu = h(`<div class="dropdown-menu"></div>`)
    menuBuilder(menu)
    const wrap = anchorEl.closest('.dropdown') ?? anchorEl.parentElement
    wrap.style.position = 'relative'
    wrap.classList.add('dropdown')
    wrap.appendChild(menu)
    document.addEventListener('click', close)
  })
}

// ---------- 表单收集 ----------
export function collectForm(rootEl) {
  const data = {}
  rootEl.querySelectorAll('[name]').forEach((el) => {
    if (el.type === 'checkbox') data[el.name] = el.checked
    else data[el.name] = el.value.trim ? el.value.trim() : el.value
  })
  return data
}

export function field(label, inputHtml, { hint, required, full } = {}) {
  return `
    <div class="form-item ${full ? 'full' : ''}">
      <label class="form-label">${esc(label)}${required ? '<span class="req">*</span>' : ''}</label>
      ${inputHtml}
      ${hint ? `<div class="form-hint">${esc(hint)}</div>` : ''}
    </div>`
}

export function inputField(name, { placeholder, value, lg } = {}) {
  return `<input class="input ${lg ? 'input-lg' : ''}" name="${name}" placeholder="${esc(placeholder ?? '')}" value="${esc(value ?? '')}">`
}

export function selectField(name, options, { value } = {}) {
  return `<select class="select" name="${name}">${options.map((opt) =>
    `<option value="${esc(opt.value)}" ${opt.value === value ? 'selected' : ''}>${esc(opt.label)}</option>`).join('')}</select>`
}

export function textareaField(name, { placeholder, value, rows = 3 } = {}) {
  return `<textarea class="form-control" name="${name}" rows="${rows}" placeholder="${esc(placeholder ?? '')}">${esc(value ?? '')}</textarea>`
}

// ---------- 分页 ----------
export function pagination(total, page, pageSize, onPage) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  if (pages <= 1) return h('<span></span>')
  const el = h(`
    <div class="flex" style="justify-content:flex-end;margin-top:14px;gap:6px">
      <span class="fs-12 text-3">共 ${total} 条</span>
      <button class="btn btn-ghost btn-sm" data-p="${page - 1}" ${page <= 1 ? 'disabled' : ''}>‹ 上一页</button>
      <span class="fs-13" style="padding:0 6px">${page} / ${pages}</span>
      <button class="btn btn-ghost btn-sm" data-p="${page + 1}" ${page >= pages ? 'disabled' : ''}>下一页 ›</button>
    </div>`)
  el.querySelectorAll('button[data-p]').forEach((btn) => {
    btn.onclick = () => onPage(Number(btn.dataset.p))
  })
  return el
}
