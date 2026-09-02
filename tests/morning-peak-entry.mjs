/**
 * 早高峰免登压测（WP-02 DoD④）：模拟全员同一时段从门户/钉钉「打开即工作台」——
 * N 路并发「领票 → 票据兑换控制台会话 → 会话可用性验证」全链路，零失败为过。
 *
 * 用法（可重复执行）：
 *   node tests/morning-peak-entry.mjs                       # 自起隔离实例（端口 7321，数据目录 data-morning-peak）
 *   MORNING_PEAK_BASE=http://127.0.0.1:7300 node tests/morning-peak-entry.mjs   # 压测已运行实例
 *   MORNING_PEAK_CONCURRENCY=100 node tests/morning-peak-entry.mjs              # 调大并发
 */
import { spawn } from 'node:child_process'
import { rm, mkdir } from 'node:fs/promises'

const PORT = Number(process.env.MORNING_PEAK_PORT ?? 7321)
const EXTERNAL_BASE = process.env.MORNING_PEAK_BASE ?? ''
const BASE = EXTERNAL_BASE || `http://127.0.0.1:${PORT}`
const CONCURRENCY = Math.max(1, Number(process.env.MORNING_PEAK_CONCURRENCY ?? 50))
const DATA_DIR = 'data-morning-peak'
const PASSWORD = process.env.MORNING_PEAK_PASSWORD ?? 'Ybk@2026'

let proc
const failures = []
const stats = { issued: 0, redeemed: 0, verified: 0 }

async function api(method, path, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  let payload = null
  try { payload = await response.json() } catch { /* non-json */ }
  return { status: response.status, ok: payload?.ok ?? false, data: payload?.data, error: payload?.error }
}

async function startInstance() {
  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(DATA_DIR, { recursive: true })
  proc = spawn(process.execPath, ['src/main.ts', '--port', String(PORT), '--data', DATA_DIR], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, DEMO_SEED: '1', DSH_UPDATE_AUTO_CHECK: 'off' },
  })
  proc.stderr.on('data', (chunk) => process.stderr.write(`\x1b[90m[server] ${chunk}\x1b[0m`))
  for (let i = 0; i < 80; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return
    } catch { /* retry */ }
  }
  throw new Error('隔离实例启动失败')
}

try {
  if (!EXTERNAL_BASE) {
    console.log(`\x1b[90m» 启动隔离实例（${BASE}）…\x1b[0m`)
    await startInstance()
  }

  const login = await api('POST', '/api/auth/login', { body: { username: 'admin', password: PASSWORD } })
  if (!login.ok) throw new Error(`管理员登录失败：${JSON.stringify(login.error)}`)
  const admin = login.data.token

  // 等演示种子就绪（Agent 上线），与 selftest 同款轮询
  for (let i = 0; i < 90; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    try {
      const overview = await api('GET', '/api/overview', { token: admin })
      if ((overview.data?.agents?.online ?? 0) >= 1) break
    } catch { /* retry */ }
  }

  const agents = await api('GET', '/api/agents', { token: admin })
  const target = (agents.data?.agents ?? []).find((item) => item.status === 'online') ?? agents.data?.agents?.[0]
  if (!target) throw new Error('种子中无可用 Agent（领票目标缺失）')
  console.log(`\x1b[90m» 免登目标：agent ${target.id}（${target.name}），并发 ${CONCURRENCY}\x1b[0m`)

  const startedAt = Date.now()
  await Promise.all(Array.from({ length: CONCURRENCY }, async (_, index) => {
    try {
      const issued = await api('POST', `/api/agents/${target.id}/entry-ticket`, { token: admin, body: {} })
      if (!issued.ok || !issued.data?.ticket) throw new Error(`领票失败：${JSON.stringify(issued.error)}`)
      stats.issued++
      const session = await api('POST', '/api/auth/entry-ticket-session', { body: { ticket: issued.data.ticket } })
      if (!session.ok || !session.data?.token) throw new Error(`兑换失败：${JSON.stringify(session.error)}`)
      stats.redeemed++
      // 一次性语义抽验：偶数路重放必须被拒
      if (index % 2 === 0) {
        const replay = await api('POST', '/api/auth/entry-ticket-session', { body: { ticket: issued.data.ticket } })
        if (replay.status !== 400) throw new Error(`重放未被拒绝：status=${replay.status}`)
      }
      const overview = await api('GET', '/api/overview', { token: session.data.token })
      if (!overview.ok) throw new Error(`会话不可用：${JSON.stringify(overview.error)}`)
      stats.verified++
    } catch (error) {
      failures.push(`worker#${index}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }))
  const elapsed = Date.now() - startedAt

  console.log('')
  console.log(`领票 ${stats.issued}/${CONCURRENCY} · 兑换 ${stats.redeemed}/${CONCURRENCY} · 会话可用 ${stats.verified}/${CONCURRENCY} · 耗时 ${elapsed}ms`)
  if (failures.length > 0) {
    console.error(`\x1b[31m✘ 早高峰模拟存在失败（${failures.length} 路）：\x1b[0m`)
    for (const failure of failures.slice(0, 10)) console.error(`  - ${failure}`)
    process.exitCode = 1
  } else {
    console.log('\x1b[32m✔ 早高峰模拟零失败（50 并发领票/兑换全通过）\x1b[0m')
  }
} catch (error) {
  console.error(`\x1b[31m✘ ${error instanceof Error ? error.message : String(error)}\x1b[0m`)
  process.exitCode = 1
} finally {
  if (proc) {
    proc.kill('SIGTERM')
    await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {})
  }
}
