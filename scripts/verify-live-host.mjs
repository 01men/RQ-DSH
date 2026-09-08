/**
 * 已上线宿主平台真实性验证脚本（review-dsh-agent-panel-v2 宿主打通 · 运维侧一步到位）。
 *
 * 背景：面板/桥接的认证面真实性测试需要宿主平台的管理员凭据（演示口令已按部署清单轮换，
 * 仓内不落任何真实口令——见 docs/deploy-enterprise.md 凭证纪律）。本脚本由运维在持有
 * 凭据的环境执行，逐一验证：
 *   1. 健康与登录（DSHCTL_USER/DSHCTL_PASS 或 DSHCTL_TOKEN）
 *   2. 钉钉连接器真实配置与「真钉钉 OpenAPI 健康检查」（POST /api/iam/connectors/:id/test，
 *      用宿主内存的真实 appKey/appSecret 拉真实 accessToken 与部门树——凭证不出宿主）
 *   3. 真实资产盘点：数字员工（Agent）/应用/Skill/MCP/NAS + 全员名册规模（面板组织绑定与
 *      agentRef 绑定的真实数据源）
 *   4. 面板侧就绪检查：/rq/panel/ 可达（宿主挂载形态）、/api/panel/depts 五部门、行业三态
 *
 * 用法：
 *   DSHCTL_URL=http://192.168.0.7:7300 DSHCTL_USER=admin DSHCTL_PASS='***' node scripts/verify-live-host.mjs
 *   （或 DSHCTL_TOKEN=<已有令牌> 免登录步）
 */
const BASE = (process.env.DSHCTL_URL ?? 'http://127.0.0.1:7300').replace(/\/+$/, '')
const USER = process.env.DSHCTL_USER
const PASS = process.env.DSHCTL_PASS
const TOKEN = process.env.DSHCTL_TOKEN

let token = TOKEN
async function api(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json().catch(() => null)
  return { status: response.status, ok: payload?.ok ?? false, data: payload?.data, error: payload?.error }
}

const results = []
const check = (name, pass, detail = '') => {
  results.push(pass)
  console.log(`  ${pass ? '✔' : '✘'} ${name}${pass || !detail ? '' : `  ← ${detail}`}`)
}

console.log(`» 验证目标：${BASE}`)
const health = await api('GET', '/api/health')
check('健康检查', health.ok, JSON.stringify(health.error))

if (!token) {
  if (!USER || !PASS) {
    console.error('缺少凭据：设 DSHCTL_USER/DSHCTL_PASS（或 DSHCTL_TOKEN）后重试')
    process.exit(1)
  }
  const login = await api('POST', '/api/auth/login', { username: USER, password: PASS })
  check(`登录（${USER}）`, login.ok, JSON.stringify(login.error))
  token = login.data?.token
}

// 1. 钉钉连接器：真实配置 + 真钉钉 OpenAPI 健康检查（凭证不出宿主）
const connectors = await api('GET', '/api/iam/connectors')
const dingtalkConfigs = (connectors.data?.configs ?? []).filter((config) => config.provider === 'dingtalk')
check(`钉钉连接器配置在案（${dingtalkConfigs.length} 个主体）`,
  dingtalkConfigs.length >= 1,
  JSON.stringify(connectors.error ?? connectors.data?.configs?.map((config) => config.corpId)))
for (const config of dingtalkConfigs) {
  const test = await api('POST', `/api/iam/connectors/${config.id}/test`)
  check(`真钉钉健康检查：${config.name ?? config.corpId}（mode=${config.mode}）`,
    test.ok && test.data?.ok === true,
    JSON.stringify(test.error ?? test.data?.message))
}

// 2. 真实资产盘点（面板 agentRef/组织绑定的数据源）
const agents = await api('GET', '/api/agents')
const agentRows = agents.data?.agents ?? agents.data ?? []
check(`数字员工（Agent 资产）：${agentRows.length} 个`, agentRows.length >= 1, JSON.stringify(agents.error))
console.log('    ' + agentRows.slice(0, 10).map((agent) => `${agent.name}[${agent.status}]`).join(' | '))
const apps = await api('GET', '/api/apps')
check(`AI 应用：${(apps.data?.apps ?? apps.data ?? []).length} 个`, apps.ok, JSON.stringify(apps.error))
const skills = await api('GET', '/api/skills')
check(`Skill 市场：${(skills.data?.skills ?? []).length} 个`, skills.ok, JSON.stringify(skills.error))
const roster = await api('GET', '/api/iam/roster')
check(`全员名册：${roster.data?.users?.length ?? 0} 人 / ${roster.data?.orgs?.length ?? 0} 组织（面板部门绑定与成员名册的真实源）`,
  roster.ok, JSON.stringify(roster.error))

// 3. 面板侧就绪（本分支部署后；独立形态 /panel/，dsh 宿主挂载形态 /rq/panel/）
const panelStatic = await fetch(`${BASE}/panel/`).then((r) => r.status).catch(() => 0)
const panelStaticRq = panelStatic === 200 ? 200 : await fetch(`${BASE}/rq/panel/`).then((r) => r.status).catch(() => 0)
check('/panel/（或 /rq/panel/）面板 SPA 可达', panelStaticRq === 200, `status=${panelStatic}/${panelStaticRq}`)
const depts = await api('GET', '/api/panel/depts')
check(`面板五部门骨架（${(depts.data?.depts ?? []).length} 个）`, depts.ok && depts.data.depts.length === 5, JSON.stringify(depts.error))
const industries = await api('GET', '/api/panel/industries')
check(`行业三态（${(industries.data?.industries ?? []).filter((ind) => ind.state === 'active').length} 已激活）`, industries.ok, JSON.stringify(industries.error))
const board = await api('GET', '/api/panel/board')
check('战略看板 /api/panel/board（聚合面+卡片包面下发）', board.ok && Boolean(board.data?.funnel) && Array.isArray(board.data?.cards), JSON.stringify(board.error ?? { platform: board.data?.platform, cards: board.data?.cards?.length }))

const failed = results.filter((pass) => !pass).length
console.log(`\n验证结果：${results.length - failed}/${results.length} 通过`)
process.exit(failed > 0 ? 1 : 0)
