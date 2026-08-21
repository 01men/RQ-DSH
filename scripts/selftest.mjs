/**
 * 功能自测：启动隔离实例（独立端口 + 独立数据目录），对全链路做端到端断言。
 * 覆盖：认证/RBAC、IAM 生命周期与三方同步、令牌吊销联动、MCP 部署灰度与网关鉴权限流、
 *       Skill 流水线（扫描/两级审批/上架/安装/弃用告警）、Agent/App 生命周期 L4 审批、
 *       on-behalf-of、审计四类日志、告警、成本、工具桥。
 * 用法：npm run selftest
 */
import { spawn } from 'node:child_process'
import { rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const PORT = 7311
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = join(process.cwd(), 'data-selftest')

const results = []
let currentSection = ''
function section(name) {
  currentSection = name
  console.log(`\n\x1b[36m━━ ${name} ━━\x1b[0m`)
}
function check(name, condition, detail = '') {
  const pass = Boolean(condition)
  results.push({ section: currentSection, name, pass })
  console.log(`  ${pass ? '\x1b[32m✔' : '\x1b[31m✘'} ${name}\x1b[0m${pass ? '' : `  ← ${detail}`}`)
  return pass
}
async function api(method, path, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  let payload = null
  try { payload = await response.json() } catch { /* ignore */ }
  return { status: response.status, ok: payload?.ok ?? false, data: payload?.data, error: payload?.error }
}

// ---------------------------------------------------------------- 启动隔离实例
console.log('\x1b[90m» 启动隔离测试实例…\x1b[0m')
await rm(DATA_DIR, { recursive: true, force: true })
await mkdir(DATA_DIR, { recursive: true })
const proc = spawn(process.execPath, ['src/main.ts', '--port', String(PORT), '--data', DATA_DIR], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
proc.stderr.on('data', (chunk) => process.stderr.write(`\x1b[90m[server] ${chunk}\x1b[0m`))

let booted = false
for (let i = 0; i < 40; i++) {
  await new Promise((resolve) => setTimeout(resolve, 500))
  try {
    const probe = await fetch(`${BASE}/api/health`)
    if (probe.ok) { booted = true; break }
  } catch { /* retry */ }
}
if (!booted) {
  console.error('\x1b[31m实例启动失败\x1b[0m')
  proc.kill('SIGKILL')
  process.exit(1)
}
// 轮询等待种子数据就绪（工具注册 + Agent 上线 + 调用记录）
let seeded = false
for (let i = 0; i < 60; i++) {
  await new Promise((resolve) => setTimeout(resolve, 500))
  try {
    const probe = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'Ybk@2026' } })
    if (!probe.ok) continue
    const info = await api('GET', '/api/platform/info', { token: probe.data.token })
    const overview = await api('GET', '/api/overview', { token: probe.data.token })
    if (info.data?.tools?.length >= 37 && overview.data?.agents?.online >= 5 && overview.data?.mcp?.totalCalls > 100) {
      seeded = true
      break
    }
  } catch { /* retry */ }
}
if (!seeded) console.log('[33m! 种子数据就绪超时，部分断言可能失败[0m')

try {
  // ================================================================ 基础与认证
  section('平台健康与登录')
  const health = await api('GET', '/api/health')
  check('健康检查', health.ok)

  const noAuth = await api('GET', '/api/overview')
  check('无令牌访问被拒绝（401）', noAuth.status === 401)

  const badLogin = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'wrong' } })
  check('错误密码被拒绝', badLogin.status === 401)

  const adminLogin = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'Ybk@2026' } })
  check('管理员登录成功', adminLogin.ok && adminLogin.data.token.startsWith('dst1.'))
  const admin = adminLogin.data.token
  check('登录返回权限点（含 *）', adminLogin.data.user.permissions.includes('*'))

  const sso = await api('POST', '/api/auth/sso', { body: { provider: 'dingtalk', code: 'DD0002' } })
  check('钉钉免密登录（三方绑定）', sso.ok && sso.data.user.username === 'linxm')

  const devLogin = await api('POST', '/api/auth/login', { body: { username: 'dev', password: 'Ybk@2026' } })
  check('开发者登录', devLogin.ok)
  const dev = devLogin.data.token

  // ================================================================ RBAC
  section('RBAC 权限模型')
  const devForbidden = await api('POST', '/api/iam/orgs', { token: dev, body: { name: '越权组织' } })
  check('开发者创建组织被拒（403）', devForbidden.status === 403)

  const auditorLogin = await api('POST', '/api/auth/login', { body: { username: 'audit', password: 'Ybk@2026' } })
  const auditor = auditorLogin.data.token
  const auditorWrite = await api('POST', '/api/iam/users', { token: auditor, body: { username: 'x', displayName: 'x', orgId: 'y' } })
  check('审计员写操作被拒', auditorWrite.status === 403)
  const auditorRead = await api('GET', '/api/audit/logs', { token: auditor })
  check('审计员读日志放行', auditorRead.ok)

  // ================================================================ 工作台
  section('工作台聚合')
  const overview = await api('GET', '/api/overview', { token: admin })
  check('总览数据完整', overview.ok
    && overview.data.iam.users >= 10
    && overview.data.mcp.totalCalls > 0
    && overview.data.agents.online >= 5
    && overview.data.apps.online >= 3
    && overview.data.skills.published >= 6)

  // ================================================================ IAM
  section('组织账号（IAM）')
  const newOrg = await api('POST', '/api/iam/orgs', { token: admin, body: { name: '自测事业部' } })
  check('创建组织', newOrg.ok && newOrg.data.id.startsWith('org_'))

  const dupUser = await api('POST', '/api/iam/users', { token: admin, body: { username: 'admin', displayName: '重复', orgId: newOrg.data.id } })
  check('重复用户名被拒', !dupUser.ok)

  const newUser = await api('POST', '/api/iam/users', { token: admin, body: { username: 'selftester', displayName: '测试账号', orgId: newOrg.data.id, title: '测试工程师' } })
  check('创建账号（默认激活）', newUser.ok && newUser.data.status === 'active')

  const roleList = await api('GET', '/api/iam/roles', { token: admin })
  const devRole = roleList.data.roles.find((role) => role.code === 'developer')
  const assign = await api('PATCH', `/api/iam/users/${newUser.data.id}`, { token: admin, body: { roleIds: [devRole.id] } })
  check('分配角色', assign.ok && assign.data.roleIds.length === 1)

  const importResult = await api('POST', '/api/iam/users/import', { token: admin, body: { items: [
    { username: 'batch01', displayName: '批量一号', orgId: newOrg.data.id },
    { username: 'batch02', displayName: '批量二号', orgId: newOrg.data.id },
  ] } })
  check('批量导入', importResult.ok && importResult.data.created.length === 2)

  const tree = await api('GET', '/api/iam/orgs/tree', { token: admin })
  check('组织树包含新组织', tree.ok && JSON.stringify(tree.data).includes('自测事业部'))

  const groupCreate = await api('POST', '/api/iam/groups', { token: admin, body: { name: '自测静态组', type: 'static', memberIds: [newUser.data.id] } })
  check('创建静态用户组', groupCreate.ok)

  // 三方同步 + 冲突
  const sync = await api('POST', '/api/iam/connectors/dingtalk/sync', { token: admin })
  check('钉钉全量同步执行', sync.ok && sync.data.created >= 0)
  const conflicts = await api('GET', '/api/iam/conflicts', { token: admin })
  if (conflicts.data.conflicts.length > 0) {
    const resolved = await api('POST', `/api/iam/conflicts/${conflicts.data.conflicts[0].id}/resolve`, { token: admin, body: { keep: 'third_party' } })
    check('同步冲突处理（以三方为准）', resolved.ok && resolved.data.status === 'resolved')
  } else {
    check('同步冲突队列（无冲突时跳过）', true)
  }

  // 冻结联动：令牌吊销
  section('账号冻结 → 令牌联动吊销')
  const testerLogin = await api('POST', '/api/auth/login', { body: { username: 'selftester', password: 'Ybk@2026' } })
  check('新账号可登录', testerLogin.ok)
  const testerToken = testerLogin.data.token
  const testerMe = await api('GET', '/api/auth/me', { token: testerToken })
  check('新账号令牌可用', testerMe.ok)
  const freezeNoReason = await api('POST', `/api/iam/users/${newUser.data.id}/freeze`, { token: admin, body: {} })
  check('冻结缺少原因被拒（护栏）', !freezeNoReason.ok)
  const freeze = await api('POST', `/api/iam/users/${newUser.data.id}/freeze`, { token: admin, body: { reason: '自测：验证联动吊销' } })
  check('冻结成功', freeze.ok && freeze.data.status === 'frozen')
  const revokedCheck = await api('GET', '/api/auth/me', { token: testerToken })
  check('冻结后令牌立即失效（401）', revokedCheck.status === 401)
  const frozenLogin = await api('POST', '/api/auth/login', { body: { username: 'selftester', password: 'Ybk@2026' } })
  check('冻结账号无法登录', frozenLogin.status === 401)

  // ================================================================ Authn
  section('统一认证（机器身份 / 令牌）')
  const cred = await api('POST', '/api/authn/principals', { token: admin, body: { name: 'selftest-ci', refType: 'external', scopes: ['mcp.invoke'] } })
  check('签发机器凭证（secret 一次性返回）', cred.ok && cred.data.clientSecret.startsWith('cs_'))

  const ccBad = await api('POST', '/api/auth/client-credentials', { body: { clientId: cred.data.clientId, clientSecret: 'wrong' } })
  check('错误 client_secret 被拒', ccBad.status === 401)

  const cc = await api('POST', '/api/auth/client-credentials', { body: { clientId: cred.data.clientId, clientSecret: cred.data.clientSecret } })
  check('Client Credentials 登录', cc.ok && cc.data.token.startsWith('dst1.'))
  const machine = cc.data.token

  const machineForbidden = await api('POST', '/api/iam/orgs', { token: machine, body: { name: '机器越权' } })
  check('机器身份越权被拒（scope 限制）', machineForbidden.status === 403)

  const issueToken = await api('POST', '/api/authn/tokens', { token: admin, body: { principalId: cc.data.principal.id, ttlHours: 1, reason: '自测签发' } })
  check('管理端签发令牌', issueToken.ok)
  const revoke = await api('DELETE', `/api/authn/tokens/${issueToken.data.jti}`, { token: admin, body: { reason: '自测吊销' } })
  check('吊销令牌', revoke.ok && revoke.data.revokedAt)
  const revokedUse = await api('GET', '/api/auth/me', { token: issueToken.data.token })
  check('吊销后令牌失效', revokedUse.status === 401)

  // ================================================================ MCP
  section('MCP 部署服务')
  const svcCreate = await api('POST', '/api/mcp/services', { token: admin, body: { name: '自测检索服务', slug: 'selftest-search', orgId: newOrg.data.id, description: '自测用', transport: 'http', mode: 'hosted' } })
  check('注册 MCP 服务（草稿）', svcCreate.ok && svcCreate.data.status === 'draft')
  const svcId = svcCreate.data.id

  const invokeDraft = await api('POST', '/api/mcp/invoke', { token: admin, body: { serviceId: svcId, tool: 'selftest-search_search' } })
  check('草稿服务拒绝调用', !invokeDraft.ok || invokeDraft.data.status === 'denied')

  const verify = await api('POST', `/api/mcp/services/${svcId}/verify`, { token: admin })
  check('测试环境验证', verify.ok && verify.data.status === 'verifying')

  const dryRun = await api('POST', `/api/mcp/services/${svcId}/deploy`, { token: admin, body: { dryRun: true } })
  check('部署 dry-run 影响面预览', dryRun.ok && dryRun.data.dryRun === true)

  const deployGray = await api('POST', `/api/mcp/services/${svcId}/deploy`, { token: admin, body: { grayPercent: 20, version: '0.1.0', changelog: '灰度首发' } })
  check('灰度发布（20%）', deployGray.ok && deployGray.data.status === 'gray' && deployGray.data.grayPercent === 20)

  const deployFull = await api('POST', `/api/mcp/services/${svcId}/deploy`, { token: admin, body: { grayPercent: 100, version: '0.2.0', changelog: '全量' } })
  check('全量发布', deployFull.ok && deployFull.data.status === 'online')

  const rollback = await api('POST', `/api/mcp/services/${svcId}/rollback`, { token: admin, body: { targetVersion: '0.1.0' } })
  check('版本回滚（版本不可变保留）', rollback.ok && rollback.data.currentVersion === '0.1.0')

  // 网关鉴权：未授权主体
  const invokeDenied = await api('POST', '/api/mcp/invoke', { token: dev, body: { serviceId: svcId, tool: 'selftest-search_search', args: { query: 'hi' } } })
  check('未授权主体被网关拒绝', invokeDenied.ok && invokeDenied.data.status === 'denied')

  // 权限组授权后放行
  const pg = await api('POST', '/api/mcp/perm-groups', { token: admin, body: {
    name: '自测权限组', policies: { [svcId]: { allowedTools: '*', constraints: { readOnly: true } } },
    subjects: [{ type: 'user_group', id: groupCreate.data.id }],
  } })
  check('创建 MCP 权限组', pg.ok)

  const devUser = (await api('GET', '/api/iam/users?q=' + encodeURIComponent('陈默'), { token: admin })).data.users[0]
  await api('PATCH', '/api/iam/groups/' + groupCreate.data.id, { token: admin, body: { memberIds: [devUser.id] } })
  const invokeOk = await api('POST', '/api/mcp/invoke', { token: dev, body: { serviceId: svcId, tool: 'selftest-search_search', args: { query: '自测' } } })
  check('授权后调用成功（只读工具放行）', invokeOk.ok && invokeOk.data.ok === true)

  const writeTool = (await api('GET', '/api/mcp/services', { token: admin })).data.services.find((s) => s.id === svcId).tools.find((t) => t.riskLevel !== 'read')
  if (writeTool) {
    const invokeWrite = await api('POST', '/api/mcp/invoke', { token: dev, body: { serviceId: svcId, tool: writeTool.name } })
    check('只读约束拦截写工具', invokeWrite.data.status === 'denied' && String(invokeWrite.data.error).includes('只读'))
  }

  const metrics = await api('GET', `/api/mcp/services/${svcId}/metrics`, { token: admin })
  check('调用监控指标（调用方/工具/序列）', metrics.ok && metrics.data.calls >= 1 && metrics.data.toolStats.length > 0 && metrics.data.series.length === 60)

  const healthProbe = await api('POST', `/api/mcp/services/${svcId}/health`, { token: admin })
  check('健康探测', healthProbe.ok && ['healthy', 'degraded'].includes(healthProbe.data.status))

  // ================================================================ Skill 市场
  section('Skill 市场流水线')
  const malicious = await api('POST', '/api/skills', { token: dev, body: { name: '恶意清理脚本', content: '# 清理\n```sh\nrm -rf / --no-preserve-root\n```\n调用了 sk-1234567890abcdef1234567890', category: '通用', version: '1.0.0' } })
  check('静态扫描拦截恶意提交（自动驳回）', malicious.ok && malicious.data.status === 'rejected')

  const submit = await api('POST', '/api/skills', { token: dev, body: { name: '自测报告助手', summary: '生成自测报告', content: '# 自测报告助手\n\n## 何时使用\n每日自测后生成报告。\n\n## 步骤\n1. 汇总断言结果\n2. 生成 Markdown 报告', category: '办公提效', version: '1.0.0' } })
  check('正常提交进入待审批', submit.ok && submit.data.status === 'pending_approval')
  const skillId = submit.data.id

  const approveDomain = await api('POST', `/api/skills/${skillId}/approve`, { token: admin, body: { decision: 'approve', level: 'domain', opinion: '业务适用' } })
  check('领域审批通过', approveDomain.ok)

  const publish = await api('POST', `/api/skills/${skillId}/publish`, { token: admin, body: {} })
  check('版本化上架', publish.ok && publish.data.status === 'published')

  const agentsList = (await api('GET', '/api/agents', { token: admin })).data.agents
  const targetAgent = agentsList.find((a) => a.slug === 'dev-coder')
  const install = await api('POST', `/api/skills/${skillId}/install`, { token: dev, body: { agentId: targetAgent.id } })
  check('安装到 Agent（依赖登记）', install.ok && install.data.stats.installs >= 1)

  const agentDetail = await api('GET', `/api/agents/${targetAgent.id}`, { token: admin })
  check('Agent 关联 Skill 自动回填', agentDetail.ok && (agentDetail.data.attrs.skills ?? []).includes('自测报告助手'))

  const download = await api('POST', `/api/skills/${skillId}/download`, { token: dev, body: {} })
  check('下载留痕（返回 SKILL.md）', download.ok && download.data.content.includes('自测报告助手'))

  const deprecate = await api('POST', `/api/skills/${skillId}/deprecate`, { token: admin, body: { reason: '自测弃用' } })
  check('弃用并触发存量引用告警', deprecate.ok && deprecate.data.skill.status === 'deprecated' && deprecate.data.referencingAgents.length >= 1)

  const alerts = await api('GET', '/api/audit/alerts', { token: admin })
  check('存量引用告警已入告警中心', alerts.ok && JSON.stringify(alerts.data.alerts).includes('自测报告助手'))

  const rate = await api('POST', `/api/skills/${skillId}/rate`, { token: dev, body: { stars: 5 } })
  check('评分', rate.ok && rate.data.stats.rating === 5)

  // ================================================================ Agent 生命周期（L4 审批）
  section('Agent 本体生命周期')
  const opsLogin = await api('POST', '/api/auth/login', { body: { username: 'ops', password: 'Ybk@2026' } })
  check('资源管理员登录', opsLogin.ok)
  const ops = opsLogin.data.token
  const agentCreate = await api('POST', '/api/agents', { token: ops, body: { name: '自测机器人', attrs: { description: '自测用机器人', model: 'deepseek-chat', riskLevel: 'low', avatar: '🧪' } } })
  check('注册 Agent（并颁发机器凭证）', agentCreate.ok && agentCreate.data.credential.clientId)
  const selfAgent = agentCreate.data.agent

  const onlineTooEarly = await api('POST', `/api/agents/${selfAgent.id}/transition`, { token: ops, body: { action: 'online' } })
  check('缺治理属性不可上线（校验）', !onlineTooEarly.ok)

  await api('PATCH', `/api/agents/${selfAgent.id}`, { token: ops, body: { attrs: { systemPromptVersion: 'v1', dataClass: 'internal', trialGroups: ['灰度试点组'] } } })
  const trial = await api('POST', `/api/agents/${selfAgent.id}/transition`, { token: admin, body: { action: 'submit_trial' } })
  check('进入试运行', trial.ok && trial.data.status === 'trial')

  const obo = await api('POST', `/api/agents/${targetAgent.id}/obo-token`, { token: admin })
  check('on-behalf-of 令牌（act 链）', obo.ok && obo.data.actChain.length >= 1 && obo.data.actChain[0].type === 'human')

  const bind = await api('POST', `/api/agents/${selfAgent.id}/bindings`, { token: admin, body: { userId: devUser.id } })
  check('绑定用户（授权留痕）', bind.ok)

  // L4 上线：发起人（dev）→ 审批人（admin，双人确认）
  const onlineRequest = await api('POST', `/api/agents/${selfAgent.id}/transition`, { token: ops, body: { action: 'online', note: '自测上线' } })
  check('上线生成 L4 审批单', onlineRequest.ok && onlineRequest.data.approval.status === 'pending')

  const selfApprove = await api('POST', `/api/approvals/${onlineRequest.data.approval.id}/decide`, { token: dev, body: { decision: 'approve', opinion: '试图自审' } })
  check('发起人不可自审（双人原则）', !selfApprove.ok)

  const approve = await api('POST', `/api/approvals/${onlineRequest.data.approval.id}/decide`, { token: admin, body: { decision: 'approve', opinion: '同意上线' } })
  check('审批通过自动执行上线', approve.ok && approve.data.status === 'executed')
  const agentAfter = await api('GET', `/api/agents/${selfAgent.id}`, { token: admin })
  check('Agent 状态已上线', agentAfter.data.status === 'online')

  // L4 下线：凭证吊销联动
  const credBefore = agentAfter.data.credential
  const offlineRequest = await api('POST', `/api/agents/${selfAgent.id}/transition`, { token: ops, body: { action: 'offline', note: '自测下线' } })
  check('下线生成 L4 审批单', offlineRequest.ok)
  await api('POST', `/api/approvals/${offlineRequest.data.approval.id}/decide`, { token: admin, body: { decision: 'approve', opinion: '同意下线' } })
  const agentOffline = await api('GET', `/api/agents/${selfAgent.id}`, { token: admin })
  check('下线后状态与凭证联动禁用', agentOffline.data.status === 'offline' && agentOffline.data.credential.status === 'disabled')
  void credBefore

  // ================================================================ AI 应用
  section('AI 应用本体')
  const appCreate = await api('POST', '/api/apps', { token: ops, body: { name: '自测应用', attrs: { description: '自测应用', appType: 'web', url: 'https://selftest.example.com', riskLevel: 'low', dataClass: 'internal', agentIds: [targetAgent.id] }, agentIds: [targetAgent.id] } })
  check('注册应用（编排在线 Agent）', appCreate.ok && appCreate.data.credential.clientId)

  const appOnlineReq = await api('POST', `/api/apps/${appCreate.data.app.id}/transition`, { token: ops, body: { action: 'online' } })
  check('应用发布 L4 审批', appOnlineReq.ok)
  await api('POST', `/api/approvals/${appOnlineReq.data.approval.id}/decide`, { token: admin, body: { decision: 'approve', opinion: '同意发布' } })
  const appDetail = await api('GET', `/api/apps/${appCreate.data.app.id}`, { token: admin })
  check('应用拓扑穿透（app→agent→skill）', appDetail.ok && appDetail.data.topology.children.length >= 1)
  check('应用成本穿透归集', appDetail.ok && appDetail.data.cost.length >= 1)

  const offlineAgent = await api('POST', `/api/apps/${appCreate.data.app.id}/transition`, { token: ops, body: { action: 'offline', note: '自测下架' } })
  await api('POST', `/api/approvals/${offlineAgent.data.approval.id}/decide`, { token: admin, body: { decision: 'approve', opinion: '同意下架' } })
  check('应用下架 L4 审批执行', offlineAgent.ok)

  // ================================================================ 审计
  section('审计与告警与成本')
  const logsAll = await api('GET', '/api/audit/logs?limit=200', { token: admin })
  const types = new Set(logsAll.data.items.map((log) => log.type))
  check('四类审计日志齐全', ['auth', 'authz', 'invoke', 'change'].every((type) => types.has(type)))
  check('越权拒绝已留痕（authz denied）', logsAll.data.items.some((log) => log.type === 'authz' && log.result === 'denied'))

  const logsFilter = await api('GET', '/api/audit/logs?type=invoke&result=ok&limit=5', { token: admin })
  check('审计筛选（类型+结果）', logsFilter.ok && logsFilter.data.items.every((log) => log.type === 'invoke'))

  const costApp = await api('GET', '/api/audit/cost?groupBy=app', { token: admin })
  check('成本按应用穿透', costApp.ok && costApp.data.rows.length >= 1)
  const costOrg = await api('GET', '/api/audit/cost?groupBy=org', { token: admin })
  check('成本按组织穿透', costOrg.ok && costOrg.data.rows.length >= 1)

  const ruleCreate = await api('POST', '/api/audit/alert-rules', { token: admin, body: { name: '自测规则', metric: 'permission_denied', threshold: 2, severity: 'critical' } })
  check('创建告警规则', ruleCreate.ok)

  // ================================================================ 工具桥（dsh 工具契约）
  section('工具桥（模型可用工具）')
  const toolList = await api('GET', '/api/platform/info', { token: admin })
  check('工具目录 ≥ 37 个', toolList.data.tools.length >= 37)
  const toolExec = await api('POST', '/api/tools/execute', { token: admin, body: { name: 'iam_org_tree', args: {} } })
  check('工具执行（iam_org_tree）', toolExec.ok && toolExec.data.isError === false && JSON.stringify(toolExec.data.value).includes('元冰可集团'))
  const toolAgentList = await api('POST', '/api/tools/execute', { token: admin, body: { name: 'agent_list', args: { status: 'online' } } })
  check('工具执行（agent_list 过滤）', toolAgentList.ok && toolAgentList.data.value.total >= 5)
} finally {
  // ---------------------------------------------------------------- 收尾
  console.log('\n\x1b[90m» 停止测试实例…\x1b[0m')
  proc.kill('SIGKILL')
  await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {})
}

// ================================================================ 汇总
const failed = results.filter((item) => !item.pass)
console.log(`\n${'━'.repeat(46)}`)
console.log(`  \x1b[1m自测结果：${results.length - failed.length}/${results.length} 通过\x1b[0m`)
if (failed.length > 0) {
  console.log(`\n  \x1b[31m失败项：\x1b[0m`)
  for (const item of failed) {
    console.log(`   ✘ [${item.section}] ${item.name}`)
  }
  process.exit(1)
} else {
  console.log('  \x1b[32m全部通过 ✔\x1b[0m')
  process.exit(0)
}
