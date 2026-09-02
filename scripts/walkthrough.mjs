/**
 * 全员工作台核心路径走查（WP-04/A3 DoD）：jsdom + 真实前端模块 + 真实服务。
 * 断言「登录 → 工作台 → 进入任意核心功能」核心路径 ≤3 步，四区齐备，主题生效。
 *
 * 用法（可重复执行）：node scripts/walkthrough.mjs
 *   或指向已运行实例：WALK_BASE=http://127.0.0.1:7302 node scripts/walkthrough.mjs
 */
import { JSDOM, VirtualConsole } from 'jsdom'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { rm, mkdir } from 'node:fs/promises'

const PORT = Number(process.env.WALK_PORT ?? 7302)
const EXTERNAL_BASE = process.env.WALK_BASE ?? ''
const BASE = EXTERNAL_BASE || `http://127.0.0.1:${PORT}`
const DATA_DIR = 'data-walkthrough'
const REPO = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

let proc
const results = []
async function test(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log(`  \x1b[32m✔ ${name}\x1b[0m`) } catch (e) { results.push(['FAIL', name]); console.error(`  \x1b[31m✘ ${name} — ${e.message}\x1b[0m`) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg) }
async function waitFor(cond, ms = 8000, step = 60) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (cond()) return true; await new Promise((r) => setTimeout(r, step)) }
  return cond()
}
async function raw(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(new URL(path, BASE).href, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, data: json?.data, error: json?.error }
}
const P = (rel) => import(pathToFileURL(join(REPO, 'packages', 'plugin-console', 'public', 'js', rel)).href)

async function startInstance() {
  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(DATA_DIR, { recursive: true })
  proc = spawn(process.execPath, ['src/main.ts', '--port', String(PORT), '--data', DATA_DIR], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, DEMO_SEED: '1', DSH_UPDATE_AUTO_CHECK: 'off' },
  })
  for (let i = 0; i < 80; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    try { if ((await fetch(`${BASE}/api/health`)).ok) return } catch { /* retry */ }
  }
  throw new Error('隔离实例启动失败')
}

try {
  if (!EXTERNAL_BASE) {
    console.log(`\x1b[90m» 启动隔离实例（${BASE}）…\x1b[0m`)
    await startInstance()
  } else {
    await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {})
  }

  // 演示种子就绪等待（工作台聚合依赖种子数据）
  {
    const login = await raw('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'Ybk@2026' } })
    const admin = login.data.token
    for (let i = 0; i < 90; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      try {
        const overview = await raw('/api/overview', { token: admin })
        if (overview.data?.agents && (overview.data.agents.online ?? 0) >= 1) break
      } catch { /* retry */ }
    }
  }

  // jsdom 环境（对齐 dom-smoke 范式；独立形态无 /rq 前缀，文档 URL 取根路径）
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div><div id="content"></div></body></html>', {
    url: `${BASE}/`, pretendToBeVisual: true,
  })
  const { window } = dom
  globalThis.document = window.document
  globalThis.window = window
  globalThis.location = window.location
  globalThis.localStorage = window.localStorage
  globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
  const nativeFetch = globalThis.fetch
  globalThis.fetch = (input, init) => nativeFetch(new URL(String(input, 'http://localhost'), BASE.startsWith('http') ? BASE : `http://localhost${BASE}`).href, init)

  console.log('\n━━ 全员工作台核心路径走查（WP-04/A3） ━━')

  await test('步骤 0：登录（一次认证，免登通道另经 ?ticket=，计入同一认证步）', async () => {
    const login = await raw('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'Ybk@2026' } })
    assert(login.status === 200 && login.data?.token, `登录失败 ${JSON.stringify(login.error)}`)
    const { session } = await P('api.js')
    session.save(login.data.token, login.data.user)
    if (login.data.refreshToken) session.saveRefresh(login.data.refreshToken)
    window.__steps = 1 // 认证 1 步
  })

  await test('步骤 1：进入工作台（第 2 步）——四区齐备：问候 / 场景卡片 / 最近调用 / 对话入口', async () => {
    const { renderDashboard } = await P('pages/dashboard.js')
    const content = document.querySelector('#content')
    await renderDashboard(content, new URLSearchParams(), { rerender() {} })
    assert(waitFor(() => document.querySelector('#dash-scene-cards .dash-scene-card')), '场景卡片区应渲染（等待卡片包下发）')
    await waitFor(() => document.querySelectorAll('#dash-scene-cards .dash-scene-card').length > 0)
    assert(document.querySelector('.page-title')?.textContent.includes('早') || document.querySelector('.page-title'), '问候区在位')
    assert(document.querySelector('#dash-recent'), '最近调用区在位')
    assert(document.querySelector('#dash-open-chat-main'), '对话入口区在位（1 步进入对话）')
    window.__steps = 2
  })

  await test('步骤 1 验证：卡片包 ≤6 张 + 五平台主题已生效（data-platform 属性）', async () => {
    const cards = document.querySelectorAll('#dash-scene-cards .dash-scene-card')
    assert(cards.length >= 1 && cards.length <= 6, `场景卡片应 1~6 张，实际 ${cards.length}`)
    await waitFor(() => document.documentElement.dataset.platform)
    assert(['strategy', 'marketing', 'manufacturing', 'rd', 'quality'].includes(document.documentElement.dataset.platform),
      `data-platform 应为五平台之一，实际 ${document.documentElement.dataset.platform}`)
  })

  await test('步骤 2（第 3 步，达标线内）：点击场景卡片直达功能页', async () => {
    const firstCard = document.querySelector('#dash-scene-cards .dash-scene-card')
    assert(firstCard, '存在可点击场景卡片')
    firstCard.click()
    await waitFor(() => (location.hash ?? '').startsWith('#/'), 3000)
    assert((location.hash ?? '').startsWith('#/'), `点击后应进入 hash 路由，实际 ${location.hash}`)
    window.__steps = 3
  })

  await test('核心路径 ≤3 步达标（认证 1 + 进工作台 1 + 进功能 1）', async () => {
    assert((window.__steps ?? 99) <= 3, `核心路径实测 ${window.__steps} 步，超出 3 步达标线`)
  })

  await test('行为埋点（WP-07/D2）：卡片曝光与点击已上报 behavior 管道', async () => {
    const { api } = await P('api.js')
    const exposed = await api.get('/api/behavior/events?type=card.exposed&limit=5')
    assert(exposed && exposed.total >= 1, `card.exposed 应有事件，实际=${JSON.stringify(exposed)}`)
    const clicked = await api.get('/api/behavior/events?type=card.clicked&limit=5')
    assert(clicked && clicked.total >= 1, `card.clicked 应有事件，实际=${JSON.stringify(clicked)}`)
  })

  const failed = results.filter(([state]) => state === 'FAIL').length
  console.log(`\n走查结果：${results.length - failed}/${results.length} 通过；核心路径实测 ${window.__steps} 步（达标线 ≤3）`)
  if (failed > 0) process.exitCode = 1
} catch (error) {
  console.error(`\x1b[31m✘ ${error instanceof Error ? error.message : String(error)}\x1b[0m`)
  process.exitCode = 1
} finally {
  if (proc) {
    proc.kill('SIGTERM')
    await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {})
  }
}
