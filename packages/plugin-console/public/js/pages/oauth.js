/**
 * OAuth 协议页（平台作为身份源 IdP 的三个对外页面，独立于控制台外壳）：
 *   #/oauth/authorize?req=<id> —— 授权确认（无会话渲染登录面板；有会话按需 consent）
 *   #/oauth/error?error=…     —— 协议错误页（静态展示，error_description 一律转义）
 *   #/oauth/logout?…          —— RP 发起登出中转（清平台会话后带 state 跳回应用）
 * 说明：本页直连原始 fetch（不经 api.js 会话拦截），保证协议流不被控制台跳转劫持。
 */
import { session } from '../api.js'
import { icon } from '../icons.js'
import { esc } from '../ui.js'

const SCOPE_LABEL = {
  openid: '确认你的身份标识（sub，平台内稳定不变）',
  profile: '读取基础资料（用户名 / 姓名 / 组织 / 角色 / 租户）',
  email: '读取邮箱地址',
}

/** 原始 JSON 请求（不带 {ok,data} 包裹处理逻辑的平台内部约定由本页自行解析）。 */
async function rawJson(method, path, body) {
  const headers = { 'content-type': 'application/json' }
  if (session.token) headers.authorization = `Bearer ${session.token}`
  const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  let payload = null
  try { payload = await response.json() } catch { /* ignore */ }
  return { status: response.status, payload }
}

function pageShell(inner) {
  return `
    <div class="oauth-page">
      <div class="oauth-card">
        <div class="oauth-brand">
          <img class="brand-mark brand-logo" src="/rongqi_ai.png" alt="榕器">
          <div>
            <div class="oauth-title">榕器|企业AI资源治理平台</div>
            <div class="oauth-sub">统一身份源 · OIDC 授权</div>
          </div>
        </div>
        ${inner}
      </div>
    </div>`
}

/** 错误码 → 中文说明（协议错误码保持原文透传）。 */
const ERROR_LABEL = {
  invalid_request: '授权请求参数不完整或非法',
  unauthorized_client: '客户端未登记或已被禁用',
  unsupported_response_type: '仅支持授权码模式（response_type=code）',
  invalid_scope: '申请的授权范围（scope）未获平台允许',
  access_denied: '授权被拒绝',
}

// -- 授权确认页 -------------------------------------------------------------

export async function renderOauthAuthorize(app, params) {
  const reqId = params.get('req') ?? ''
  if (!reqId) {
    renderOauthError(app, new URLSearchParams({ error: 'invalid_request', error_description: '缺少 req 参数（授权请求无效）' }))
    return
  }
  app.innerHTML = pageShell('<div class="oauth-sub">正在加载授权请求…</div>')
  let info
  try {
    const result = await rawJson('GET', `/api/authn/oidc/auth-requests/${encodeURIComponent(reqId)}`)
    if (result.status !== 200 || !result.payload?.clientName) throw new Error(result.payload?.error_description ?? '授权请求无效、已使用或已过期')
    info = result.payload
  } catch (error) {
    renderOauthError(app, new URLSearchParams({ error: 'invalid_request', error_description: error.message }))
    return
  }
  // 无平台会话：先渲染登录面板（登录成功后回到授权确认）
  if (!session.token) {
    renderLoginPanel(app, reqId, info)
    return
  }
  renderConsent(app, reqId, info)
}

function renderLoginPanel(app, reqId, info) {
  app.innerHTML = pageShell(`
    <div class="oauth-sub" style="margin-bottom:14px">登录平台账号后继续授权给 <b>${esc(info.clientName)}</b></div>
    <form id="oauth-login-form">
      <div class="form-item">
        <label class="form-label">用户名</label>
        <input class="input input-lg" id="oauth-login-user" placeholder="平台用户名" autocomplete="username">
      </div>
      <div class="form-item">
        <label class="form-label">密码</label>
        <input class="input input-lg" id="oauth-login-pass" type="password" placeholder="密码" autocomplete="current-password">
      </div>
      <button class="btn btn-primary btn-lg btn-block" id="oauth-login-submit" type="submit">登录并继续</button>
    </form>`)
  const form = app.querySelector('#oauth-login-form')
  form.onsubmit = async (event) => {
    event.preventDefault()
    const btn = app.querySelector('#oauth-login-submit')
    btn.classList.add('btn-loading')
    try {
      const result = await rawJson('POST', '/api/auth/login', {
        username: app.querySelector('#oauth-login-user').value.trim(),
        password: app.querySelector('#oauth-login-pass').value,
      })
      if (result.status !== 200 || !result.payload?.ok) throw new Error(result.payload?.error?.message ?? '登录失败')
      session.save(result.payload.data.token, result.payload.data.user)
      if (result.payload.data.refreshToken) session.saveRefresh(result.payload.data.refreshToken)
      renderConsent(app, reqId, info)
    } catch (error) {
      btn.classList.remove('btn-loading')
      const tip = app.querySelector('#oauth-login-tip')
      if (tip) tip.textContent = error.message
      else form.insertAdjacentHTML('beforeend', `<div class="form-hint" id="oauth-login-tip" style="color:var(--danger);margin-top:10px">${esc(error.message)}</div>`)
    }
  }
}

function renderConsent(app, reqId, info) {
  const user = session.user
  const scopes = String(info.scope ?? '').split(/\s+/).filter(Boolean)
  app.innerHTML = pageShell(`
    <div class="oauth-sub">应用请求获得以下授权：</div>
    <div class="oauth-app">
      <div class="oauth-app-ic">${info.appRef ? '✨' : '🔗'}</div>
      <div>
        <b>${esc(info.clientName)}</b>
        <span>${info.appRef ? `平台登记应用 · ${esc(info.appRef.name)}` : '外部登记客户端'}</span>
      </div>
    </div>
    <div class="oauth-scopes">
      ${scopes.map((scope) => `
        <div class="oauth-scope">${icon('check', 15)}<span><b>${esc(scope)}</b> · ${esc(SCOPE_LABEL[scope] ?? '自定义授权范围')}</span></div>`).join('')}
    </div>
    <div class="oauth-user">
      <div class="avatar sm">${esc((user?.displayName ?? '?').slice(0, 1))}</div>
      <span>将以 <b>${esc(user?.displayName ?? '当前用户')}</b> 身份授权${info.consentRequired ? '，授权后应用可在此后静默获取你的身份信息' : ''}</span>
    </div>
    ${info.consentRequired ? `
    <label class="flex" style="gap:8px;font-size:13px;margin-bottom:14px;cursor:pointer">
      <input type="checkbox" id="oauth-consent-check" style="accent-color:var(--brand-500)">
      <span>我已了解并同意向该应用提供上述信息</span>
    </label>` : ''}
    <div class="oauth-actions">
      ${info.consentRequired ? '<button class="btn btn-default" id="oauth-deny">拒绝</button>' : ''}
      <button class="btn btn-primary" id="oauth-approve">${info.consentRequired ? '同意并授权' : '确认授权'}</button>
    </div>
    <div class="form-hint" id="oauth-consent-tip" style="margin-top:12px"></div>`)
  const approve = app.querySelector('#oauth-approve')
  const deny = app.querySelector('#oauth-deny')
  const submit = async (consent) => {
    approve.classList.add('btn-loading')
    try {
      const result = await rawJson('POST', '/api/authn/oidc/authorize', { reqId, consent })
      if (result.status !== 200 || !result.payload?.location) {
        if (result.status === 401) {
          session.clear()
          renderLoginPanel(app, reqId, info)
          return
        }
        throw new Error(result.payload?.error_description ?? '授权失败，请从应用重新发起')
      }
      approve.textContent = consent ? '已授权，正在跳转…' : '已拒绝，正在跳转…'
      window.location.href = result.payload.location
    } catch (error) {
      approve.classList.remove('btn-loading')
      app.querySelector('#oauth-consent-tip').textContent = error.message
    }
  }
  approve.onclick = () => {
    if (info.consentRequired && !app.querySelector('#oauth-consent-check')?.checked) {
      app.querySelector('#oauth-consent-tip').textContent = '请先勾选同意后再授权'
      return
    }
    void submit(true)
  }
  if (deny) deny.onclick = () => void submit(false)
  // 无需显式同意的客户端（平台登记应用默认形态）：登录即静默完成授权跳转
  if (!info.consentRequired) void submit(true)
}

// -- 错误页 -------------------------------------------------------------------

export function renderOauthError(app, params) {
  const error = params.get('error') ?? 'invalid_request'
  // error_description 来源可能是任意外部输入，展示前必须转义（不自动跳转）
  const description = params.get('error_description') ?? ''
  const known = ERROR_LABEL[error]
  app.innerHTML = pageShell(`
    <div class="oauth-error-ic" style="color:#dc2626">${icon('alert', 24)}</div>
    <div class="oauth-title" style="margin-bottom:8px">授权无法完成</div>
    <div class="oauth-sub">
      错误码：<code class="mono">${esc(error)}</code>
      ${known && typeof known === 'string' ? `<br>${esc(known)}` : ''}
      ${description ? `<div class="muted-box" style="margin-top:10px;font-size:12.5px">${esc(description)}</div>` : ''}
    </div>
    <div class="oauth-actions" style="margin-top:20px">
      <a class="btn btn-default" href="#/dashboard" style="text-align:center">返回平台</a>
    </div>
    <div class="form-hint" style="margin-top:12px">请回到发起授权的应用重试；若反复出现，请联系应用负责人或平台管理员。</div>`)
}

// -- RP 发起登出中转页 ----------------------------------------------------------

export async function renderOauthLogout(app, params) {
  const postLogoutUri = params.get('post_logout_redirect_uri') ?? ''
  const state = params.get('state') ?? ''
  const clientName = params.get('client') ?? '应用'
  app.innerHTML = pageShell(`
    <div class="oauth-title" style="margin-bottom:8px">正在退出平台会话…</div>
    <div class="oauth-sub"><b>${esc(clientName)}</b> 发起了登出请求。平台会话清除后将${postLogoutUri ? '跳回应用地址' : '停留在平台'}。</div>
    <div class="form-hint" id="oauth-logout-state" style="margin-top:14px">处理中…</div>`)
  const mark = (text) => { const el = app.querySelector('#oauth-logout-state'); if (el) el.textContent = text }
  try {
    if (session.token) {
      const result = await rawJson('POST', '/api/auth/logout', { refreshToken: session.refreshToken || undefined })
      void result
    }
  } catch { /* 会话本就失效也继续完成登出跳转 */ }
  session.clear()
  mark('平台会话已清除。')
  if (postLogoutUri) {
    setTimeout(() => {
      try {
        const url = new URL(postLogoutUri)
        if (state) url.searchParams.set('state', state)
        window.location.href = url.toString()
      } catch {
        mark('回跳地址非法，已阻止跳转。')
      }
    }, 600)
  } else {
    mark('平台会话已清除。可重新登录平台。')
    setTimeout(() => { window.location.hash = '#/login' }, 1200)
  }
}
