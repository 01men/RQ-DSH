/** 资产登记引导（WP-08/E1+E2）：「你要登记什么？」四磁贴 + 共性字段预填 + 合规声明 + 描述可 embedding 校验。 */
import { api, session } from '../api.js'
import { icon } from '../icons.js'
import { h, $, esc, toast } from '../ui.js'

/**
 * 磁贴时序（R3 缓解）：即期三类直通真实入口；文档/知识包=NAS 已授权目录登记（kb.ingest 深化期置灰）；
 * 数据/模型=管理员通道（数据走 nas-authz 授权目录，模型走 modelgw，非自助登记）。
 */
const TILES = [
  { id: 'skill', icon: 'sparkles', title: '提示词 / 技能', desc: '可复用的提示词模板与技能包，走 Skill 市场两级审批上架', badge: '即期', href: '#/skills', perm: 'skill.read', enabled: true },
  { id: 'app', icon: 'app', title: '自动化流程', desc: 'AI 应用（app）登记，自带 SSO 上线门禁与审批流', badge: '即期', href: '#/apps', perm: 'app.read', enabled: true },
  { id: 'mcp', icon: 'plug', title: '接口 / 工具', desc: 'MCP 服务注册：verifying → gray → online 灰度上线', badge: '即期', href: '#/mcp', perm: 'mcp.service.read', enabled: true },
  { id: 'nas', icon: 'server', title: '文档 / 知识包', desc: '以「NAS 已授权目录登记」承接（授权范围必选）；kb.ingest 深化期开放', badge: 'kb.ingest 深化期', href: '#/nas-authz', perm: 'nas.read', enabled: true, grey: true },
  { id: 'data', icon: 'layers', title: '数据目录', desc: '数据资产=NAS 授权目录（走数据权限五步判定），登记前先申请授权范围', badge: '管理员通道', href: '#/nas-authz', perm: 'nas.read', enabled: true },
  { id: 'model', icon: 'cpu', title: '模型接入', desc: '模型由管理员经 modelgw 统一接入（非自助登记），这里仅查看已接入模型', badge: '管理员通道', href: '#/assets', perm: 'usage.read', enabled: true },
]

const PLATFORMS = [
  { id: 'strategy', label: '战略' }, { id: 'marketing', label: '营销' }, { id: 'manufacturing', label: '智造' },
  { id: 'rd', label: '研发' }, { id: 'quality', label: '质量' },
]
const SECRET_LEVELS = [
  { id: 'internal', label: '内部公开' }, { id: 'secret', label: '秘密（部门内）' }, { id: 'confidential', label: '机密（点名授权）' },
]

/** E2 描述规范（未来可 embedding）：长度 ≥20 字 + 至少 2 个空格/标点分隔的关键词段。 */
function describeCheck(text) {
  const trimmed = (text ?? '').trim()
  const lengthOk = trimmed.length >= 20
  const segments = trimmed.split(/[\s,，、;；|/]+/).filter((part) => part.length > 0)
  const keywordsOk = segments.length >= 2
  return { lengthOk, keywordsOk, segments: segments.length, ok: lengthOk && keywordsOk, hint: !lengthOk ? '至少 20 字（描述越具体，语义召回越准）' : !keywordsOk ? '建议用空格或标点分隔 2 个以上关键词（如「客服 工单 检索」）' : '描述质量已满足 embedding 规范 ✓' }
}

export function renderRegister(content) {
  const user = session.user ?? {}
  const tiles = TILES.filter((tile) => !tile.perm || session.can(tile.perm))

  content.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">登记新资产</div>
        <div class="page-desc">五类资产一套登记纪律：登记 → 审批 → 上架 → 授权 → 调用 → 回传，全链路留痕。先完成登记前自检，再进入对应入口。</div>
      </div>
    </div>

    <div class="card mb-20">
      <div class="card-head"><span class="card-title">${icon('zap', 15)} 你要登记什么？</span></div>
      <div class="card-body"><div class="reg-tile-grid">
        ${tiles.map((tile) => `
          <div class="reg-tile ${tile.enabled ? '' : 'reg-tile-disabled'}" data-tile="${tile.id}" data-href="${tile.href}" tabindex="0" role="link">
            <div class="reg-tile-top">
              <span class="reg-tile-icon">${icon(tile.icon, 20)}</span>
              <span class="badge ${tile.grey ? 'badge-muted' : 'badge-ok'} no-dot">${tile.badge}</span>
            </div>
            <div class="reg-tile-title">${esc(tile.title)}</div>
            <div class="reg-tile-desc">${esc(tile.desc)}</div>
          </div>`).join('')}
      </div></div>
    </div>

    <div class="card mb-20">
      <div class="card-head"><span class="card-title">${icon('shieldCheck', 15)} 登记前自检（共性字段预填）</span></div>
      <div class="card-body">
        <div class="reg-form">
          <div class="form-item">
            <label class="form-label">负责人（owner，预填当前登录人）</label>
            <input class="input" id="reg-owner" value="${esc(user.displayName ?? '')}" data-username="${esc(user.username ?? '')}">
          </div>
          <div class="form-item">
            <label class="form-label">目标平台</label>
            <select class="input" id="reg-platform">
              ${PLATFORMS.map((platform) => `<option value="${platform.id}">${platform.label}</option>`).join('')}
            </select>
          </div>
          <div class="form-item">
            <label class="form-label">部门（预填登录人所在组织）</label>
            <input class="input" id="reg-dept" value="${esc(user.orgId ?? '')}" placeholder="组织 ID（默认当前组织）">
          </div>
          <div class="form-item">
            <label class="form-label">密级</label>
            <select class="input" id="reg-secret">
              ${SECRET_LEVELS.map((level) => `<option value="${level.id}">${level.label}</option>`).join('')}
            </select>
          </div>
          <div class="form-item" style="grid-column:1/-1">
            <label class="form-label">资产描述（E2 规范：面向未来语义召回的写法）</label>
            <textarea class="input" id="reg-desc" rows="3" placeholder="例：客服 工单检索——按工单号/客户/现象检索历史工单并汇总处理建议，面向客服坐席与质检员。"></textarea>
            <div class="form-hint" id="reg-desc-hint">至少 20 字，用空格或标点分隔关键词（谁用、做什么、覆盖什么场景）。</div>
          </div>
          <div class="form-item" style="grid-column:1/-1">
            <label class="flex" style="gap:8px;align-items:flex-start;cursor:pointer">
              <input type="checkbox" id="reg-compliance" style="margin-top:3px">
              <span class="fs-12 text-2">合规声明：我确认该资产来源合法、不含未授权的第三方版权内容与个人敏感信息；密级标注属实；上架后接受平台审计、计量与权限治理（审批流将留存本声明）。</span>
            </label>
          </div>
        </div>
        <div class="flex" style="gap:10px;margin-top:6px">
          <button class="btn btn-primary" id="reg-continue" disabled>继续到登记入口</button>
          <span class="fs-12 text-4" id="reg-status">先勾选合规声明并完成描述自检</span>
        </div>
      </div>
    </div>`

  const descEl = $('#reg-desc')
  const hintEl = $('#reg-desc-hint')
  const continueBtn = $('#reg-continue')
  const statusEl = $('#reg-status')
  const compliance = $('#reg-compliance')
  let descState = { ok: false }

  const refresh = () => {
    descState = describeCheck(descEl.value)
    hintEl.textContent = descState.hint
    hintEl.style.color = descState.ok ? 'var(--ok)' : 'var(--text-4)'
    const ready = descState.ok && compliance.checked
    continueBtn.disabled = !ready
    statusEl.textContent = ready ? `自检通过（${descState.segments} 个关键词段）→ 选择下方磁贴继续`
      : compliance.checked ? '描述未达 embedding 规范' : '先勾选合规声明并完成描述自检'
  }
  descEl.addEventListener('input', refresh)
  compliance.addEventListener('change', refresh)
  refresh()

  // 自检通过后：预填摘要写入会话内存（同页跳转可用），再跳目标入口；磁贴点击直接跳转
  const preflight = () => {
    try {
      sessionStorage.setItem('rq_register_preflight', JSON.stringify({
        owner: $('#reg-owner').value, username: $('#reg-owner').dataset.username,
        platform: $('#reg-platform').value, dept: $('#reg-dept').value,
        secret: $('#reg-secret').value, description: descEl.value.trim(),
        complianceAt: new Date().toISOString(),
      }))
    } catch { /* 忽略：预填是增强不是门禁 */ }
  }
  continueBtn.onclick = () => {
    preflight()
    toast('登记自检已通过，选择对应磁贴继续', 'ok')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  content.querySelectorAll('.reg-tile').forEach((tile) => {
    tile.onclick = () => {
      if (descState.ok) preflight()
      location.hash = tile.dataset.href
    }
    tile.onkeydown = (event) => { if (event.key === 'Enter') tile.onclick() }
  })
}
