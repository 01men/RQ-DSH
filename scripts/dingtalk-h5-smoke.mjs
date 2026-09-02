/**
 * 钉钉微应用 H5 冒烟（WP-11 DoD）：真实服务 + jsdom 模拟钉钉 webview UA + realtime 纯模块直测。
 * 覆盖四项断言：
 *   ① app.js 顶部钉钉 UA 探测：无记忆平台时写 heng_ops_dingtalk=1 并标记入口态
 *      （platformEntry=dingtalk），不写 heng_ops_platform——钉钉是入口不是第六平台；
 *   ② decideTransport 纯函数四种输入输出；
 *   ③ createEventStream 对 404 SSE 端点自动降级轮询（onMessage 收到 + onDowngrade 恰好一次）；
 *   ④ 对 /api/overview（管理账号）轮询 2 次收到数据，close() 后停轮。
 *
 * 用法（可重复执行）：node scripts/dingtalk-h5-smoke.mjs
 *   或指向已运行实例：DT_BASE=http://127.0.0.1:7323 node scripts/dingtalk-h5-smoke.mjs
 */
import { JSDOM } from 'jsdom'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { rm, mkdir } from 'node:fs/promises'

const PORT = Number(process.env.DT_PORT ?? 7323)
const EXTERNAL_BASE = process.env.DT_BASE ?? ''
const BASE = EXTERNAL_BASE || `http://127.0.0.1:${PORT}`
const DATA_DIR = 'data-dingtalk-h5'
const REPO = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const JS_ROOT = join(REPO, 'packages', 'plugin-console', 'public', 'js')
const APP_URL = pathToFileURL(join(JS_ROOT, 'app.js'))
const REALTIME_URL = pathToFileURL(join(JS_ROOT, 'realtime.js'))

// 钉钉安卓 webview 典型 UA（ DingTalk/7.x 为关键特征，探测正则 /DingTalk/i 只认这个）
const DINGTALK_UA = 'Mozilla/5.0 (Linux; Android 14; M2102K1C) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36 DingTalk/7.6.0 wb_dingtalk'
const NORMAL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

let proc
const results = []
async function test(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log(`  \x1b[32m✔ ${name}\x1b[0m`) } catch (e) { results.push(['FAIL', name]); console.error(`  \x1b[31m✘ ${name} — ${e.message}\x1b[0m`) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg) }
async function waitFor(cond, ms = 8000, step = 50) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (cond()) return true; await new Promise((r) => setTimeout(r, step)) }
  return cond()
}
const settle = (ms) => new Promise((r) => setTimeout(r, ms))
async function raw(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(new URL(path, BASE).href, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, data: json?.data, error: json?.error }
}

// 浏览器 EventSource 行为垫片（Node 无全局 EventSource）：非 200 或非 text/event-stream
// 一律按浏览器语义派发 error 并进入 CLOSED——正好复刻钉钉 webview 内 404 SSE 的失败路径。
class BrowserLikeEventSource {
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.onopen = null
    this.onmessage = null
    this.onerror = null
    fetch(url, { headers: { accept: 'text/event-stream' } }).then((res) => {
      const contentType = res.headers.get('content-type') ?? ''
      if (!res.ok || !contentType.includes('text/event-stream')) {
        this.readyState = 2
        this.onerror?.({ type: 'error' })
        return
      }
      this.readyState = 1
      this.onopen?.({ type: 'open' })
    }).catch(() => {
      this.readyState = 2
      this.onerror?.({ type: 'error' })
    })
  }
  close() { this.readyState = 2 }
}

/** 在干净 jsdom 中执行 app.js（缓存穿透 query 保证每次重新执行模块体）。 */
let scenarioSeq = 0
async function loadAppInDom({ dingtalkUa, rememberedPlatform } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: `${BASE}/`, pretendToBeVisual: true,
  })
  const { window } = dom
  // jsdom 30 忽略构造参数 userAgent，改为直接覆盖 navigator 实例属性
  Object.defineProperty(window.navigator, 'userAgent', { value: dingtalkUa ? DINGTALK_UA : NORMAL_UA, configurable: true })
  globalThis.document = window.document
  globalThis.window = window
  globalThis.location = window.location
  globalThis.localStorage = window.localStorage
  globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true })
  if (rememberedPlatform) window.localStorage.setItem('heng_ops_platform', rememberedPlatform)
  const mod = await import(`${APP_URL.href}?dingtalk-scenario=${++scenarioSeq}`)
  return { window, mod }
}

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
    console.log(`\x1b[90m» 启动隔离实例（${BASE}，数据目录 ${DATA_DIR}）…\x1b[0m`)
    await startInstance()
  } else {
    await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {})
  }

  // 演示种子就绪等待（/api/overview 轮询断言依赖种子数据）
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

  console.log('\n━━ 钉钉微应用 H5 + SSE 降级冒烟（WP-11） ━━')

  await test('① UA 探测：钉钉 webview 且无记忆平台 → 写 heng_ops_dingtalk=1 + 入口态标记，不动 data-platform', async () => {
    const { window } = await loadAppInDom({ dingtalkUa: true })
    assert(window.localStorage.getItem('heng_ops_dingtalk') === '1',
      `应写 localStorage heng_ops_dingtalk=1，实际 ${JSON.stringify(window.localStorage.getItem('heng_ops_dingtalk'))}`)
    assert(window.document.documentElement.dataset.platformEntry === 'dingtalk',
      `documentElement 应标记钉钉入口态（platformEntry），实际 ${JSON.stringify(window.document.documentElement.dataset.platformEntry)}`)
    assert(!window.document.documentElement.dataset.platform,
      `data-platform 应保持未设（钉钉不是第六平台），实际 ${JSON.stringify(window.document.documentElement.dataset.platform)}`)
  })

  await test('① 探测边界：钉钉 UA 但有记忆平台 → 探测不生效，记忆平台优先', async () => {
    const { window } = await loadAppInDom({ dingtalkUa: true, rememberedPlatform: 'quality' })
    assert(window.document.documentElement.dataset.platform === 'quality',
      `记忆平台应回放生效，实际 ${JSON.stringify(window.document.documentElement.dataset.platform)}`)
    assert(window.localStorage.getItem('heng_ops_dingtalk') === null, '有记忆平台时不应写钉钉标记')
    assert(!window.document.documentElement.dataset.platformEntry, '有记忆平台时不应标记入口态')
  })

  await test('① 探测边界：非钉钉 UA → 不写任何钉钉标记', async () => {
    const { window } = await loadAppInDom({})
    assert(window.localStorage.getItem('heng_ops_dingtalk') === null, '非钉钉 UA 不应写钉钉标记')
    assert(!window.document.documentElement.dataset.platformEntry, '非钉钉 UA 不应标记入口态')
    assert(!window.document.documentElement.dataset.platform, '非钉钉 UA 且无记忆时不设 data-platform')
  })

  await test('② decideTransport 纯函数：open→sse；error/超时未 open/环境不支持→polling', async () => {
    const { decideTransport } = await import(REALTIME_URL)
    assert(decideTransport({ sseOpened: true, sseError: false, supportsEventSource: true }) === 'sse', 'SSE 已 open 应保持 sse')
    assert(decideTransport({ sseOpened: false, sseError: true, supportsEventSource: true }) === 'polling', 'SSE 出错应降级 polling')
    assert(decideTransport({ sseOpened: false, sseError: false, supportsEventSource: true }) === 'polling', '超时未 open 应降级 polling')
    assert(decideTransport({ sseOpened: true, sseError: false, supportsEventSource: false }) === 'polling', '环境不支持应直接 polling')
  })

  await test('③ createEventStream：404 SSE 端点自动降级到轮询端点，onDowngrade 恰好一次', async () => {
    const { createEventStream } = await import(REALTIME_URL)
    const messages = []
    let downgrades = 0
    const stream = createEventStream({
      url: `${BASE}/api/__no_sse__`, // 必然 404 的 SSE 端点
      pollPath: `${BASE}/api/health`, // 实例健康端点当轮询端点
      pollIntervalMs: 200,
      onMessage: (data) => messages.push(data),
      onDowngrade: () => { downgrades++ },
      EventSourceImpl: BrowserLikeEventSource,
    })
    assert(await waitFor(() => messages.length >= 1 && downgrades >= 1), '应收到轮询消息且发生降级')
    await settle(350) // 观察窗：确认降级不会二次触发
    assert(downgrades === 1, `onDowngrade 应恰好一次，实际 ${downgrades}`)
    const first = messages[0]
    assert(first && typeof first === 'object' && first.ok === true && first.data?.status === 'ok',
      `轮询应收到 /api/health 信封数据，实际 ${JSON.stringify(first)}`)
    stream.close()
  })

  await test('④ /api/overview（管理账号）轮询 2 次收到数据，close() 后停轮', async () => {
    const { createEventStream } = await import(REALTIME_URL)
    const login = await raw('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'Ybk@2026' } })
    assert(login.status === 200 && login.data?.token, `管理账号登录失败 ${JSON.stringify(login.error)}`)
    const messages = []
    let downgrades = 0
    const stream = createEventStream({
      url: `${BASE}/api/__no_sse__`,
      pollPath: `${BASE}/api/overview`,
      headers: { authorization: `Bearer ${login.data.token}` },
      pollIntervalMs: 300,
      onMessage: (data) => messages.push(data),
      onDowngrade: () => { downgrades++ },
      EventSourceImpl: BrowserLikeEventSource,
    })
    assert(await waitFor(() => messages.length >= 2), `应至少轮询收到 2 次数据，实际 ${messages.length} 次`)
    assert(downgrades === 1, `onDowngrade 应恰好一次，实际 ${downgrades}`)
    const last = messages[messages.length - 1]
    assert(last?.ok === true && last.data?.agents && typeof last.data.agents.online === 'number',
      `轮询应收到工作台聚合数据（agents），实际 ${JSON.stringify(last).slice(0, 120)}`)
    stream.close()
    const at = messages.length
    await settle(700)
    assert(messages.length === at, `close() 后应停止轮询，实际又收到 ${messages.length - at} 次`)
  })

  const failed = results.filter(([state]) => state === 'FAIL').length
  console.log(`\n钉钉 H5 冒烟结果：${results.length - failed}/${results.length} 通过`)
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
