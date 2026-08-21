/**
 * 依据「插件标准解剖结构」批量生成各插件的声明文件：
 *   plugin.yaml（id/version/依赖/权限）+ manifest/{api,permissions,events,ui}.yaml
 * 这些声明是插件对外的契约文档（api.yaml 为唯一事实源，CLI/Skill/Web 三端对齐）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

const PLUGINS = [
  {
    dir: 'platform-core', id: 'dsh-plugin-platform-core', label: '平台基础',
    depends: [], permissions: ['console.login'],
    services: [
      ['storage', 'ctx.storage', 'JSON 集合存储（原子落盘，可替换 DB）'],
      ['platformBus', 'ctx.platformBus', '平台事件总线（插件协作唯一胶水）'],
      ['tools', 'ctx.tools', 'ToolRuntime-lite（独立宿主；dsh 下由原生 ToolRuntime 提供）'],
      ['httpServer', 'ctx.httpServer', 'HTTP 服务：REST 路由 + 静态资源'],
    ],
    events: [['tools/change', 'emit', '工具注册变更（lite 运行时）']],
    api: ['# 平台自身无业务 REST；由 console 插件聚合暴露'],
    ui: { routes: [], menus: [] },
  },
  {
    dir: 'resource-core', id: 'dsh-plugin-resource-core', label: '资源本体底座',
    depends: ['dsh-plugin-platform-core'], permissions: [],
    services: [
      ['resourceCore', 'ctx.resourceCore', '属性 schema 引擎 + 生命周期状态机 + 依赖图（topology/impact）'],
    ],
    events: [['<type>.<lifecycle-event>', 'emit', '状态迁移事件（如 agent.offlined）']],
    api: [
      'GET  /api/agents            # 底座驱动的资源列表（schema 随响应返回）',
      'POST /api/agents            # resourceCore.create(agent)',
      'PATCH /api/agents/:id       # resourceCore.update + 属性校验',
      'POST /api/agents/:id/transition  # 状态机迁移（guard/审批/留痕）',
    ],
    ui: { routes: [], menus: [] },
  },
  {
    dir: 'iam', id: 'dsh-plugin-iam', label: '组织账号',
    depends: ['dsh-plugin-platform-core'], permissions: ['iam.org.read', 'iam.org.write', 'iam.user.read', 'iam.user.write', 'iam.user.freeze', 'iam.role.write', 'iam.connector.write'],
    services: [['iam', 'ctx.iam', '组织/账号/角色/用户组/三方连接器（OrgConnector 可插拔）']],
    events: [
      ['iam.user.frozen', 'emit', '账号冻结（authn 订阅吊销令牌）'],
      ['iam.user.activated', 'emit', '账号恢复'],
      ['iam.org.changed', 'emit', '组织变更'],
      ['iam.permission.changed', 'emit', '权限变更（全插件缓存失效）'],
      ['iam.connector.synced', 'emit', '三方同步完成'],
    ],
    api: [
      'GET/POST /api/iam/orgs · GET /api/iam/orgs/tree · PATCH/DELETE /api/iam/orgs/:id',
      'GET/POST /api/iam/users · PATCH /api/iam/users/:id · POST /api/iam/users/import',
      'POST /api/iam/users/:id/activate|freeze|unfreeze|deactivate',
      'POST/DELETE /api/iam/users/:id/bindings[/:provider]',
      'GET /api/iam/roles · GET /api/iam/permissions · POST/PATCH /api/iam/roles/:id',
      'GET/POST/PATCH/DELETE /api/iam/groups',
      'GET/PUT /api/iam/connectors/:provider · POST .../test · POST .../sync',
      'GET /api/iam/conflicts · POST /api/iam/conflicts/:id/resolve',
    ],
    tools: ['iam_org_tree', 'iam_org_create', 'iam_user_list', 'iam_user_create', 'iam_user_freeze', 'iam_role_list', 'iam_sync_run', 'iam_conflict_list'],
    ui: {
      routes: ['#/iam?tab=members', '#/iam?tab=roles', '#/iam?tab=groups', '#/iam?tab=connectors', '#/iam?tab=conflicts'],
      menus: [{ group: '组织', items: ['组织与账号', '角色权限', '三方集成'] }],
    },
  },
  {
    dir: 'authn', id: 'dsh-plugin-authn', label: '统一认证中心',
    depends: ['dsh-plugin-platform-core', 'dsh-plugin-iam'], permissions: ['authn.principal.read', 'authn.principal.write', 'authn.token.issue', 'authn.token.revoke'],
    services: [['authn', 'ctx.authn', '双轨身份（人/机器）+ 令牌签发校验吊销 + on-behalf-of act 链']],
    events: [
      ['authn.token.issued', 'emit', '令牌签发'],
      ['authn.token.revoked', 'emit', '令牌吊销'],
      ['iam.user.frozen', 'on', '订阅：吊销该用户全部令牌'],
      ['agent.offlined / app.offlined', 'on', '订阅：禁用对应机器凭证'],
    ],
    api: [
      'POST /api/auth/login · POST /api/auth/sso · POST /api/auth/client-credentials',
      'GET /api/auth/me · POST /api/auth/logout',
      'GET/POST /api/authn/principals · POST /api/authn/principals/:id/disable',
      'GET/POST /api/authn/tokens · DELETE /api/authn/tokens/:jti · POST /api/authn/rotate-secret',
    ],
    tools: ['authn_token_issue', 'authn_token_revoke', 'authn_token_list', 'authn_credential_create'],
    ui: { routes: ['#/authn'], menus: [{ group: '治理与运营', items: ['认证与令牌'] }] },
  },
  {
    dir: 'audit', id: 'dsh-plugin-audit', label: '安全与审计',
    depends: ['dsh-plugin-platform-core', 'dsh-plugin-resource-core', 'dsh-plugin-iam'], permissions: ['audit.read', 'audit.rule.write', 'approval.read', 'approval.decide'],
    services: [['audit', 'ctx.audit', '四类审计日志 + 告警规则引擎 + 成本归集 + 审批中心（L4 执行器）']],
    events: [
      ['audit.alert.fired', 'emit', '告警触发'],
      ['approval.created / approval.decided', 'emit', '审批流转'],
      ['（订阅全部业务事件自动落审计）', 'on', 'mcp/skill/agent/app/token/iam'],
    ],
    api: [
      'GET /api/audit/logs · GET /api/audit/summary',
      'GET/POST/PATCH /api/audit/alert-rules · GET /api/audit/alerts · POST /api/audit/alerts/:id/read',
      'GET /api/audit/cost?groupBy=app|agent|org|date',
      'GET /api/approvals · POST /api/approvals/:id/decide',
    ],
    tools: ['audit_logs', 'audit_alerts_list', 'approval_decide', 'audit_cost_report'],
    ui: { routes: ['#/audit?tab=logs|alerts|rules|cost', '#/approvals'], menus: [{ group: '治理与运营', items: ['审计与告警', '审批中心'] }] },
  },
  {
    dir: 'mcp', id: 'dsh-plugin-mcp', label: 'MCP 部署服务',
    depends: ['dsh-plugin-platform-core', 'dsh-plugin-iam', 'dsh-plugin-audit'], permissions: ['mcp.service.read', 'mcp.service.write', 'mcp.service.deploy', 'mcp.service.offline', 'mcp.permgroup.write', 'mcp.invoke'],
    services: [['mcpRegistry', 'ctx.mcpRegistry', '服务注册/版本/灰度/回滚 + 健康探活熔断 + 权限组 + 调用网关 + 监控']],
    events: [
      ['mcp.deployed / mcp.offlined', 'emit', '部署与下线'],
      ['mcp.unhealthy', 'emit', '熔断告警（audit 订阅）'],
      ['mcp.invoked', 'emit', '网关调用（审计+指标+成本归集）'],
    ],
    api: [
      'GET/POST /api/mcp/services · PATCH /api/mcp/services/:id',
      'POST /api/mcp/services/:id/verify|deploy|rollback|offline|health',
      'GET /api/mcp/services/:id/metrics · GET /api/mcp/calls',
      'GET/POST/PATCH/DELETE /api/mcp/perm-groups',
      'POST /api/mcp/invoke（网关统一鉴权/限流/审计）',
    ],
    tools: ['mcp_service_list', 'mcp_deploy', 'mcp_offline', 'mcp_metrics', 'mcp_invoke', 'mcp_health_check'],
    ui: { routes: ['#/mcp'], menus: [{ group: 'AI 资源', items: ['MCP 服务'] }] },
  },
  {
    dir: 'skillhub', id: 'dsh-plugin-skillhub', label: 'Skill 市场',
    depends: ['dsh-plugin-platform-core', 'dsh-plugin-resource-core', 'dsh-plugin-audit'], permissions: ['skill.read', 'skill.submit', 'skill.approve', 'skill.publish', 'skill.install'],
    services: [['skillHub', 'ctx.skillHub', '提交→静态扫描→两级审批→版本化上架 + 安装依赖登记 + 评分检索']],
    events: [
      ['skill.submitted / skill.published / skill.installed', 'emit', '流水线事件'],
      ['skill.deprecated', 'emit', '弃用（扫描引用 Agent 并告警负责人）'],
    ],
    api: [
      'GET /api/skills?q=&category=&sort=&mine=1&pending=1 · GET /api/skills/:id',
      'POST /api/skills（提交即扫描）',
      'POST /api/skills/:id/approve|publish|deprecate|install|uninstall|rate|download',
    ],
    tools: ['skill_search', 'skill_submit', 'skill_approve', 'skill_publish', 'skill_install', 'skill_deprecate'],
    ui: { routes: ['#/skills'], menus: [{ group: 'AI 资源', items: ['Skill 市场'] }] },
  },
  {
    dir: 'agent', id: 'dsh-plugin-agent', label: 'Agent 本体',
    depends: ['dsh-plugin-platform-core', 'dsh-plugin-resource-core', 'dsh-plugin-authn', 'dsh-plugin-iam', 'dsh-plugin-audit'], permissions: ['agent.read', 'agent.write', 'agent.approve', 'agent.offline'],
    services: [['agentRegistry', 'ctx.agentRegistry', '注册（颁发机器凭证）/绑定用户/监测归集/生命周期 L4 + on-behalf-of']],
    events: [
      ['agent.registered / agent.onlined', 'emit', '注册与上线'],
      ['agent.offlined', 'emit', '下线（authn 吊销凭证、通知绑定用户）'],
      ['mcp.invoked / skill.deprecated', 'on', '订阅：归集指标 / 存量引用告警'],
    ],
    api: [
      'GET/POST /api/agents · GET /api/agents/:id · PATCH /api/agents/:id',
      'POST /api/agents/:id/transition（L4 走审批）',
      'POST/DELETE /api/agents/:id/bindings[/:userId]',
      'POST /api/agents/:id/obo-token（on-behalf-of）',
    ],
    tools: ['agent_list', 'agent_get', 'agent_offline', 'agent_metrics', 'agent_bind_user'],
    ui: { routes: ['#/agents'], menus: [{ group: 'AI 资源', items: ['Agent 本体'] }] },
  },
  {
    dir: 'app', id: 'dsh-plugin-app', label: 'AI 应用本体',
    depends: ['dsh-plugin-platform-core', 'dsh-plugin-resource-core', 'dsh-plugin-authn', 'dsh-plugin-audit'], permissions: ['app.read', 'app.write', 'app.offline'],
    services: [['appRegistry', 'ctx.appRegistry', '应用注册/编排依赖图（拓扑）/应用层指标/成本穿透/生命周期']],
    events: [
      ['app.registered / app.onlined / app.offlined', 'emit', '应用生命周期'],
    ],
    api: [
      'GET/POST /api/apps · GET /api/apps/:id · PATCH /api/apps/:id',
      'POST /api/apps/:id/transition（发布/下架为 L4 审批）',
      'GET /api/apps/:id（含 topology/cost/impact）',
    ],
    tools: ['app_list', 'app_topology', 'app_metrics', 'app_cost_breakdown'],
    ui: { routes: ['#/apps'], menus: [{ group: 'AI 资源', items: ['AI 应用'] }] },
  },
  {
    dir: 'console', id: 'dsh-plugin-console', label: '管理控制台（接入层）',
    depends: ['dsh-plugin-platform-core', '全部业务插件'], permissions: ['console.login'],
    services: [],
    events: [['audit.authz.denied', 'emit', '网关越权拒绝（audit 订阅计数告警）']],
    api: [
      'POST /api/tools/execute（工具桥：与 dsh ToolRuntime 同一契约）',
      'GET /api/platform/info（插件树/工具目录/集合） · GET /api/overview（工作台聚合）',
      '静态托管 public/ SPA（飞书级控制台）',
    ],
    ui: {
      routes: ['#/dashboard', '#/platform', '（业务页面由各插件 ui.yaml 声明）'],
      menus: [{ group: '总览', items: ['工作台'] }, { group: '平台', items: ['插件与工具'] }],
    },
  },
]

const yml = (value, indent = 0) => {
  const pad = '  '.repeat(indent)
  if (Array.isArray(value)) {
    return value.map((item) => typeof item === 'object'
      ? `${pad}-\n${yml(item, indent + 1)}`
      : `${pad}- ${String(item).replace(/^#/, '# ')}`).join('\n')
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).map(([key, val]) => {
      if (Array.isArray(val) || (typeof val === 'object' && val !== null)) {
        const nested = yml(val, indent + 1)
        return `${pad}${key}:\n${nested}`
      }
      return `${pad}${key}: ${String(val)}`
    }).join('\n')
  }
  return `${pad}${value}`
}

for (const plugin of PLUGINS) {
  const pkgDir = join(ROOT, 'packages', plugin.dir === 'platform-core' || plugin.dir === 'resource-core' ? `plugin-${plugin.dir}` : `plugin-${plugin.dir}`)
  const manifestDir = join(pkgDir, 'manifest')
  mkdirSync(manifestDir, { recursive: true })

  const write = (file, content) => writeFileSync(file, content.trim() + '\n', 'utf8')

  write(join(pkgDir, 'plugin.yaml'), `
# 插件声明：id、版本、依赖与权限点（插件标准解剖结构）
id: ${plugin.id}
version: 1.0.0
label: ${plugin.label}
depends: [${plugin.depends.map((d) => `'${d}'`).join(', ')}]
provides:
  services:
${plugin.services.map(([key]) => `    - ${key}`).join('\n') || '    []'}
permissions:
${plugin.permissions.map((p) => `  - ${p}`).join('\n') || '  []'}
`)

  write(join(manifestDir, 'api.yaml'), `
# OpenAPI 摘要（REST + 工具 + 服务键）—— CLI/Skill/Web 三端对齐的唯一事实源
plugin: ${plugin.id}
base: /api
endpoints:
${plugin.api.map((line) => `  - ${String(line).replace(/#/g, '#').trim()}`).join('\n')}
${plugin.tools?.length ? `tools:
${plugin.tools.map((t) => `  - ${t}`).join('\n')}` : ''}
services:
${plugin.services.map(([key, prop, desc]) => `  - key: ${key}\n    access: ${prop}\n    description: ${desc}`).join('\n') || '  []'}
`)

  write(join(manifestDir, 'permissions.yaml'), `
# 权限点声明（注册进统一 RBAC，控制台/CLI/工具共用）
plugin: ${plugin.id}
points:
${plugin.permissions.map((p) => `  - ${p}`).join('\n') || '  []'}
`)

  write(join(manifestDir, 'events.yaml'), `
# 事件声明（发布/订阅）——跨插件联动只许通过事件或扩展点
plugin: ${plugin.id}
events:
${plugin.events.map(([name, mode, desc]) => `  - name: ${name}\n    mode: ${mode}\n    description: ${desc}`).join('\n')}
`)

  write(join(manifestDir, 'ui.yaml'), `
# 前端路由 + 菜单声明（控制台按此注入导航；表单骨架由 api.yaml 的 schema 生成）
plugin: ${plugin.id}
routes:
${plugin.ui.routes.map((r) => `  - ${r}`).join('\n') || '  []'}
menus:
${yml(plugin.ui.menus, 0)}
`)
  process.stdout.write(`manifest ✓ ${plugin.id}\n`)
}
console.log('\n全部插件声明已生成。')
