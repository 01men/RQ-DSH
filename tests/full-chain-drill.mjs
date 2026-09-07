/**
 * WP-08 全链路演练：四类资产各 ≥1 真实资产走完「登记 → 审批 → 上架 → 授权 → 调用 → 回传」。
 *
 * 资产与链路（每步打印【步骤 API 状态 返回ID】，最后一步断言 usage 事件并打印 event_id）：
 *   1. Skill   提交(触发扫描/高风险) → L1 领域审批 + L2 安全加签 → 发布上架 → 授权安装 → 调用(下载留痕+调用侧 usage 回传) → 断言 skill:<id> 事件
 *   2. AI 应用  注册 → SSO 签发+上线审批 → 上线确认 → 授权直达票据(entry-ticket) → 调用(票据兑换=打开语义) → 断言 app:<id> 事件
 *   3. MCP     注册部署(real) → 测试环境验证(准入) → 灰度→全量上架 → 权限组授权 → 网关 invoke() → 断言自动产出 mcp:<slug> 事件
 *   4. NAS     注册草稿 → 数据权限规则基线确认(审批把关) → 上线 → nas-authz 授权作用域 → allow/deny 判定+文件网关调用 → 断言 nas:<id> 事件
 *
 * 用法：
 *   node tests/full-chain-drill.mjs                 # 自起隔离实例（端口 7322，数据目录 data-drill，DEMO_SEED=1）
 *   DRILL_BASE=http://127.0.0.1:7300 node tests/full-chain-drill.mjs   # 演练已运行实例
 *
 * 输出统一前缀 `[drill]`，结尾打印六步×四资产矩阵，任一 FAIL 退出码 1。
 */
import { spawn } from 'node:child_process'
import { rm, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'

const PORT = Number(process.env.DRILL_PORT ?? 7322)
const EXTERNAL_BASE = process.env.DRILL_BASE ?? ''
const BASE = EXTERNAL_BASE || `http://127.0.0.1:${PORT}`
const DATA_DIR = 'data-drill'
const PASSWORD = process.env.DRILL_PASSWORD ?? 'Ybk@2026'
const RUN_TAG = `drill-${Date.now()}`

let proc
const stubs = []
const matrix = { setup: [], skill: [], app: [], mcp: [], nas: [] }
const events = { skill: null, app: null, mcp: null, nas: null } // 断言到的 usage event_id

function log(line) { console.log(line) }
function step(asset, name, pass, detail = '') {
  const mark = pass ? 'OK' : 'FAIL'
  matrix[asset].push({ name, pass: Boolean(pass) })
  log(`[drill][${asset}][${name}] ${mark}${detail ? ` ${detail}` : ''}`)
  return Boolean(pass)
}
const idOf = (value) => (value === undefined || value === null || value === '' ? '-' : String(value))

async function api(method, path, { token, body, headers } = {}) {
  const finalHeaders = { 'content-type': 'application/json', ...headers }
  if (token) finalHeaders.authorization = `Bearer ${token}`
  const response = await fetch(`${BASE}${path}`, { method, headers: finalHeaders, body: body === undefined ? undefined : JSON.stringify(body) })
  let payload = null
  try { payload = await response.json() } catch { /* non-json */ }
  return { status: response.status, ok: payload?.ok ?? false, data: payload?.data, error: payload?.error }
}
/** 原始请求（/mcp JSON-RPC 等无 {ok,data} 包裹的端点）。 */
async function raw(method, path, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  let payload = null
  try { payload = await response.json() } catch { /* non-json */ }
  return { status: response.status, payload }
}

// ---------------------------------------------------------------- stub：MCP real 后端（JSON-RPC over HTTP）
// real 执行层调用进入 usage（demo 不计），故 MCP 演练资产用 exec=real + 本进程真实 stub 后端。
function startMcpStub() {
  const server = createServer(async (req, res) => {
    const json = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)) }
    let message = {}
    try { message = JSON.parse(await new Promise((resolve) => { let raw=''; req.on('data', (c) => { raw += c }); req.on('end', () => resolve(raw)) })) } catch { /* ignore */ }
    if (message.method === 'initialize') return json(200, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'drill-backend-stub', version: '1.0.0' } } })
    if (message.method === 'tools/call') {
      return json(200, {
        jsonrpc: '2.0', id: message.id,
        result: { content: [{ type: 'text', text: `drill-echo:${message.params?.name}:${message.params?.arguments?.query ?? ''}` }], usage: { totalTokens: 4321 } },
      })
    }
    return json(404, {})
  })
  stubs.push(server)
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

// ---------------------------------------------------------------- stub：NAS 文件网关（复刻 synology-filestation-mcp 契约）
function startNasStub() {
  const TOKEN = `gw-${RUN_TAG}-nas`
  const IP = '192.168.0.196'
  const server = createServer(async (req, res) => {
    const json = (status, payload, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(payload)) }
    if (req.method !== 'POST' || req.url !== '/mcp') return json(404, { error: 'not found' })
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: '网关鉴权失败' } })
    if (req.headers['x-nas-ip'] !== IP) return json(400, { jsonrpc: '2.0', id: null, error: { code: -32002, message: '未知 NAS 设备（X-NAS-IP）' } })
    let message = null
    try { message = JSON.parse(await new Promise((resolve) => { let raw=''; req.on('data', (c) => { raw += c }); req.on('end', () => resolve(raw)) })) } catch { return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) }
    const sessionHeaders = { 'mcp-session-id': `stub-session-${RUN_TAG}` }
    if (message.id === undefined || message.id === null) { res.writeHead(202, sessionHeaders); res.end(); return }
    const reply = (result) => json(200, { jsonrpc: '2.0', id: message.id, result }, sessionHeaders)
    const text = (value) => reply({ content: [{ type: 'text', text: JSON.stringify(value) }] })
    if (message.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'synology-filestation-stub', version: '1.0.0' } })
    if (message.method === 'tools/list') {
      const names = ['fs_list_shares', 'fs_list', 'fs_get_info', 'fs_search', 'fs_create_folder', 'fs_rename', 'fs_delete', 'fs_upload', 'fs_download', 'fs_task_status']
      return reply({ tools: names.map((name) => ({ name, description: `stub ${name}`, inputSchema: { type: 'object' } })) })
    }
    if (message.method === 'tools/call') {
      const name = String(message.params?.name ?? '')
      const args = message.params?.arguments ?? {}
      if (name === 'fs_list_shares') return text({ shares: [{ name: 'homes', path: '/homes', isdir: true }, { name: 'skillhub', path: '/skillhub', isdir: true }] })
      if (name === 'fs_list') return text({ files: [{ name: 'readme.txt', isdir: false, size: 128 }, { name: '演练目录', isdir: true }], total: 2, offset: 0 })
      if (name === 'fs_get_info') {
        const reqPaths = Array.isArray(args.path) ? args.path : [args.path].filter(Boolean)
        return text({ files: reqPaths.map((p) => ({ path: p, name: String(p).split('/').pop(), size: 128, isdir: false })) })
      }
      if (name === 'fs_create_folder') {
        const folders = Array.isArray(args.folder_path) ? args.folder_path : [args.folder_path].filter(Boolean)
        const names = Array.isArray(args.name) ? args.name : [args.name].filter(Boolean)
        return text({ folders: folders.map((folder, i) => ({ path: `${folder}/${names[i] ?? 'new'}`, name: names[i] })) })
      }
      if (name === 'fs_delete') {
        const reqPaths = Array.isArray(args.path) ? args.path : [args.path].filter(Boolean)
        return text({ success: true, deleted: reqPaths })
      }
      if (name === 'fs_upload') {
        if (typeof args.dest_path !== 'string' || typeof args.local_file !== 'string') return reply({ content: [{ type: 'text', text: 'fs_upload 缺 dest_path/local_file' }], isError: true })
        try {
          const buffer = await import('node:fs/promises').then((fs) => fs.readFile(String(args.local_file)))
          const filename = String(args.local_file).split(/[\\/]/).pop()
          return text({ uploaded: `${args.dest_path}/${filename}`, bytes: buffer.length })
        } catch (error) {
          return reply({ content: [{ type: 'text', text: `fs_upload 网关侧读不到 local_file：${error instanceof Error ? error.message : error}` }], isError: true })
        }
      }
      if (name === 'fs_download') return text({ saved_to: `${String(args.local_dir ?? '/tmp')}/drill.bin`, bytes: 22 })
      return reply({ content: [{ type: 'text', text: `stub 演练网关未实现工具：${name}` }], isError: true })
    }
    return reply({ content: [{ type: 'text', text: `方法不存在：${message.method}` }], isError: true })
  })
  stubs.push(server)
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, token: TOKEN, ip: IP })))
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
    log(`[drill][setup] 自起隔离实例 ${BASE}（数据目录 ${DATA_DIR}，DEMO_SEED=1）`)
    await startInstance()
  } else {
    log(`[drill][setup] 外接实例 ${EXTERNAL_BASE}（DRILL_BASE）`)
  }
  const t0 = Date.now()

  // —— 登录与种子就绪 ——
  const loginAs = async (username) => {
    const login = await api('POST', '/api/auth/login', { body: { username, password: PASSWORD } })
    if (!login.ok) throw new Error(`${username} 登录失败：${JSON.stringify(login.error)}`)
    return login
  }
  const adminLogin = await loginAs('admin')
  const devLogin = await loginAs('dev')
  const opsLogin = await loginAs('ops')
  const auditLogin = await loginAs('audit')
  const admin = adminLogin.data.token
  const dev = devLogin.data.token
  const ops = opsLogin.data.token
  const audit = auditLogin.data.token
  step('setup', 'login', true, `admin=${idOf(adminLogin.data.user?.id)} dev=${idOf(devLogin.data.user?.id)} ops=${idOf(opsLogin.data.user?.id)} audit=${idOf(auditLogin.data.user?.id)} status=200`)

  for (let i = 0; i < 90; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    try {
      const overview = await api('GET', '/api/overview', { token: admin })
      if ((overview.data?.agents?.online ?? 0) >= 1) break
    } catch { /* retry */ }
  }
  const usersAll = (await api('GET', '/api/iam/users', { token: admin })).data?.users ?? []
  const uid = (username) => usersAll.find((user) => user.username === username)?.id
  const devUid = uid('dev')
  const auditUid = uid('audit')
  const agents = (await api('GET', '/api/agents', { token: admin })).data?.agents ?? []
  const coder = agents.find((item) => item.slug === 'dev-coder')
  step('setup', 'seed-ready', Boolean(devUid && auditUid && coder), `dev=${idOf(devUid)} audit=${idOf(auditUid)} agent:dev-coder=${idOf(coder?.id)}`)

  // —— 演练租户/组织（usage principal 归属）——
  const tenant = await api('POST', '/api/iam/tenants', { token: admin, body: { name: `全链路演练租户（${RUN_TAG}）`, plan: 'enterprise' } })
  const org = tenant.ok ? await api('POST', '/api/iam/orgs', { token: admin, body: { name: `全链路演练组织（${RUN_TAG}）`, tenantId: tenant.data.id } }) : null
  step('setup', 'tenant-org', Boolean(org?.ok), `tenant=${idOf(tenant.data?.id)} org=${idOf(org?.data?.id)}`)
  const ORG_ID = org.data.id

  // =========================================================================
  // 资产一：Skill（提示词/技能）
  // =========================================================================
  log('[drill] ━━ 资产一：Skill ━━')
  const skillContent = '# 周报生成助手\n\n## 何时使用\n每周五汇总本周工作产出周报。\n\n## 步骤\n1. 读取本周工时与提交记录\n2. 参考团队周报模板 https://wiki.example.com/runbook 汇总\n3. 生成 Markdown 周报并提交审阅'
  const skillSubmit = await api('POST', '/api/skills', { token: dev, body: { name: '周报生成助手（全链路演练）', summary: '汇总本周工作产出结构化周报', content: skillContent, category: '办公提效', version: '1.0.0' } })
  const skillId = skillSubmit.data?.id
  step('skill', 'step1-register', skillSubmit.ok && skillSubmit.data?.status === 'pending_approval',
    `api=POST /api/skills status=${skillSubmit.status} risk=${idOf(skillSubmit.data?.riskLevel)} findings=${(skillSubmit.data?.findings ?? []).length} id=${idOf(skillId)}`)
  const skillRegAt = Date.now()

  // 含外部 URL → 静态扫描 warn → 高风险 → L1 领域审批 + L2 安全加签（两级按钮流）
  const skillL1 = await api('POST', `/api/skills/${skillId}/approve`, { token: admin, body: { decision: 'approve', level: 'domain', opinion: '演练：业务适用性确认（L1 领域审批）' } })
  const skillVerAfterL1 = (skillL1.data?.versions ?? []).find((v) => v.version === skillL1.data?.currentVersion)?.status
  let skillL2 = null
  let skillL2Status = '-'
  if (skillVerAfterL1 === 'pending_security') {
    skillL2 = await api('POST', `/api/skills/${skillId}/approve`, { token: admin, body: { decision: 'approve', level: 'security', opinion: '演练：数据出域风险评估通过（L2 安全加签）' } })
    skillL2Status = (skillL2.data?.versions ?? []).find((v) => v.version === skillL2.data?.currentVersion)?.status ?? '-'
  }
  step('skill', 'step2-approve', skillL1.ok && (!skillL2 || (skillL2.ok && skillL2Status === 'approved')),
    `api=POST /api/skills/${skillId}/approve L1(domain)=${skillL1.status}→${idOf(skillVerAfterL1)}${skillL2 ? ` L2(security)=${skillL2.status}→${idOf(skillL2Status)}` : ' L2 无需'} skill=${idOf(skillId)}`)

  const skillPublish = await api('POST', `/api/skills/${skillId}/publish`, { token: admin, body: {} })
  step('skill', 'step3-publish', skillPublish.ok && skillPublish.data?.status === 'published',
    `api=POST /api/skills/${skillId}/publish status=${skillPublish.status} state=${idOf(skillPublish.data?.status)} id=${idOf(skillId)} 耗时=${((Date.now() - skillRegAt) / 1000).toFixed(1)}s`)

  const skillInstall = await api('POST', `/api/skills/${skillId}/install`, { token: dev, body: { agentId: coder.id } })
  step('skill', 'step4-authorize', skillInstall.ok && (skillInstall.data?.stats?.installs ?? 0) >= 1,
    `api=POST /api/skills/${skillId}/install(授权安装到 Agent ${idOf(coder.id)}) status=${skillInstall.status} installs=${idOf(skillInstall.data?.stats?.installs)} skill=${idOf(skillId)}`)

  const skillDownload = await api('POST', `/api/skills/${skillId}/download`, { token: dev, body: {} })
  // 调用侧回传：skill 无独立运行时端点，运行时调用经 usage 管道回传（nonbillable，skill:* 零费率规则）
  const skillCallMeter = await api('POST', '/api/usage/record', { token: admin, body: {
    org: ORG_ID, subject: `user:${devLogin.data.user.id}`, principal: `org:${ORG_ID}`,
    resource: `skill:${skillId}`, meters: [{ key: 'calls', value: 1, unit: '次' }], idempotency_key: `${RUN_TAG}-skill-call-1`,
  } })
  step('skill', 'step5-invoke', skillDownload.ok && String(skillDownload.data?.content ?? '').includes('周报生成助手') && skillCallMeter.ok,
    `api=POST /api/skills/${skillId}/download status=${skillDownload.status} bytes=${idOf(skillDownload.data?.content?.length)}；调用侧由 usage 管道回传 POST /api/usage/record status=${skillCallMeter.status} event=${idOf(skillCallMeter.data?.event_id)}`)

  await new Promise((resolve) => setTimeout(resolve, 300))
  const skillUsage = await api('GET', `/api/usage/events?resource=${encodeURIComponent(`skill:${skillId}`)}`, { token: admin })
  const skillEvent = skillUsage.data?.items?.[0]
  events.skill = skillEvent?.event_id
  step('skill', 'step6-usage', skillUsage.ok && skillUsage.data?.total >= 3 && (skillEvent?.pricing?.charge_cents ?? -1) === 0 && skillEvent?.resource === `skill:${skillId}`,
    `api=GET /api/usage/events?resource=skill:${skillId} status=${skillUsage.status} total=${idOf(skillUsage.data?.total)} charge0=${idOf(skillEvent?.pricing?.charge_cents)} event_ids=${(skillUsage.data?.items ?? []).map((item) => item.event_id).join(',')}（install/download/调用侧）`)

  // =========================================================================
  // 资产二：AI 应用（app，SSO 上线门禁 + 授权直达票据）
  // =========================================================================
  log('[drill] ━━ 资产二：AI 应用 ━━')
  const appCreate = await api('POST', '/api/apps', { token: ops, body: {
    name: '演练审批台（全链路演练）',
    attrs: { description: 'WP-08 全链路演练：注册→审批→上线→领票→兑换→计量', appType: 'web', icon: '🧯', url: 'https://drill-app.example.com', riskLevel: 'low', dataClass: 'internal' },
  } })
  const appId = appCreate.data?.app?.id
  step('app', 'step1-register', appCreate.ok && Boolean(appCreate.data?.credential?.clientId),
    `api=POST /api/apps status=${appCreate.status} app=${idOf(appId)} clientId=${idOf(appCreate.data?.credential?.clientId)}`)
  const appRegAt = Date.now()

  const appSso = await api('POST', `/api/apps/${appId}/sso-client`, { token: ops, body: { redirectUris: ['https://drill-app.example.com/cb'], clientType: 'confidential', consentRequired: false } })
  const appOnlineReq = await api('POST', `/api/apps/${appId}/transition`, { token: ops, body: { action: 'online' } })
  const appApprove = appOnlineReq.ok
    ? await api('POST', `/api/approvals/${appOnlineReq.data?.approval?.id}/decide`, { token: admin, body: { decision: 'approve', opinion: '演练：同意发布上线（二次确认）', confirmed: true } })
    : null
  step('app', 'step2-approve', appSso.ok && appOnlineReq.ok && appApprove?.ok && ['approved', 'executed'].includes(appApprove.data?.status),
    `api=POST /api/apps/${appId}/sso-client status=${appSso.status} clientId=${idOf(appSso.data?.clientId)}；POST transition(online) status=${appOnlineReq.status} approval=${idOf(appOnlineReq.data?.approval?.id)}；POST /api/approvals/:id/decide status=${idOf(appApprove?.status)} state=${idOf(appApprove?.data?.status)}`)

  const appDetail = await api('GET', `/api/apps/${appId}`, { token: admin })
  step('app', 'step3-publish', appDetail.ok && appDetail.data?.status === 'online',
    `api=GET /api/apps/${appId} status=${appDetail.status} state=${idOf(appDetail.data?.status)} sso=${idOf(appDetail.data?.sso?.status)} 耗时=${((Date.now() - appRegAt) / 1000).toFixed(1)}s`)

  const appTicket = await api('POST', `/api/apps/${appId}/entry-ticket`, { token: admin, body: {} })
  step('app', 'step4-authorize', appTicket.ok && String(appTicket.data?.ticket ?? '').startsWith('etk_'),
    `api=POST /api/apps/${appId}/entry-ticket status=${appTicket.status} ticket=${idOf(appTicket.data?.ticket)}`)

  const appRedeem = await api('POST', '/api/authn/entry-tickets/redeem', { body: { ticket: appTicket.data?.ticket } })
  step('app', 'step5-invoke', appRedeem.ok && appRedeem.data?.refType === 'app' && appRedeem.data?.refId === appId && Boolean(appRedeem.data?.identity?.sub),
    `api=POST /api/authn/entry-tickets/redeem status=${appRedeem.status} refType=${idOf(appRedeem.data?.refType)} refId=${idOf(appRedeem.data?.refId)} sub=${idOf(appRedeem.data?.identity?.sub)}`)

  // 打开即调用：平台播种 app:* 零费率规则，经 usage/record nonbillable 构造「打开/调用」事件
  const appMeter = await api('POST', '/api/usage/record', { token: admin, body: {
    org: ORG_ID, subject: `user:${adminLogin.data.user.id}`, principal: `org:${ORG_ID}`,
    resource: `app:${appId}`, meters: [{ key: 'calls', value: 1, unit: 'call' }], nonbillable: true, idempotency_key: `${RUN_TAG}-app-open-1`,
  } })
  await new Promise((resolve) => setTimeout(resolve, 300))
  const appUsage = await api('GET', `/api/usage/events?resource=${encodeURIComponent(`app:${appId}`)}`, { token: admin })
  const appEvent = appUsage.data?.items?.[0]
  events.app = appMeter.ok ? appMeter.data?.event_id : appEvent?.event_id
  step('app', 'step6-usage', appMeter.ok && appUsage.ok && appUsage.data?.total >= 1 && (appEvent?.pricing?.charge_cents ?? -1) === 0 && appEvent?.resource === `app:${appId}`,
    `api=POST /api/usage/record status=${appMeter.status} charge=${idOf(appMeter.data?.pricing?.charge_cents)} nonbillable=${idOf(appMeter.data?.pricing?.rate?.nonbillable)}；GET /api/usage/events?resource=app:${appId} total=${idOf(appUsage.data?.total)} event_id=${idOf(events.app)}`)

  // =========================================================================
  // 资产三：接口/工具（MCP 部署服务，real 执行层 → 自动计量）
  // =========================================================================
  log('[drill] ━━ 资产三：MCP 接口/工具 ━━')
  const mcpPort = await startMcpStub()
  const mcpCreate = await api('POST', '/api/mcp/services', { token: admin, body: {
    name: '演练检索服务（全链路演练）', slug: `drill-search-${Date.now() % 100000}`, orgId: ORG_ID,
    description: 'WP-08 全链路演练：real 执行层（本进程 stub 后端）', endpoint: `http://127.0.0.1:${mcpPort}/mcp`,
    transport: 'http', mode: 'external', exec: 'real',
    tools: [{ name: 'drill_query', description: '演练查询', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, riskLevel: 'read' }],
  } })
  const mcpId = mcpCreate.data?.id
  const mcpSlug = mcpCreate.data?.slug
  step('mcp', 'step1-register', mcpCreate.ok && mcpCreate.data?.status === 'draft',
    `api=POST /api/mcp/services status=${mcpCreate.status} state=${idOf(mcpCreate.data?.status)} exec=${idOf(mcpCreate.data?.exec)} id=${idOf(mcpId)} slug=${idOf(mcpSlug)}`)
  const mcpRegAt = Date.now()

  // 上架前调用被网关拒绝（未上架/未授权语义基线）
  const mcpDraftDeny = await api('POST', '/api/mcp/invoke', { token: admin, body: { serviceId: mcpId, tool: 'drill_query', args: { query: 'draft' } } })
  const mcpVerify = await api('POST', `/api/mcp/services/${mcpId}/verify`, { token: admin })
  step('mcp', 'step2-approve', mcpVerify.ok && mcpVerify.data?.health?.status === 'healthy' && (!mcpDraftDeny.ok || mcpDraftDeny.data?.status === 'denied'),
    `api=POST /api/mcp/services/${mcpId}/verify status=${mcpVerify.status} health=${idOf(mcpVerify.data?.health?.status)}；草稿调用被拒=${!mcpDraftDeny.ok || mcpDraftDeny.data?.status === 'denied'} id=${idOf(mcpId)}`)

  const mcpGray = await api('POST', `/api/mcp/services/${mcpId}/deploy`, { token: admin, body: { grayPercent: 20, version: '0.1.0', changelog: '演练灰度首发' } })
  const mcpFull = await api('POST', `/api/mcp/services/${mcpId}/deploy`, { token: admin, body: { grayPercent: 100, version: '1.0.0', changelog: '演练全量上架' } })
  step('mcp', 'step3-publish', mcpGray.ok && mcpGray.data?.status === 'gray' && mcpFull.ok && mcpFull.data?.status === 'online',
    `api=POST /api/mcp/services/${mcpId}/deploy gray=${mcpGray.status}→${idOf(mcpGray.data?.status)}(20%) full=${mcpFull.status}→${idOf(mcpFull.data?.status)}(100%) 耗时=${((Date.now() - mcpRegAt) / 1000).toFixed(1)}s`)

  // 授权语义：授权前 dev 被网关拒绝 → 权限组放行
  const mcpDenyBefore = await api('POST', '/api/mcp/invoke', { token: dev, body: { serviceId: mcpId, tool: 'drill_query', args: { query: '未授权' } } })
  const mcpPerm = await api('POST', '/api/mcp/perm-groups', { token: admin, body: {
    name: `演练权限组（${RUN_TAG}）`, policies: { [mcpId]: { allowedTools: '*', constraints: { readOnly: true } } },
    subjects: [{ type: 'user', id: devUid, name: 'dev' }],
  } })
  step('mcp', 'step4-authorize', mcpPerm.ok && mcpDenyBefore.ok === true && mcpDenyBefore.data?.status === 'denied',
    `未授权调用 status=${mcpDenyBefore.status} state=${idOf(mcpDenyBefore.data?.status)}(denied)；POST /api/mcp/perm-groups status=${mcpPerm.status} pg=${idOf(mcpPerm.data?.id)} subject=user:${idOf(devUid)}`)

  const mcpInvoke = await api('POST', '/api/mcp/invoke', { token: dev, body: { serviceId: mcpId, tool: 'drill_query', args: { query: '全链路演练' } } })
  const mcpRpc = await raw('POST', '/mcp', { token: dev, body: { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'mcp_invoke', arguments: { serviceId: mcpId, tool: 'drill_query', args: { query: '平台即 MCP Server' } } } } })
  const mcpRpcText = mcpRpc.payload?.result?.content?.[0]?.text ?? ''
  let mcpRpcOk = false
  try { mcpRpcOk = JSON.parse(mcpRpcText).status === 'ok' } catch { /* ignore */ }
  step('mcp', 'step5-invoke', mcpInvoke.ok && mcpInvoke.data?.ok === true && mcpRpc.status === 200 && mcpRpcOk,
    `api=POST /api/mcp/invoke status=${mcpInvoke.status} ok=${idOf(mcpInvoke.data?.ok)} exec=${idOf(mcpInvoke.data?.exec)}；POST /mcp(tools/call mcp_invoke) status=${mcpRpc.status} ok=${mcpRpcOk}`)

  await new Promise((resolve) => setTimeout(resolve, 300))
  const mcpUsage = await api('GET', `/api/usage/events?resource=${encodeURIComponent(`mcp:${mcpSlug}`)}`, { token: admin })
  const mcpEvent = mcpUsage.data?.items?.[0]
  events.mcp = mcpEvent?.event_id
  step('mcp', 'step6-usage', mcpUsage.ok && mcpUsage.data?.total >= 2 && mcpEvent?.resource === `mcp:${mcpSlug}` && (mcpEvent?.subject === `user:${devUid}`),
    `api=GET /api/usage/events?resource=mcp:${mcpSlug} status=${mcpUsage.status} total=${idOf(mcpUsage.data?.total)} subject=${idOf(mcpEvent?.subject)}(自动计量，非手动补报) event_ids=${(mcpUsage.data?.items ?? []).map((item) => item.event_id).join(',')}`)

  // =========================================================================
  // 资产四：NAS 数据目录（文档/知识包的深化期前形态）
  // =========================================================================
  log('[drill] ━━ 资产四：NAS 数据目录 ━━')
  const nasGw = await startNasStub()
  const nasCreate = await api('POST', '/api/nas', { token: admin, body: {
    name: '演练群晖 NAS（全链路演练）',
    attrs: {
      description: 'WP-08 全链路演练：注册→规则确认→上线→授权→调用→计量',
      vendor: 'Synology DS925+', gatewayUrl: `http://127.0.0.1:${nasGw.port}/mcp`, accessToken: nasGw.token, nasIp: nasGw.ip,
      rootPath: '/', dataClass: 'internal',
    },
  } })
  const nasId = nasCreate.data?.id
  step('nas', 'step1-register', nasCreate.ok && nasCreate.data?.status === 'draft',
    `api=POST /api/nas status=${nasCreate.status} state=${idOf(nasCreate.data?.status)} id=${idOf(nasId)}`)
  const nasRegAt = Date.now()

  // 审批把关（NAS 无独立审批工作流）：组织锚点 + 数据权限规则基线确认（乐观锁 PUT）
  const nasAnchor = await api('PATCH', `/api/nas/${nasId}`, { token: admin, body: { attrs: { orgRoot: '元冰可集团' } } })
  const rulesBefore = await api('GET', '/api/nas/authz/rules', { token: admin })
  const rulesPut = await api('PUT', '/api/nas/authz/rules', { token: admin, body: { ifVersion: rulesBefore.data?.version, degradeAllToReadonly: false } })
  step('nas', 'step2-approve', nasAnchor.ok && rulesPut.ok,
    `api=PATCH /api/nas/${nasId} status=${nasAnchor.status} orgRoot=元冰可集团；GET rules v${idOf(rulesBefore.data?.version)} → PUT /api/nas/authz/rules status=${rulesPut.status} v${idOf(rulesPut.data?.version)}（审批=规则基线确认）`)

  const nasOnline = await api('POST', `/api/nas/${nasId}/transition`, { token: admin, body: { action: 'online' } })
  step('nas', 'step3-publish', nasOnline.ok && nasOnline.data?.status === 'online',
    `api=POST /api/nas/${nasId}/transition(online) status=${nasOnline.status} state=${idOf(nasOnline.data?.status)} 耗时=${((Date.now() - nasRegAt) / 1000).toFixed(1)}s`)

  const nasScope = await api('GET', `/api/nas/authz/scope?nasId=${nasId}&userId=${devUid}`, { token: admin })
  const nasAllow = await api('POST', '/api/nas/authz/check', { token: admin, body: { nasId, userId: devUid, paths: ['/元冰可集团/技术中心/AI 平台部/演练报告.docx'], op: 'read' } })
  step('nas', 'step4-authorize', nasScope.ok && nasScope.data?.role === 'M' && nasAllow.ok && nasAllow.data?.decision === 'allow',
    `api=GET /api/nas/authz/scope status=${nasScope.status} role=${idOf(nasScope.data?.role)} scope=${(nasScope.data?.scope ?? []).join('|') || '-'}；POST /api/nas/authz/check status=${nasAllow.status} decision=${idOf(nasAllow.data?.decision)} user=user:${idOf(devUid)}`)

  const nasDeny = await api('POST', '/api/nas/authz/check', { token: admin, body: { nasId, userId: auditUid, paths: ['/元冰可集团/技术中心/AI 平台部/演练报告.docx'], op: 'read' } })
  const nasFsList = await api('GET', `/api/nas/${nasId}/fs?path=/skillhub`, { token: dev })
  const nasFsUpload = await api('POST', `/api/nas/${nasId}/fs/upload`, { token: admin, body: { contentBase64: Buffer.from('WP-08 全链路演练文件内容', 'utf8').toString('base64'), destPath: '/skillhub/演练目录' } })
  step('nas', 'step5-invoke', nasDeny.ok && nasDeny.data?.decision === 'deny' && nasFsList.ok && nasFsUpload.ok,
    `拒绝判定 POST /api/nas/authz/check(audit) status=${nasDeny.status} decision=${idOf(nasDeny.data?.decision)} reasons=${(nasDeny.data?.reasons ?? []).join('/') || '-'}；文件网关调用 GET /api/nas/${nasId}/fs?path=/skillhub(dev) status=${nasFsList.status}；POST fs/upload status=${nasFsUpload.status}`)

  await new Promise((resolve) => setTimeout(resolve, 300))
  const nasUsage = await api('GET', `/api/usage/events?resource=${encodeURIComponent(`nas:${nasId}`)}`, { token: admin })
  const nasEvent = nasUsage.data?.items?.[0]
  const nasBytes = (nasUsage.data?.items ?? []).flatMap((event) => event.meters ?? []).find((meter) => meter.key === 'bytes')
  events.nas = nasEvent?.event_id
  step('nas', 'step6-usage', nasUsage.ok && nasUsage.data?.total >= 2 && Boolean(nasBytes) && nasEvent?.resource === `nas:${nasId}`,
    `api=GET /api/usage/events?resource=nas:${nasId} status=${nasUsage.status} total=${idOf(nasUsage.data?.total)} bytes=${idOf(nasBytes?.value)} event_ids=${(nasUsage.data?.items ?? []).map((item) => item.event_id).join(',')}`)

  // =========================================================================
  // 汇总矩阵与退出码
  // =========================================================================
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  log('')
  log('[drill][matrix] 六步×四资产矩阵')
  const steps = ['step1-register', 'step2-approve', 'step3-publish', 'step4-authorize', 'step5-invoke', 'step6-usage']
  const cell = (asset, name) => {
    const hit = matrix[asset].find((item) => item.name === name)
    return hit ? (hit.pass ? 'PASS' : 'FAIL') : 'MISS'
  }
  for (const asset of ['skill', 'app', 'mcp', 'nas']) {
    const cells = steps.map((name) => cell(asset, name))
    const usageId = events[asset] ?? '-'
    log(`[drill][matrix] ${asset.padEnd(5)} ${cells.join(' × ')} | usage=${usageId} → ${cells.every((c) => c === 'PASS') ? 'PASS' : 'FAIL'}`)
  }
  const totalSteps = Object.values(matrix).flat()
  const failed = totalSteps.filter((item) => !item.pass).length
  log(`[drill][summary] steps=${totalSteps.length} pass=${totalSteps.length - failed} fail=${failed} elapsed=${elapsed}s（L3 登记→上架：skill ${idOf('当日')}，各资产登记→上架耗时见 step3 行）`)
  if (failed > 0) {
    console.error(`\x1b[31m[drill][summary] 存在 FAIL 步骤（${failed}），退出码 1\x1b[0m`)
    process.exitCode = 1
  } else {
    log('\x1b[32m[drill][summary] 四类资产「登记→审批→上架→授权→调用→回传」全链路 PASS\x1b[0m')
  }
} catch (error) {
  console.error(`\x1b[31m[drill][fatal] ${error instanceof Error ? error.stack ?? error.message : String(error)}\x1b[0m`)
  process.exitCode = 1
} finally {
  if (proc) {
    proc.kill('SIGTERM')
    await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {})
  }
  for (const stub of stubs) stub.close()
}
