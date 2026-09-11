/**
 * 依据「插件标准解剖结构」批量生成各插件的声明文件：
 *   plugin.yaml（id/version/依赖/权限）+ manifest/{api,permissions,events,ui}.yaml
 * 这些声明是插件对外的契约文档（api.yaml 为唯一事实源，CLI/Skill/Web 三端对齐）。
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

// 版本唯一事实源：根 package.json（plugin.yaml/manifest 与根版本一处同步，不再散落硬编码）
const VERSION = String(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? '0.0.0')

const PLUGINS = [
  {
    dir: 'platform-core', id: 'dsh-plugin-platform-core', label: '平台基础',
    depends: [], permissions: ['console.login'],
    services: [
      ['opsStorage', 'ctx.opsStorage', 'JSON 集合存储（原子落盘，可替换 DB）'],
      ['platformBus', 'ctx.platformBus', '平台事件总线（插件协作唯一胶水）'],
      ['tools', 'ctx.tools', 'ToolRuntime-lite（独立宿主；dsh 下由原生 ToolRuntime 提供）'],
      ['httpServer', 'ctx.httpServer', 'HTTP 服务：REST 路由 + 静态资源'],
      ['scenegraphs', 'ctx.scenegraphs', '行业场景图谱装载（一图四清单；lint 与运行时同校验器，scenegraph.updated 热刷新）'],
    ],
    events: [
      ['tools/change', 'emit', '工具注册变更（lite 运行时）'],
      ['scenegraph.updated', 'emit', '行业场景图谱重载完成（部门面板热刷新）'],
    ],
    api: ['# 平台自身无业务 REST 页面；behavior 采集面如下（console 聚合面见 console 清单）',
      'POST /api/behavior/events（行为采集 write-only：公开挂载于 console 鉴权之后，行为层再校验主体，双层 fail-closed） · GET /api/behavior/events（读取：主体权限校验）'],
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
    depends: ['dsh-plugin-platform-core'], permissions: ['iam.org.read', 'iam.org.write', 'iam.user.read', 'iam.user.write', 'iam.user.freeze', 'iam.role.write', 'iam.connector.write', 'iam.scene.write'],
    services: [['iam', 'ctx.iam', '组织/账号/角色/用户组/三方连接器（OrgConnector 可插拔）']],
    events: [
      ['iam.user.frozen', 'emit', '账号冻结（authn 订阅吊销令牌）'],
      ['iam.user.activated', 'emit', '账号恢复'],
      ['iam.org.changed', 'emit', '组织变更'],
      ['iam.permission.changed', 'emit', '权限变更（全插件缓存失效）'],
      ['iam.connector.synced', 'emit', '三方同步完成'],
      ['iam.scene_policy.changed', 'emit', '场景级授权策略变更（IAW 6-1）'],
    ],
    api: [
      'GET/POST /api/iam/orgs · GET /api/iam/orgs/tree · PATCH /api/iam/orgs/:id · DELETE /api/iam/orgs/:id（body {cascade:true} 一键级联删除子树，直属账号上移到上级组织）',
      'GET/POST /api/iam/users · PATCH /api/iam/users/:id · POST /api/iam/users/import',
      'PATCH /api/iam/users/:id（status 冻结/恢复即走此处） · POST /api/iam/users/:id/reset-password',
      'POST /api/iam/users/:id/bindings · DELETE /api/iam/users/:id/bindings/:provider（三方身份绑定）',
      'GET /api/iam/roles · GET /api/iam/permissions · POST /api/iam/roles · PATCH /api/iam/roles/:id',
      'GET/POST /api/iam/groups · PATCH/DELETE /api/iam/groups/:id · POST /api/iam/groups/refresh-snapshots',
      'GET/POST /api/iam/connectors · PUT /api/iam/connectors/:provider · POST /api/iam/connectors/:provider/test · POST /api/iam/connectors/:provider/sync · POST /api/iam/connectors/auto-sync · DELETE /api/iam/connectors/:provider',
      'GET /api/iam/conflicts · POST /api/iam/conflicts/:id/resolve',
      'GET /api/iam/roster · GET/POST /api/iam/tenants（名册/租户，console 聚合面）',
      '# v1.1（融合 auth-identity）：IdentityProviderAdapter + 身份链接事实源；identityLinks 集合（provider+providerUserId 引擎级唯一）；bindThirdParty 走链接层',
    ],
    tools: ['iam_org_tree', 'iam_org_create', 'iam_org_update', 'iam_user_list', 'iam_user_create', 'iam_user_reset_password', 'iam_user_freeze', 'iam_role_list', 'iam_sync_run', 'iam_conflict_list'],
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
      'GET /api/auth/me · POST /api/auth/logout（主动登出：sid 全链吊销）',
      'GET /api/auth/providers · GET /api/auth/sso · GET /api/auth/sso/callback · POST /api/auth/sso/authorize · POST /api/auth/sso/register · POST /api/auth/sso/bind · POST /api/auth/sso/bind/authorize（SSO 注册/绑定面，console 承载）',
      'POST /api/auth/refresh（刷新票换新访问令牌） · POST /api/auth/entry-ticket-session（票据免登建立控制台会话） · POST /api/auth/entry-tickets/self（面板自领票据）',
      'POST /api/authn/entry-tickets/redeem（公开：平台授权直达换身份） · POST /api/authn/verify-audience（受众校验） · GET /api/authn/bindable-resources（可绑定资源清单）',
      'GET/POST /api/authn/oidc/clients · PATCH /api/authn/oidc/clients/:id · POST /api/authn/oidc/clients/:id/rotate（OIDC 客户端治理）',
      'GET /api/authn/oidc/discovery · POST /api/authn/oidc/keys/rotate（发现文档/签名密钥轮换）',
      'GET /api/authn/oidc/auth-requests/:id（授权页查询：公开前缀，仅回显客户端名/scope） · POST /api/authn/oidc/authorize（授权提交）',
      'GET /.well-known/openid-configuration · GET /.well-known/jwks.json（OIDC 协议发现/公钥）',
      'GET /oauth/authorize · POST /oauth/token · GET /oauth/userinfo · GET /oauth/end_session · POST /oauth/revoke（OIDC 协议端点）',
      'GET/POST /api/authn/principals · PATCH /api/authn/principals/:id（scopes 调整，联动吊销令牌）',
      'POST /api/authn/principals/:id/disable|enable|rotate-secret（轮换：旧值即废，新值仅一次返回）',
      'GET/POST /api/authn/tokens · DELETE /api/authn/tokens/:jti · POST /api/authn/rotate-secret',
    ],
    tools: ['authn_token_issue', 'authn_token_revoke', 'authn_token_list', 'authn_credential_create', 'authn_credential_scopes', 'authn_credential_rotate'],
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
      'GET/POST /api/audit/alert-rules · PATCH /api/audit/alert-rules/:id · GET /api/audit/alerts · POST /api/audit/alerts/:id/read · POST /api/audit/alerts/read-all',
      'GET /api/audit/cost?groupBy=app|agent|org|date',
      'GET /api/approvals · GET /api/approvals/sla · POST /api/approvals/:id/decide',
      'POST /api/audit/evidence（panel.write；IAW 5-1 结论级证据锚点登记）· GET /api/audit/evidence/:id（panel.read）',
      'GET /api/audit/timeline?sceneCode=（panel.read；IAW 5-2 场景/任务维度审计时间线）',
    ],
    tools: ['audit_logs', 'audit_alerts_list', 'audit_alerts_read_all', 'approval_decide', 'audit_cost_report'],
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
      'POST /api/mcp/import（mcpServers JSON 一键导入：解析→注册 external 服务→自动发现工具）',
      'POST /api/mcp/services/:id/sync-tools（外部服务以远端 tools/list 为准刷新清单）',
      'DELETE /api/mcp/services/:id（仅下线可删；被权限组引用时拒绝）',
      'POST /api/mcp/services/:id/verify|deploy|rollback|offline|health · POST /api/mcp/services/:id/final-review（两级审批终审）',
      'GET /api/mcp/services/:id/metrics · GET /api/mcp/calls',
      'GET/POST /api/mcp/perm-groups · PATCH/DELETE /api/mcp/perm-groups/:id',
      'POST /api/mcp/invoke（网关统一鉴权/限流/审计）',
    ],
    tools: ['mcp_service_list', 'mcp_deploy', 'mcp_offline', 'mcp_metrics', 'mcp_invoke', 'mcp_health_check'],
    ui: { routes: ['#/mcp'], menus: [{ group: 'AI 资源', items: ['MCP 服务'] }] },
  },
  {
    dir: 'connector', id: 'dsh-plugin-connector', label: 'SaaS 连接器纳管',
    depends: ['dsh-plugin-platform-core', 'dsh-plugin-iam', 'dsh-plugin-audit', 'dsh-plugin-usage'],
    permissions: ['connector.gateway.write', 'connector.catalog.read', 'connector.connection.read', 'connector.connection.write', 'connector.invoke', 'connector.permgroup.write', 'connector.runs.read', 'connector.market.publish'],
    services: [['connectorHub', 'ctx.connectorHub', 'open-connector v1.4.0 数据面网关适配：目录同步/连接管理（OAuth·APIKey·no_auth）/invoke 六步链/oct_ 令牌策略镜像/runs 对账']],
    events: [
      ['connector.gateway.changed', 'emit', '网关配置变更或恢复健康'],
      ['connector.gateway.synced', 'emit', '目录同步/org 巡检结果'],
      ['connector.gateway.unhealthy', 'emit', '网关不可用 fail-closed 告警（audit 订阅）'],
      ['connector.connected / connector.disconnected', 'emit', '连接生命周期'],
      ['connector.invoked', 'emit', '连接器调用（审计透传 actChain+runId；成本归集 connector:*）'],
      ['connector.permgroup.changed', 'emit', '权限组变更（oct_ 令牌镜像联动）'],
    ],
    api: [
      'GET/PUT /api/connector/gateway · POST /api/connector/gateway/health · POST /api/connector/gateway/offline · POST /api/connector/gateway/online · POST /api/connector/patrol（org 巡检）',
      'GET /api/connector/catalog · GET /api/connector/catalog/actions/:actionId[/guide] · POST /api/connector/catalog/sync',
      'GET /api/connector/connections · POST /api/connector/connections/oauth|api-key|no-auth · DELETE /api/connector/connections/:id · GET /api/connector/connections/oauth/:id/status · POST /api/connector/connections/refresh（凭据批量刷新）',
      'POST /api/connector/connections/:id/offline · POST /api/connector/connections/:id/online（连接上下线闸：下线后 invoke 立拒）',
      'POST /api/connector/execute（六步链：RBAC→权限组→审批→限流→oct_ 令牌→数据面）',
      'GET/POST /api/connector/perm-groups · PATCH/DELETE /api/connector/perm-groups/:id · POST /api/connector/perm-groups/:id/impact',
      'GET /api/connector/runs · POST /api/connector/reconcile · GET /api/connector/tokens',
    ],
    tools: ['connector_catalog_search', 'connector_connection_list', 'connector_execute', 'connector_perm_group_list', 'connector_run_list'],
    ui: { routes: ['#/connectors'], menus: [{ group: 'AI 资源', items: ['连接器'] }] },
  },
  {
    dir: 'skillhub', id: 'dsh-plugin-skillhub', label: 'Skill 市场',
    depends: ['dsh-plugin-platform-core', 'dsh-plugin-resource-core', 'dsh-plugin-audit'], permissions: ['skill.read', 'skill.submit', 'skill.approve', 'skill.publish', 'skill.install', 'skill.storage.write'],
    services: [['skillHub', 'ctx.skillHub', '提交→静态扫描→两级审批→版本化上架 + 安装依赖登记 + 评分检索 + skill.zip 包存储（local/NAS）；下载/安装进 usage 计量（skill:* 资源），弃用原因落库持久化']],
    events: [
      ['skill.submitted / skill.published / skill.installed', 'emit', '流水线事件'],
      ['skill.deprecated', 'emit', '弃用（扫描引用 Agent 并告警负责人）'],
    ],
    api: [
      'GET /api/skills?q=&category=&sort=&mine=1&pending=1 · GET /api/skills/:id',
      'POST /api/skills（提交即扫描；可选 packageBase64 随传 skill.zip）',
      'POST /api/skills/:id/approve|publish|deprecate|install|uninstall|rate|download',
      'GET /api/skills/:id/package?version=（拉取 skill.zip；NAS 模式经网关 fs_download 中转）',
      'PATCH /api/skills/:id（修订待审条目） · DELETE /api/skills/:id（下架移除） · PUT /api/skills/:id/package（版本包上传/替换）',
      'GET/PUT /api/skill-storage（包存储后端配置，写需 skill.storage.write）',
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
      'GET/POST /api/agents · GET /api/agents/:id · PATCH/DELETE /api/agents/:id',
      'POST /api/agents/:id/transition（L4 走审批）',
      'POST /api/agents/:id/bindings · DELETE /api/agents/:id/bindings/:userId',
      'POST /api/agents/:id/obo-token（on-behalf-of）',
      'POST /api/agents/:id/sso-client · PATCH /api/agents/:id/sso-client · POST /api/agents/:id/sso-client/rotate（SSO 客户端治理）',
      'POST /api/agents/:id/entry-ticket（平台授权直达入场票据） · POST /api/agents/:id/metrics-report（指标主动上报） · POST /api/agents/:id/onboarding-prompt（入职提示词重生成）',
    ],
    tools: ['agent_list', 'agent_get', 'agent_offline', 'agent_metrics', 'agent_metrics_report', 'agent_bind_user'],
    ui: { routes: ['#/agents'], menus: [{ group: 'AI 资源', items: ['Agent 本体'] }] },
  },
  {
    dir: 'app', id: 'dsh-plugin-app', label: 'AI 应用本体',
    depends: ['dsh-plugin-platform-core', 'dsh-plugin-resource-core', 'dsh-plugin-authn', 'dsh-plugin-audit'], permissions: ['app.read', 'app.write', 'app.offline'],
    services: [['appRegistry', 'ctx.appRegistry', '应用注册/编排依赖图（拓扑）/应用层指标/成本穿透/生命周期']],
    events: [
      ['app.registered / app.onlined / app.offlined', 'emit', '应用生命周期'],
      ['authn.entryticket.redeemed / oidc.authorize.granted', 'on', '订阅：SSO 身份到访自动折算应用 DAU（trackVisit）'],
    ],
    api: [
      'GET/POST /api/apps · GET /api/apps/:id · PATCH /api/apps/:id',
      'POST /api/apps/:id/transition（发布/下架为 L4 审批）',
      'POST /api/apps/:id/metrics-report（应用指标主动上报：PV/UV/DAU/会话/留存，可 --date 补录）',
      'POST /api/apps/:id/entry-ticket（平台授权直达：一次性入场票据，#entry_ticket 打开应用）',
      'GET /api/apps/:id（含 topology/cost/impact） · DELETE /api/apps/:id（下架移除）',
      'POST /api/apps/:id/sso-client · PATCH /api/apps/:id/sso-client · POST /api/apps/:id/sso-client/rotate（应用 SSO 客户端治理） · POST /api/apps/:id/onboarding-prompt（接入提示词重生成）',
      'GET /api/apps/developer-options（开发者接入选项）',
      '# 平台侧自动折算：entry-ticket 兑换 / OIDC 发码 → DAU；浏览器 beacon → PV/UV（端点经 console 聚合暴露）',
    ],
    tools: ['app_list', 'app_topology', 'app_metrics', 'app_metrics_report', 'app_cost_breakdown'],
    ui: { routes: ['#/apps'], menus: [{ group: 'AI 资源', items: ['AI 应用'] }] },
  },
  {
    dir: 'nas', id: 'dsh-plugin-nas', label: 'NAS 文件存储',
    depends: ['dsh-plugin-platform-core', 'dsh-plugin-resource-core', 'dsh-plugin-iam', 'dsh-plugin-audit'],
    permissions: ['nas.read', 'nas.write', 'nas.authz.read', 'nas.authz.write', 'nas.authz.check'],
    services: [['nasRegistry', 'ctx.nasRegistry', 'NAS 资产注册/生命周期/探活 + MCP 文件网关客户端（synology-filestation 形态）+ Skill 包存储配置；全部文件操作进 usage 计量（nas:* 资源，calls/bytes 口径）']],
    events: [
      ['nas.registered / nas.onlined / nas.offlined', 'emit', 'NAS 资产生命周期'],
    ],
    api: [
      'GET/POST /api/nas · GET/PATCH/DELETE /api/nas/:id · POST /api/nas/import（mcpServers JSON 一键纳管）',
      'POST /api/nas/:id/transition|health|sync-tools',
      'GET /api/nas/:id/fs（?path= 子目录定位） · GET /api/nas/:id/fs/info',
      'GET /api/nas/:id/fs/file?path=&inline=（流式文件下载：浏览器拿到 bytes + content-disposition attachment|inline）',
      'POST /api/nas/:id/fs/search|mkdir|rename|delete|upload|download|upload-many（经网关 fs_* 工具） · POST /api/nas/:id/fs/download-ticket（下载票据：浏览器持票直连网关取流）',
      'GET/PUT /api/skill-storage（Skill 包存储后端：local | 已纳管 NAS 资产）',
      'GET /api/nas/authz/scope · GET /api/nas/authz/rules · PUT /api/nas/authz/rules · POST /api/nas/authz/rules/import（授权规则面）',
      'POST /api/nas/authz/check（单点鉴权自查） · POST /api/nas/authz/exceptions · GET /api/nas/authz/exceptions（例外登记/清单）',
      'GET /api/nas/authz/decisions（判定留痕查询） · POST /api/nas/authz/reconcile · POST /api/nas/authz/leader-vacancy-scan（对账与主例外巡检）',
    ],
    tools: ['nas_list', 'nas_get', 'nas_health_check', 'nas_fs_list', 'nas_fs_search', 'nas_fs_mkdir', 'nas_fs_delete', 'nas_fs_upload'],
    ui: { routes: ['#/nas'], menus: [{ group: 'AI 资源', items: ['NAS 存储'] }] },
  },
  {
    dir: 'console', id: 'dsh-plugin-console', label: '管理控制台（接入层）',
    depends: ['dsh-plugin-platform-core', '全部业务插件'], permissions: ['console.login'],
    services: [],
    events: [
      ['audit.authz.denied', 'emit', '网关越权拒绝（audit 订阅计数告警）'],
      ['authn.entryticket.redeemed', 'emit', 'entry-ticket 兑换（app 插件订阅 → 应用 DAU 自动折算）'],
    ],
    api: [
      'POST /api/tools/execute（工具桥：与 dsh ToolRuntime 同一契约）',
      'GET/POST/DELETE /mcp（平台即 MCP Server：Streamable HTTP，initialize/tools/list/tools/call，Bearer 鉴权 + 工具级权限点；GET=SSE 流、DELETE=会话终结） · GET /docs（控制台文档页）',
      'GET /api/health（存活探针） · GET /api/tools/schemas（工具 schema 目录） · GET /api/platform/route-matrix（路由矩阵自检）',
      'GET /api/platform/info（插件树/工具目录/集合） · GET /api/overview（工作台聚合）',
      'GET /api/assets/inventory（资产台账） · POST /api/assets/healthcheck（健康巡检） · GET /api/assets/report（成本报表）',
      'GET /api/assets/benefit（成本穿透：内部成本参考 + 单位 DAU 成本，零价快照口径） · GET /api/assets/retire-reasons（下架分析：弃用/下线原因聚合）',
      'GET /api/skills/usage-heatmap（技能热力图：skill × 日 使用矩阵）',
      'GET /api/usage/report/monthly（J4 月度用量报表：部门/Agent/Skill tokens 三维聚合；format=csv 自助导出）',
      'POST /api/usage/retention/purge（usage.admin；保留策略手动巡检，body.days 可临时收紧窗口，0=跳过）',
      'GET /api/usage/summary?window=today|month&org=&subject=（panel.read；IAW 4-1 成本摘要+预算进度，非 usage.read 主体强制收敛自身组织）',
      'GET /api/usage/feedback-stats?days=7|30|90|all（panel.read；IAW 4-2 产出采纳率聚合）',
      'GET /api/notifications?since=&limit= · POST /api/notifications/read-cursor（console.login；IAW 8-1 通知中心持久化+已读游标）',
      'GET /api/modelgw/channel-groups（panel.read）· PUT /api/modelgw/channel-groups（panel.config.write；IAW 1-2 渠道组降级链）',
      'GET /api/modelgw/:slug/telemetry?window=7d（panel.read；IAW 1-3 渠道遥测，TTFT 诚实缺列）',
      'GET /api/modelgw/budgets（panel.read）· PUT /api/modelgw/budgets（panel.config.write；IAW 1-4 预算熔断）',
      'PUT /api/iam/scene-policies（iam.scene.write）· GET /api/iam/scene-policies（iam.org.read）· DELETE /:id（IAW 6-1 场景级授权）· POST /api/iam/scene-authz/check（panel.read 自查）',
      'GET /api/resource/datasets?scene=（panel.read）· PUT /api/resource/datasets · PUT /api/resource/datasets/:code/quality（resource.dataset.write；IAW 2-1/2-2）',
      'GET /api/resource/lineage?dataset=（panel.read）· PUT /api/resource/lineage（resource.dataset.write；IAW 2-3 血缘）',
      'GET/PUT /api/resource/metrics/:code/definitions（读 panel.read / 写 resource.dataset.write）· POST /api/resource/metrics/:code/arbitrate（IAW 2-4 指标口径仲裁）',
      'POST /api/agents/:id/a2a/invoke（agent.a2a.invoke；IAW 7-1 A2A 跨运行时点名调用，autonomy/runtime 随响应透出）',
      'POST /api/market/developers/register · POST /api/market/developers/login（开发者入驻，公开）',
      'GET /api/market/submissions · POST /api/market/submit（提交上架） · GET /api/market/submissions/mine（我的提交）',
      'POST /api/market/submissions/:id/approve · POST /api/market/submissions/:id/reject（两级审批）',
      'GET /api/market/plugins · POST /api/market/plugins/:id/install · POST /api/market/plugins/:id/uninstall（安装/卸载）',
      'GET /api/market/installed · GET /api/market/prompts · POST /api/market/prompts/use（已装清单/提示词市场） · POST /api/market/sandbox-check（沙箱预检）',
      'GET/POST /api/modelgw/models · DELETE /api/modelgw/models/:id（模型登记治理，panel.config.write）',
      'POST /api/modelgw/invoke（网关统一调用入口） · POST /api/modelgw/channel-groups/:id/invoke（渠道组定向调用）',
      'POST /api/usage/record（写入计量） · GET /api/usage/events（事件流水） · GET /api/usage/totals（聚合） · GET /api/usage/recent（最近条目）',
      'POST /api/usage/reconcile（对账） · POST /api/usage/replay（重放） · GET/PUT /api/usage/price-book（价格册）',
      'GET /api/usage/dead-letters · POST /api/usage/dead-letters/retry（死信查询/重投） · POST /api/usage/feedback（采纳率反馈） · PUT /api/usage/capability-grants（能力授予）',
      'GET/POST /api/apps/beacon（公开访客埋点：GET 1x1 GIF / POST JSON；?app=&vid=&uid= → PV 累加、UV 去重；IP+应用 60 次/分钟限流）',
      '# 静态托管 public/ SPA（飞书级控制台）',
    ],
    ui: {
      routes: ['#/dashboard', '#/assets', '#/platform', '（业务页面由各插件 ui.yaml 声明）'],
      menus: [{ group: '总览', items: ['工作台'] }, { group: '治理与运营', items: ['资产运营'] }, { group: '平台', items: ['插件与工具'] }],
    },
  },
  {
    dir: 'update', id: 'dsh-plugin-update', label: '平台自更新（版本检查/通知/一键升级）',
    depends: ['dsh-plugin-platform-core', 'dsh-plugin-iam'], permissions: ['platform.update.read', 'platform.update.apply'],
    services: [
      ['update', 'ctx.update', '上游版本检查（自动+手动）/ 更新通知 / source 形态一键升级（git pull + npm install）'],
    ],
    events: [
      ['platform.update.available', 'emit', '发现上游新版本（audit 订阅留痕）'],
      ['platform.update.applied', 'emit', '一键升级执行完成'],
    ],
    api: [
      'GET /api/update/status（全部登录用户：顶栏更新横幅）',
      'POST /api/update/check（platform.update.read，60s 冷却）',
      'POST /api/update/settings · POST /api/update/apply（platform.update.apply，apply 支持 dry-run）',
    ],
    tools: ['update_status', 'update_check', 'update_apply'],
    ui: { routes: ['顶栏更新徽标 + 更新抽屉（无独立页面）'], menus: [] },
  },
  {
    dir: 'portal', id: 'dsh-plugin-portal', label: '门户数据通道（外部拉取端点·非核心）',
    depends: ['dsh-plugin-platform-core'], permissions: [],
    services: [
      ['portalFeed', 'ctx.portalFeed', '门户契约快照：apps/employees/skills/stats 映射与公开只读端点应答'],
    ],
    events: [
      ['app.onlined / app.offlined', 'subscribe', '应用上下线 → 门户可见性审计留痕（拉取模式，无外呼）'],
      ['agent.onlined / agent.offlined', 'subscribe', 'Agent 上下线 → 门户可见性审计留痕（拉取模式，无外呼）'],
    ],
    api: [
      'GET /api/portal（端点发现：联调自检入口，公开无鉴权）',
      'GET /api/portal/apps # 已上线 AI 应用（门户契约 /apps，api.md v1.1）',
      'GET /api/portal/employees # 已上线 Agent=数字员工（门户契约 /employees）',
      'GET /api/portal/solutions # 解决方案（暂无数据源，空数组=门户降级样板）',
      'GET /api/portal/tools # AI 工具地图（暂无数据源，空数组=门户降级样板）',
      'GET /api/portal/skills # 已上架 Skill（门户契约 /skills，downloadUrl=登录下载端点）',
      'GET /api/portal/skills/:id/download # 技能包下载（zip 字节直出；v1.1 起须 Bearer 登录令牌：未登录 401，审计谁在下载；预检放行 authorization 头）',
      'GET /api/portal/stats # 首页统计 4 卡（门户契约 /stats）',
    ],
    ui: { routes: [], menus: [] },
  },
  {
    dir: 'panel-core', id: 'dsh-plugin-panel-core', label: '部门 Agent 工作台面板（骨架+数据面）',
    depends: ['dsh-plugin-platform-core', 'dsh-plugin-iam', 'dsh-plugin-audit', 'dsh-plugin-usage', 'dsh-plugin-modelgw'],
    permissions: ['panel.read', 'panel.write', 'panel.task.write', 'panel.config.write', 'scenegraph.read', 'scenegraph.activate'],
    services: [
      ['panel', 'ctx.panel', '部门面板域：deptConfigs/channels/messages/tasks/artifacts/readCursors/activations + panelAgentRuntime + widget 求值'],
    ],
    events: [
      ['panel.message.created', 'emit', '面板消息产生（钉钉桥接订阅做同步投递；SSE 推流）'],
      ['panel.card.action', 'emit', 'Agent 操作卡片按钮动作（任务落点/审批链）'],
      ['panel.task.updated', 'emit', '任务泳道迁移（看板实时刷新）'],
      ['panel.industry.activated', 'emit', '行业授权激活完成（面板解锁行业图谱）'],
      ['scenegraph.updated', 'subscribe', '图谱热刷新 → 面板场景页失效重载'],
      ['dingtalk-bridge.delivered', 'subscribe', '钉钉投递回执 → 消息 ddSync 状态更新'],
    ],
    api: [
      'GET /api/panel/depts · GET /api/panel/:dept/overview · GET /api/panel/:dept/board（panel.read）',
      'GET/PUT /api/panel/:dept/widgets · GET/PUT /api/panel/:dept/kpis（读 panel.read / 写 panel.config.write）',
      'GET/POST /api/panel/:dept/channels · GET/POST /api/panel/:dept/messages · POST /api/panel/messages/:id/card-action',
      'GET/POST /api/panel/:dept/tasks · POST /api/panel/tasks/:id/transition（panel.task.write）',
      'GET /api/panel/:dept/artifacts · GET /api/panel/:dept/poll（降级轮询）',
      'GET /api/panel/:dept/skills（panel.read）· POST /api/panel/:dept/skills/invoke（panel.write；J1 直调：降级=200+ok:false，鉴权/范围=403/400）',
      'POST /api/panel/stream-ticket（panel.read + 部门范围校验；换取 ≤60s 一次性 SSE 票据，H4）',
      'GET /api/panel/stream?dept=&ticket=|token=（SSE；EventSource 无法带 Bearer：首选一次性 ticket 消费即焚，?token= 旧通道自校验 fail-closed）',
      'GET /api/panel/industries（三态）· POST /api/panel/industries/:code/activate-requests',
      'GET /api/panel/scenegraph?industry=（scenegraph.read）· POST /api/panel/scenegraphs/reload（panel.config.write）',
      'GET /panel（面板 SPA 页面） · GET /api/panel/orgs（部门树）',
      'GET/POST /api/panel/models（模型端点登记） · DELETE /api/panel/models/:id · POST /api/panel/models/:id/test（连通性测试）',
      'POST /api/panel/channels/:id/read（频道已读游标）',
      'PUT /api/panel/:dept/config（面板配置） · PUT /api/panel/:dept/agents（Agent 阵容） · POST /api/panel/:dept/artifacts（产物登记）',
      'POST /api/panel/:dept/scenes/:scene/diagnose（场景诊断） · POST /api/panel/:dept/scenes/:scene/sync-dingtalk（场景钉钉同步）',
    ],
    tools: ['panel_agents_list', 'panel_msg_send', 'panel_task_create', 'panel_task_transition', 'panel_scene_diag', 'panel_widget_data', 'panel_agent_invoke', 'panel_skill_invoke'],
    ui: {
      routes: ['/panel/（独立零构建 SPA：顶栏/部门 rail/三栏/会话/任务看板/部门知识/场景图谱）'],
      menus: [{ group: '总览', items: ['部门面板（/panel/ 外链入口）'] }],
    },
  },
  {
    dir: 'flow-core', id: 'dsh-plugin-flow-core', label: '事务流引擎（TF 编排/模板库/SLA/甘特）',
    depends: ['dsh-plugin-platform-core', 'dsh-plugin-iam'], permissions: ['flow.read', 'flow.write', 'flow.admin'],
    services: [
      ['flow', 'ctx.flow', '事务流引擎：TF CRUD + 步骤状态机（人/Agent/网关）+ 模板库 + SLA/进度（IAW 3-1..3-4）'],
    ],
    events: [
      ['flow.created', 'emit', 'TF 创建（面板 SSE 扇出）'],
      ['flow.step.updated', 'emit', 'TF 步骤状态机流转（面板 SSE 扇出）'],
      ['flow.completed', 'emit', 'TF 全链完成'],
      ['flow.template.changed', 'emit', '模板库变更'],
    ],
    api: [
      'GET /api/flow/templates?sceneCode=（flow.read；IAW 3-2 模板库）· PUT /api/flow/templates · DELETE /api/flow/templates/:code（flow.admin）',
      'GET /api/flow/flows?sceneCode=&dept=&status=（flow.read）· GET /api/flow/flows/:id（progress/sla/步骤时间轴随响应）',
      'POST /api/flow/flows（flow.write；templateCode 实例化或自由编排，上下文包随创建返回）',
      'POST /api/flow/flows/:id/steps/:key/transition（flow.write；start/complete/block/restart/skip）· POST /api/flow/flows/:id/cancel',
    ],
    ui: { routes: [], menus: [] },
  },
  {
    dir: 'dingtalk-bridge', id: 'dsh-plugin-dingtalk-bridge', label: '钉钉桥接（群桥/出向投递/审批推送/告警通道）',
    depends: ['dsh-plugin-platform-core', 'dsh-plugin-iam', 'dsh-plugin-audit'],
    permissions: ['dingtalk.message.send', 'panel.read'],
    services: [
      ['dingtalkBridge', 'ctx.dingtalkBridge', '群桥绑定 + 出向消息投递（凭证单一来源=iam 连接器）+ 回执 + 审批/告警推送'],
    ],
    events: [
      ['panel.message.created', 'subscribe', '面板消息（ddSync）→ 钉钉群投递'],
      ['audit.alert.fired', 'subscribe', '告警 channels 含 dingtalk → 坐实投递（补齐仓库欠账）'],
      ['dingtalk-bridge.delivered', 'emit', '投递回执（面板订阅更新 ddSync 状态）'],
    ],
    api: [
      'GET /api/dingtalk/status（连接器形态/个人绑定/DWS/入向能力声明）',
      'GET /api/dingtalk/bridges?dept= · POST/DELETE /api/dingtalk/channels/:id/bridge（dingtalk.message.send）',
      'POST /api/dingtalk/approvals/:id/push（审批卡片推送钉钉）· POST /api/dingtalk/bridge/callback（回决写回，staffId↔identityLinks 反查 fail-closed）',
    ],
    ui: { routes: [], menus: [] },
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
version: ${VERSION}
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
