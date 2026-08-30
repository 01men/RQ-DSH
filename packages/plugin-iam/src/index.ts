/**
 * @dsh-ops/plugin-iam —— 组织账号管理（IAM）。
 *
 * 覆盖方案 §二：组织/账号、三方认证绑定、三方接入配置、角色/用户组。
 * 三方连接器（钉钉/飞书/企微）实现统一 OrgConnector 接口，新增 IM 平台只需新增连接器。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import {
  PlatformEvents, newId, sha256Hex, generateSecret, mask,
  type Collection, type RecordBase,
} from '../../platform-core/src/index.ts'
import * as iamTools from './tools.ts'
import { DingTalkAuthAdapter, RealDingTalkAuthAdapter, type DingTalkCredentials, type IdentityProviderAdapter } from './providers.ts'

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

export interface OrgRecord extends RecordBase {
  name: string
  parentId: string | null
  order: number
  status: 'active' | 'archived'
  customFields: Record<string, string>
  /** 所属租户（多租户最小集，v1.2 第 2 步；缺省 t_default 兜底存量数据）。 */
  tenantId?: string
  /**
   * 组织负责人（NAS 数据权限 P/D/T 角色推导依据，dev-plan-nas-authz §2.1）。
   * 事实源：钉钉连接器同步 dept_manager_userid_list；兼容 customFields['leaderUserIds'] 逗号分隔旧口径。
   * 多负责人全部推导为对应负责人角色（co-leader）；为空时 nasAuthz 发 leaderVacant 告警。
   */
  leaderUserIds?: string[]
}

/** 租户（多租户最小集）：计量/钱包/分账的租户维度载体。 */
export interface TenantRecord extends RecordBase {
  name: string
  status: 'active' | 'suspended'
  /** 套餐档位（后续计费档位扩展位，schema v1 已含 tenant 维度）。 */
  plan: 'trial' | 'standard' | 'enterprise'
}

export const DEFAULT_TENANT_ID = 't_default'

export type UserStatus = 'pending' | 'active' | 'frozen' | 'deactivated'

export interface ThirdPartyBinding {
  provider: 'dingtalk' | 'feishu' | 'wecom'
  unionId: string
  displayName: string
  boundAt: string
  /** 主体企业 corpId（多主体隔离维度；缺省/空串视为同一旧主体）。 */
  corpId?: string
}

export interface UserRecord extends RecordBase {
  username: string
  displayName: string
  email: string
  phone: string
  orgId: string
  title: string
  status: UserStatus
  roleIds: string[]
  passwordSalt: string
  passwordHash: string
  bindings: ThirdPartyBinding[]
  jobNumber?: string
  lastLoginAt?: string
  frozenReason?: string
  /**
   * 账号类型（NAS 数据权限特殊账号规则，dev-plan-nas-authz §2.1）：
   * internal=正式员工（缺省）；external=外部顾问/合作方（白名单目录只读）；
   * suspended-review=可疑标记（全 deny + 审计转人工复核）。
   */
  accountType?: 'internal' | 'external' | 'suspended-review'
  /**
   * 主归属组织（跨部门兼任语义，dev-plan-nas-authz §2.1）：缺省取组织链最深者。
   * orgId ≠ primaryOrgId 时，orgId 组织子树仅授只读（兼任只读，避免双写冲突）。
   */
  primaryOrgId?: string
}

export interface RoleRecord extends RecordBase {
  code: string
  name: string
  builtin: boolean
  description: string
  /** '*' 表示全部权限点。 */
  permissions: string[]
}

export interface UserGroupRule {
  orgIds?: string[]
  title?: string
}

export interface UserGroupRecord extends RecordBase {
  name: string
  type: 'static' | 'dynamic'
  rule?: UserGroupRule
  memberIds: string[]
  description: string
  /**
   * 是否为 NAS 数据权限 C 角色关联的动态用户组（dev-plan-nas-authz §2.2）。
   * 由 nasAuthz 规则导入/更新时回写标记；重算漂移时无论幅度大小都发 cGroupDrift 告警。
   */
  authzRoleC?: boolean
  /** 成员重算漂移告警阈值（人数，缺省 5；仅对未标记 authzRoleC 的组生效）。 */
  driftAlertThreshold?: number
}

export interface ConnectorConfigRecord extends RecordBase {
  id: string
  provider: 'dingtalk' | 'feishu' | 'wecom'
  /** 主体名称（多主体展示维度；缺省 `${provider}-${corpId}`）。 */
  name: string
  enabled: boolean
  corpId: string
  appKey: string
  secretMasked: string
  secretActual?: string
  syncOrgRoot: string
  intervalMinutes: number
  callbackUrl: string
  loginEnabled: boolean
  conflictStrategy: 'third_party_wins' | 'platform_wins' | 'manual'
  /** real=真实 OpenAPI；mock=演示降级（显式标注）。 */
  mode: 'real' | 'mock'
  /** OpenAPI 基址覆盖（测试/专有部署指向本地）。 */
  apiBase?: string
  /** 通讯录 topapi 基址覆盖（默认 https://oapi.dingtalk.com）。 */
  oapiBase?: string
  /** 同步树挂载的目标组织 ID（空=平台根；多主体各自挂到自己的根组织）。 */
  targetOrgId?: string
  lastSyncAt?: string
  lastSyncResult?: { ok: boolean; created: number; updated: number; conflicts: number; frozen: number; message: string }
}

/**
 * 三方身份链接（融合 auth-identity 的 user_identity_links 设计）。
 * 活跃链接在 (provider, corpId, providerUserId) 上引擎级唯一——「一人一号」按主体隔离，
 * 由唯一约束兜底，禁止以「先查后插」替代约束（红线）。解绑即物理删除记录（等价 WHERE unlinked_at IS NULL 的部分唯一索引）。
 */
export interface IdentityLinkRecord extends RecordBase {
  provider: 'dingtalk' | 'feishu' | 'wecom'
  providerUserId: string
  corpId: string
  userId: string
  displayName: string
  linkedAt: string
  linkedBy: string
}

export interface SyncConflictRecord extends RecordBase {
  provider: string
  kind: 'user_attr' | 'user_new' | 'user_left' | 'org_change'
  thirdPartyData: Record<string, unknown>
  platformData: Record<string, unknown>
  status: 'pending' | 'resolved'
  resolution?: string
  resolvedBy?: string
  resolvedAt?: string
}

/** 动态用户组成员快照（C 组漂移可观测，dev-plan-nas-authz §2.2）。 */
export interface GroupSnapshotRecord extends RecordBase {
  groupId: string
  memberIds: string[]
  computedAt: string
}

/** 组成员漂移告警默认阈值（人数）。 */
export const DEFAULT_GROUP_DRIFT_THRESHOLD = 5

// ---------------------------------------------------------------------------
// 权限点目录
// ---------------------------------------------------------------------------

export const PermissionCatalog: Array<{ point: string; label: string; group: string }> = [
  { point: 'console.login', label: '登录控制台', group: '基础' },
  { point: 'iam.org.read', label: '查看组织', group: '组织账号' },
  { point: 'iam.org.write', label: '管理组织', group: '组织账号' },
  { point: 'iam.user.read', label: '查看账号', group: '组织账号' },
  { point: 'iam.user.write', label: '管理账号', group: '组织账号' },
  { point: 'iam.user.freeze', label: '冻结/注销账号', group: '组织账号' },
  { point: 'iam.role.write', label: '管理角色', group: '组织账号' },
  { point: 'iam.connector.write', label: '管理三方接入', group: '组织账号' },
  { point: 'authn.principal.read', label: '查看身份/凭证', group: '统一认证' },
  { point: 'authn.principal.write', label: '管理机器凭证', group: '统一认证' },
  { point: 'authn.token.issue', label: '签发令牌', group: '统一认证' },
  { point: 'authn.token.revoke', label: '吊销令牌', group: '统一认证' },
  { point: 'authn.oidc.read', label: '查看 OIDC 客户端', group: '统一认证' },
  { point: 'authn.oidc.write', label: '管理 OIDC 客户端（签发/轮换/禁用）', group: '统一认证' },
  { point: 'mcp.service.read', label: '查看 MCP 服务', group: 'MCP' },
  { point: 'mcp.service.write', label: '管理 MCP 服务', group: 'MCP' },
  { point: 'mcp.service.deploy', label: '部署/灰度 MCP', group: 'MCP' },
  { point: 'mcp.service.offline', label: '下线 MCP', group: 'MCP' },
  { point: 'mcp.permgroup.write', label: '管理 MCP 权限组', group: 'MCP' },
  { point: 'mcp.invoke', label: '调用 MCP 网关', group: 'MCP' },
  // 连接器纳管（SaaS 数据面网关；invoke 独立权限点对齐 mcp.invoke 先例）
  { point: 'connector.gateway.write', label: '配置连接器网关与健康操作', group: '连接器' },
  { point: 'connector.catalog.read', label: '浏览连接器目录', group: '连接器' },
  { point: 'connector.connection.read', label: '查看连接器连接（org 内）', group: '连接器' },
  { point: 'connector.connection.write', label: '创建/删除连接器连接（含 OAuth 发起）', group: '连接器' },
  { point: 'connector.invoke', label: '调用连接器 action', group: '连接器' },
  { point: 'connector.permgroup.write', label: '管理连接器权限组', group: '连接器' },
  { point: 'connector.runs.read', label: '查看连接器运行日志/对账视图', group: '连接器' },
  { point: 'connector.market.publish', label: '上架连接器型插件（M3，业务触发启动）', group: '连接器' },
  { point: 'skill.read', label: '浏览 Skill 市场', group: 'Skill 市场' },
  { point: 'skill.submit', label: '提交 Skill', group: 'Skill 市场' },
  { point: 'skill.approve', label: '审批 Skill', group: 'Skill 市场' },
  { point: 'skill.publish', label: '上架/下架 Skill', group: 'Skill 市场' },
  { point: 'skill.install', label: '安装 Skill', group: 'Skill 市场' },
  { point: 'skill.storage.write', label: '配置 Skill 包存储后端（本地/NAS）', group: 'Skill 市场' },
  { point: 'nas.read', label: '查看 NAS 存储', group: 'NAS 存储' },
  { point: 'nas.write', label: '管理 NAS 存储（纳管/上线/文件读写）', group: 'NAS 存储' },
  // NAS 数据权限（dev-plan-nas-authz §2.3）：check 供网关/hermes 专用资源账号调用，read/write 供规则管理
  { point: 'nas.authz.check', label: 'NAS 数据权限判定（check/scope）', group: 'NAS 存储' },
  { point: 'nas.authz.read', label: '查看 NAS 数据权限规则与判定留痕', group: 'NAS 存储' },
  { point: 'nas.authz.write', label: '管理 NAS 数据权限规则/例外（含破窗 override）', group: 'NAS 存储' },
  { point: 'agent.read', label: '查看 Agent', group: 'Agent 本体' },
  { point: 'agent.write', label: '管理 Agent', group: 'Agent 本体' },
  { point: 'agent.approve', label: '审批 Agent 上线', group: 'Agent 本体' },
  { point: 'agent.offline', label: '下线 Agent', group: 'Agent 本体' },
  { point: 'app.read', label: '查看 AI 应用', group: 'AI 应用' },
  { point: 'app.write', label: '管理 AI 应用', group: 'AI 应用' },
  { point: 'app.offline', label: '下线 AI 应用', group: 'AI 应用' },
  { point: 'audit.read', label: '查看审计日志', group: '审计' },
  { point: 'audit.rule.write', label: '管理告警规则', group: '审计' },
  { point: 'approval.read', label: '查看审批中心', group: '审批' },
  { point: 'approval.decide', label: '审批决策', group: '审批' },
  { point: 'usage.read', label: '查看计量流水', group: '计量计费' },
  { point: 'usage.write', label: '登记计量事件', group: '计量计费' },
  { point: 'usage.admin', label: '管理价格簿/对账/能力授权', group: '计量计费' },
  { point: 'billing.read', label: '查看钱包/流水/分账', group: '计量计费' },
  { point: 'billing.write', label: '充值/预算管理', group: '计量计费' },
  { point: 'billing.admin', label: '账期结转/冲正', group: '计量计费' },
  { point: 'modelgw.read', label: '查看模型网关', group: '模型转售' },
  { point: 'modelgw.invoke', label: '调用模型网关', group: '模型转售' },
  { point: 'modelgw.admin', label: '管理模型目录', group: '模型转售' },
  { point: 'market.read', label: '浏览插件市场', group: '插件市场' },
  { point: 'market.submit', label: '提交插件', group: '插件市场' },
  { point: 'market.approve', label: '审批插件', group: '插件市场' },
  { point: 'market.install', label: '安装插件', group: '插件市场' },
  { point: 'market.developer', label: '开发者门户', group: '插件市场' },
  { point: 'connect.manage', label: '管理平台接入（接入码/远程客户端）', group: '平台接入' },
  { point: 'platform.update.read', label: '查看/触发平台更新检查', group: '平台维护' },
  { point: 'platform.update.apply', label: '执行平台升级（git pull + npm install）', group: '平台维护' },
]

export const BuiltinRoles: Array<Omit<RoleRecord, 'id' | 'createdAt' | 'updatedAt'>> = [
  { code: 'super_admin', name: '平台超级管理员', builtin: true, description: '拥有全部权限点', permissions: ['*'] },
  { code: 'org_admin', name: '组织管理员', builtin: true, description: '管理本组织账号与用户组', permissions: ['console.login', 'iam.*', 'approval.read'] },
  { code: 'resource_admin', name: '资源管理员', builtin: true, description: '管理 MCP/Skill/Agent/应用/NAS/连接器资源', permissions: ['console.login', 'mcp.*', 'skill.*', 'agent.*', 'app.*', 'nas.*', 'authn.oidc.*', 'connector.*', 'approval.read'] },
  { code: 'developer', name: '开发者', builtin: true, description: '提交与调试资源（应用限自身 owner 范围，服务端校验）', permissions: ['console.login', 'iam.user.read', 'iam.org.read', 'mcp.service.read', 'mcp.invoke', 'skill.read', 'skill.submit', 'skill.install', 'agent.read', 'agent.write', 'app.read', 'app.write', 'nas.read', 'connector.catalog.read', 'connector.connection.read', 'connector.invoke'] },
  { code: 'member', name: '普通用户', builtin: true, description: '浏览市场与可用资源', permissions: ['console.login', 'skill.read', 'agent.read', 'app.read'] },
  { code: 'auditor', name: '审计员（只读）', builtin: true, description: '全平台只读审计', permissions: ['console.login', 'iam.org.read', 'iam.user.read', 'authn.principal.read', 'authn.oidc.read', 'mcp.service.read', 'skill.read', 'agent.read', 'app.read', 'nas.read', 'audit.read', 'approval.read', 'connector.runs.read', 'connector.connection.read'] },
]

/**
 * 内置角色的一次性幂等权限迁移：ensureBuiltinRoles 只插不更新——生产已落库角色不会自动
 * 获得后续版本新增的权限点。迁移只做「缺则补」，不触碰用户自定义角色；每次启动都会
 * 重新比对（幂等），历史标记（connector-permissions-v1）仅作观测。
 */
export const BUILTIN_ROLE_MIGRATION: Record<string, string[]> = {
  resource_admin: ['connector.gateway.write', 'connector.catalog.read', 'connector.connection.read', 'connector.connection.write', 'connector.invoke', 'connector.permgroup.write', 'connector.runs.read'],
  // developer 补 agent.write：与 app.write 对称——开发者应能注册/提报更新 Agent（2026-08 修复"总是报没有 agent.write 权限"）
  developer: ['connector.catalog.read', 'connector.connection.read', 'connector.invoke', 'agent.write'],
  // auditor 补 nas.authz.read：审计员可查看 NAS 数据权限规则与判定留痕（dev-plan-nas-authz §2.3）
  auditor: ['connector.runs.read', 'connector.connection.read', 'nas.authz.read'],
}

/** 兼容别名：迁移通道创建时的历史命名（仅 connector 批次）。 */
export const CONNECTOR_ROLE_MIGRATION = BUILTIN_ROLE_MIGRATION

// ---------------------------------------------------------------------------
// 三方连接器接口
// ---------------------------------------------------------------------------

export interface RemoteDirectory {
  orgs: Array<{ remoteId: string; name: string; parentRemoteId: string | null; /** 部门负责人三方 userId 列表（钉钉 dept_manager_userid_list），nasAuthz 角色推导依据。 */ managerRemoteIds?: string[] }>
  users: Array<{
    remoteId: string
    /** 钉钉 userid（staffId）：hermes X-On-Behalf-User 身份头与 dept_manager_userid_list 的口径；与 remoteId(unionId) 并存为两条 identityLinks。 */
    remoteUserId?: string
    name: string
    jobNumber: string
    title: string
    orgRemoteId: string
    /** 一人多部门：orgRemoteId 为主归属（钉钉目录首个命中），其余部门记兼任挂靠（引擎 orgId 子树兼任只读）。 */
    extraOrgRemoteIds?: string[]
    email: string
    active: boolean
  }>
}

export interface OrgConnector {
  provider: string
  label: string
  fetchDirectory(): Promise<RemoteDirectory>
  healthCheck(): Promise<{ ok: boolean; latencyMs: number; message: string; mock?: boolean }>
}

/** 钉钉连接器（演示环境内置模拟目录服务，接口与真实 OpenAPI 对齐）。 */
export class DingTalkConnector implements OrgConnector {
  provider = 'dingtalk'
  label = '钉钉'

  private directory: RemoteDirectory = {
    orgs: [
      { remoteId: 'dd_root', name: '元冰可集团', parentRemoteId: null, managerRemoteIds: ['staff_001'] },
      { remoteId: 'dd_tech', name: '技术中心', parentRemoteId: 'dd_root', managerRemoteIds: ['staff_001'] },
      { remoteId: 'dd_ai', name: 'AI 平台部', parentRemoteId: 'dd_tech', managerRemoteIds: ['staff_002'] },
      { remoteId: 'dd_be', name: '后端部', parentRemoteId: 'dd_tech', managerRemoteIds: ['staff_004'] },
      { remoteId: 'dd_fe', name: '前端部', parentRemoteId: 'dd_tech', managerRemoteIds: ['staff_005'] },
      { remoteId: 'dd_prod', name: '产品运营部', parentRemoteId: 'dd_root', managerRemoteIds: ['staff_006'] },
      { remoteId: 'dd_mkt', name: '市场部', parentRemoteId: 'dd_root', managerRemoteIds: ['staff_008'] },
    ],
    users: [
      { remoteId: 'dd_u001', remoteUserId: 'staff_001', name: '陈远舟', jobNumber: 'DD0001', title: '技术总监', orgRemoteId: 'dd_tech', email: 'chenyz@yuanbingke.com', active: true },
      { remoteId: 'dd_u002', remoteUserId: 'staff_002', name: '林小满', jobNumber: 'DD0002', title: '算法工程师', orgRemoteId: 'dd_ai', email: 'linxm@yuanbingke.com', active: true },
      { remoteId: 'dd_u003', remoteUserId: 'staff_003', name: '周既白', jobNumber: 'DD0003', title: '算法工程师', orgRemoteId: 'dd_ai', email: 'zhoujb@yuanbingke.com', active: true },
      { remoteId: 'dd_u004', remoteUserId: 'staff_004', name: '苏砚秋', jobNumber: 'DD0004', title: '后端工程师', orgRemoteId: 'dd_be', email: 'suyq@yuanbingke.com', active: true },
      { remoteId: 'dd_u005', remoteUserId: 'staff_005', name: '何青梧', jobNumber: 'DD0005', title: '前端工程师', orgRemoteId: 'dd_fe', email: 'heqw@yuanbingke.com', active: true },
      { remoteId: 'dd_u006', remoteUserId: 'staff_006', name: '顾星阑', jobNumber: 'DD0006', title: '产品经理', orgRemoteId: 'dd_prod', email: 'guxl@yuanbingke.com', active: true },
      { remoteId: 'dd_u007', remoteUserId: 'staff_007', name: '叶栖迟', jobNumber: 'DD0007', title: '运营专员', orgRemoteId: 'dd_prod', email: 'yqz@yuanbingke.com', active: true },
      { remoteId: 'dd_u008', remoteUserId: 'staff_008', name: '孟疏桐', jobNumber: 'DD0008', title: '市场专员', orgRemoteId: 'dd_mkt', email: 'mst@yuanbingke.com', active: true },
      { remoteId: 'dd_u009', remoteUserId: 'staff_009', name: '周明澜', jobNumber: 'DD0009', title: '前端工程师', orgRemoteId: 'dd_fe', extraOrgRemoteIds: ['dd_be'], email: 'zhml@yuanbingke.com', active: true },
      { remoteId: 'dd_u010', remoteUserId: 'staff_010', name: '姜叙白', jobNumber: 'DD0010', title: '数据工程师', orgRemoteId: 'dd_be', email: 'jxb@yuanbingke.com', active: false },
    ],
  }

  async fetchDirectory(): Promise<RemoteDirectory> {
    await delay(120 + Math.floor(Math.random() * 80))
    return structuredClone(this.directory)
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; message: string; mock?: boolean }> {
    const started = Date.now()
    await delay(40)
    return { ok: true, latencyMs: Date.now() - started, message: '降级模式：未配置钉钉企业凭证，使用内置演示目录', mock: true }
  }
}

/**
 * 钉钉连接器（真实 OpenAPI）：通讯录分页拉取，目录映射到 RemoteDirectory。
 * 链路：企业内部应用 accessToken（POST api.dingtalk.com/v1.0/oauth2/accessToken）
 *   → 部门树（oapi topapi/v2/department/listsubid + department/get，自根 BFS）
 *   → 部门成员（oapi topapi/v2/user/list 分页）。
 * 接口失败（HTTP 非 2xx 或 errcode != 0）一律抛出带 errmsg 的错误——
 * 历史教训：静默返回空目录会让同步「成功」但 0 条数据，故障无法察觉。
 */
export class RealDingTalkConnector implements OrgConnector {
  provider = 'dingtalk'
  label = '钉钉'
  private corpTokenCache: { token: string; expiresAt: number } | undefined
  private readonly credentials: DingTalkCredentials
  /** 同步根部门 ID（缺省 1=企业根）。 */
  private readonly syncOrgRoot: string

  constructor(credentials: DingTalkCredentials, options: { syncOrgRoot?: string } = {}) {
    this.credentials = credentials
    this.syncOrgRoot = options.syncOrgRoot?.trim() || '1'
  }

  private get apiBase(): string {
    return this.credentials.apiBase ?? 'https://api.dingtalk.com'
  }

  private get oapiBase(): string {
    return this.credentials.oapiBase ?? 'https://oapi.dingtalk.com'
  }

  private async corpAccessToken(): Promise<string> {
    if (this.corpTokenCache && this.corpTokenCache.expiresAt > Date.now() + 60_000) {
      return this.corpTokenCache.token
    }
    const response = await fetch(`${this.apiBase}/v1.0/oauth2/accessToken`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appKey: this.credentials.appKey, appSecret: this.credentials.appSecret }),
    })
    const payload = (await response.json().catch(() => ({}))) as { accessToken?: string; expireIn?: number }
    if (!response.ok || !payload.accessToken) {
      throw new Error(`钉钉企业 accessToken 获取失败（HTTP ${response.status}）`)
    }
    this.corpTokenCache = { token: payload.accessToken, expiresAt: Date.now() + (payload.expireIn ?? 7200) * 1000 }
    return payload.accessToken
  }

  /** 调 oapi topapi：access_token 走 query；errcode != 0 即抛错（不静默吞错）。 */
  private async topapi<T>(path: string, body: Record<string, unknown>): Promise<T & { errcode?: number; errmsg?: string }> {
    const token = await this.corpAccessToken()
    const response = await fetch(`${this.oapiBase}${path}?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const payload = (await response.json().catch(() => ({}))) as T & { errcode?: number; errmsg?: string }
    if (!response.ok || (payload.errcode ?? 0) !== 0) {
      throw new Error(`钉钉接口 ${path} 调用失败（HTTP ${response.status}，errcode ${payload.errcode ?? '-'}：${payload.errmsg ?? '无错误信息'}）`)
    }
    return payload
  }

  async fetchDirectory(): Promise<RemoteDirectory> {
    const rootId = this.syncOrgRoot
    const rootInfo = await this.getDepartment(rootId)
    const orgs: RemoteDirectory['orgs'] = [{ remoteId: rootId, name: rootInfo.name, parentRemoteId: null, ...(rootInfo.managerRemoteIds ? { managerRemoteIds: rootInfo.managerRemoteIds } : {}) }]
    const users: RemoteDirectory['users'] = []
    // 自根部门 BFS（上限 3 层 / 每层 50 部门，防御异常目录）
    let frontier = [rootId]
    for (let depth = 0; depth < 3 && frontier.length > 0; depth++) {
      const next: string[] = []
      for (const deptId of frontier.slice(0, 50)) {
        for (const childId of await this.listSubDepartmentIds(deptId)) {
          const child = await this.getDepartment(childId)
          orgs.push({ remoteId: childId, name: child.name, parentRemoteId: deptId, ...(child.managerRemoteIds ? { managerRemoteIds: child.managerRemoteIds } : {}) })
          next.push(childId)
        }
      }
      frontier = next
    }
    for (const org of orgs) {
      const members = await this.listUsers(org.remoteId)
      for (const member of members) {
        const existing = users.find((user) => user.remoteId === member.remoteId)
        if (existing) {
          // 一人多部门（兼任语义数据源）：首个部门为主归属（orgRemoteId），其余部门记入 extraOrgRemoteIds
          if (existing.orgRemoteId !== org.remoteId && !(existing.extraOrgRemoteIds ?? []).includes(org.remoteId)) {
            existing.extraOrgRemoteIds = [...(existing.extraOrgRemoteIds ?? []), org.remoteId]
          }
          continue
        }
        users.push({ ...member, orgRemoteId: org.remoteId })
      }
    }
    return { orgs, users }
  }

  /** 部门详情（取名 + 负责人列表；根部门 dept_id=1 返回企业名）。 */
  private async getDepartment(deptId: string): Promise<{ name: string; managerRemoteIds?: string[] }> {
    const payload = await this.topapi<{ result?: { name?: string; dept_manager_userid_list?: string[] } }>('/topapi/v2/department/get', { dept_id: Number(deptId) })
    const managerRemoteIds = (payload.result?.dept_manager_userid_list ?? []).filter((id) => Boolean(id))
    return { name: payload.result?.name ?? `部门 ${deptId}`, ...(managerRemoteIds.length > 0 ? { managerRemoteIds } : {}) }
  }

  /** 下一级子部门 ID 列表（不受授权范围限制）。 */
  private async listSubDepartmentIds(deptId: string): Promise<string[]> {
    const payload = await this.topapi<{ result?: { dept_id_list?: number[] } }>('/topapi/v2/department/listsubid', { dept_id: Number(deptId) })
    return (payload.result?.dept_id_list ?? []).map(String)
  }

  private async listUsers(deptId: string): Promise<RemoteDirectory['users']> {
    const users: RemoteDirectory['users'] = []
    let cursor = 0
    for (let page = 0; page < 10; page++) {
      const payload = await this.topapi<{
        result?: {
          has_more?: boolean
          next_cursor?: number
          list?: Array<{ unionid?: string; userid?: string; name?: string; job_number?: string; title?: string; email?: string; org_email?: string; active?: boolean }>
        }
      }>('/topapi/v2/user/list', { dept_id: Number(deptId), cursor, size: 100 })
      const result = payload.result ?? {}
      for (const item of result.list ?? []) {
        const remoteId = item.unionid ?? item.userid
        if (!remoteId) continue
        users.push({
          remoteId,
          ...(item.userid && item.userid !== remoteId ? { remoteUserId: item.userid } : {}),
          name: item.name ?? remoteId,
          jobNumber: item.job_number || remoteId,
          title: item.title ?? '',
          orgRemoteId: deptId,
          email: item.email || item.org_email || '',
          active: item.active ?? true,
        })
      }
      if (!result.has_more) break
      cursor = Number(result.next_cursor ?? cursor + 100)
    }
    return users
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; message: string; mock?: boolean }> {
    const started = Date.now()
    try {
      await this.corpAccessToken()
      return { ok: true, latencyMs: Date.now() - started, message: '钉钉 OpenAPI 连通正常（真实模式）', mock: false }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, latencyMs: Date.now() - started, message, mock: false }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class IamService extends Service {
  static readonly provide = 'iam'

  /**
   * 内置连接器实现范围（applyConnectorMode 能直接实例化的 provider）。
   * 配置保存以「可实现」为准放行，而非「当前已注册」——否则生产基线（无 DEMO_SEED、
   * 注册表为空）首次保存钉钉凭证会被守卫拦死，形成「先有配置才能注册、先注册才能存配置」死锁。
   */
  private static readonly BUILTIN_CONNECTOR_PROVIDERS: ReadonlySet<string> = new Set(['dingtalk'])

  /** 运行时注册表：key 为配置实例 ID（DEMO_SEED 内置 mock 用 'demo:dingtalk'），provider 仅表示平台类型。 */
  private connectors = new Map<string, OrgConnector>()
  private authProviders = new Map<string, IdentityProviderAdapter>()

  constructor(ctx: Context) {
    super(ctx, 'iam')
    // 默认不注册任何三方身份源：生产基线三方登录入口自动隐藏（未配置连接器时 sso 不可用）。
    // mock 钉钉 IdP 仅在显式 DEMO_SEED=1 演示环境下注册，避免生产基线暴露演示身份/匿名注册入口。
    if (process.env.DEMO_SEED === '1') {
      this.registerConnector('demo:dingtalk', new DingTalkConnector())
      this.registerAuthProvider('demo:dingtalk', new DingTalkAuthAdapter())
    }
    this.ensureDefaultTenant()
    // 连接器/身份源注册表仅存内存：重启后须按持久化配置重建，否则 real 模式的
    // Real*Adapter 不会恢复（扫码登录/同步将报「未注册」）。多主体：按配置实例 id 逐条恢复。
    for (const config of this.connectorConfigs().all()) {
      this.applyConnectorMode(config.id)
    }
  }

  /** 注册连接器实例：key 为配置实例 id（多主体各自独立注册/注销）。 */
  registerConnector(key: string, connector: OrgConnector): () => void {
    this.connectors.set(key, connector)
    return () => this.connectors.delete(key)
  }

  /** 注册身份源 Adapter 实例：登录主流程面向接口编程，新增平台零侵入。 */
  registerAuthProvider(key: string, adapter: IdentityProviderAdapter): () => void {
    this.authProviders.set(key, adapter)
    return () => this.authProviders.delete(key)
  }

  /**
   * 按平台类型取身份源（旧调用兼容；多主体请用 getAuthProviderByConfig）。
   * 优先配置实例注册的身份源（按配置创建顺序取第一）；`demo:` 前缀的 DEMO_SEED 引导注册
   * 仅作「尚无配置」窗口的兜底——否则演示实例长期占据首位，会遮蔽配置切换后的真实/新 mock 实例。
   */
  getAuthProvider(type: string): IdentityProviderAdapter {
    let demoFallback: IdentityProviderAdapter | undefined
    for (const [key, adapter] of this.authProviders) {
      if (adapter.type !== type) continue
      if (key.startsWith('demo:')) {
        demoFallback ??= adapter
        continue
      }
      return adapter
    }
    if (demoFallback) return demoFallback
    throw new Error(`未注册的身份源：${type}`)
  }

  /** 按配置实例 id 取身份源（多主体登录/绑定按主体发起）。 */
  getAuthProviderByConfig(configId: string): IdentityProviderAdapter {
    const adapter = this.authProviders.get(configId)
    if (!adapter) throw new Error(`未注册的身份源：${configId}`)
    return adapter
  }

  /** 三方身份链接集合（活跃唯一约束：同一主体下的同一三方身份只能映射一个平台账号）。 */
  identityLinks(): Collection<IdentityLinkRecord> {
    const collection = this.ctx.opsStorage.collection<IdentityLinkRecord>('iam:identityLinks')
    collection.uniqueOn('identity_link_active', (record) => `${record.provider}|${record.corpId}|${record.providerUserId}`)
    return collection
  }

  /**
   * 命中查找：按归一化档案定位已绑定的平台账号。
   * 传 corpId 时精确命中优先；无精确命中回落任意 corp 的同三方身份——钉钉 unionId 跨企业同人，
   * 且兼容单主体部署在 mock/real 间切换（corpId 变化）后的身份连续性。多主体下同身份多链接时精确匹配生效。
   */
  findLinkByProfile(provider: string, providerUserId: string, corpId?: string): IdentityLinkRecord | undefined {
    const links = this.identityLinks().find((link) => link.provider === provider && link.providerUserId === providerUserId)
    if (corpId === undefined) return links[0]
    return links.find((link) => link.corpId === corpId) ?? links[0]
  }

  /** 建立身份链接（唯一约束兜底；user.bindings 保持为投影，便于列表展示）。 */
  linkIdentity(userId: string, profile: { provider: IdentityLinkRecord['provider']; providerUserId: string; corpId: string; displayName: string }, actor: string): IdentityLinkRecord {
    const user = this.users().get(userId)
    if (!user) throw new Error(`账号不存在：${userId}`)
    const link = this.identityLinks().insert({
      id: newId('idl'),
      provider: profile.provider,
      providerUserId: profile.providerUserId,
      corpId: profile.corpId,
      userId,
      displayName: profile.displayName,
      linkedAt: new Date().toISOString(),
      linkedBy: actor,
    })
    // 投影同步（bindings 仅作展示，事实源是 identityLinks；多主体按 provider+corpId 判重）
    if (!user.bindings.some((item) => item.provider === profile.provider && (item.corpId ?? '') === profile.corpId)) {
      this.users().update(userId, {
        bindings: [...user.bindings, {
          provider: profile.provider,
          unionId: profile.providerUserId,
          displayName: profile.displayName,
          boundAt: link.linkedAt,
          ...(profile.corpId ? { corpId: profile.corpId } : {}),
        }],
      })
    }
    return link
  }

  /** 解除身份链接（同时清理投影）。 */
  unlinkIdentity(userId: string, provider: IdentityLinkRecord['provider']): boolean {
    const link = this.identityLinks().findOne((item) => item.userId === userId && item.provider === provider)
    if (!link) return false
    this.identityLinks().remove(link.id)
    const user = this.users().get(userId)
    if (user) {
      this.users().update(userId, { bindings: user.bindings.filter((item) => item.provider !== provider) })
    }
    return true
  }

  /** 已注册连接器实例清单（多主体：携带 configId/主体名，provider 仅表示平台类型）。 */
  connectorProviders(): Array<{ configId: string; provider: string; label: string; name?: string }> {
    return [...this.connectors.entries()].map(([configId, connector]) => {
      const name = this.connectorConfigById(configId)?.name
      return { configId, provider: connector.provider, label: connector.label, ...(name !== undefined ? { name } : {}) }
    })
  }

  // -- 集合 ---------------------------------------------------------------

  orgs(): Collection<OrgRecord> {
    const collection = this.ctx.opsStorage.collection<OrgRecord>('iam:orgs')
    // 同级同名唯一按连接器分区：手工/历史组织（无 connectorId）维持旧口径，
    // 不同主体同步下来的同名部门（两家企业很可能同名）各自落库不撞键。
    collection.uniqueOn('org_same_level_name', (org) => `${String(org.customFields['connectorId'] ?? '')}|${org.parentId ?? '-'}|${org.name}`)
    return collection
  }

  users(): Collection<UserRecord> {
    const collection = this.ctx.opsStorage.collection<UserRecord>('iam:users')
    collection.uniqueOn('user_username', (user) => user.username)
    return collection
  }

  roles(): Collection<RoleRecord> {
    return this.ctx.opsStorage.collection<RoleRecord>('iam:roles')
  }

  groups(): Collection<UserGroupRecord> {
    return this.ctx.opsStorage.collection<UserGroupRecord>('iam:groups')
  }

  connectorConfigs(): Collection<ConnectorConfigRecord> {
    const collection = this.ctx.opsStorage.collection<ConnectorConfigRecord>('iam:connectors')
    // 多主体：同一 provider 可接入多家企业，但 provider|corpId 引擎级唯一（重复主体拒绝）
    collection.uniqueOn('connector_provider_corp', (config) => `${config.provider}|${config.corpId}`)
    return collection
  }

  conflicts(): Collection<SyncConflictRecord> {
    return this.ctx.opsStorage.collection<SyncConflictRecord>('iam:conflicts')
  }

  tenants(): Collection<TenantRecord> {
    const collection = this.ctx.opsStorage.collection<TenantRecord>('iam:tenants')
    collection.uniqueOn('tenant_name', (tenant) => tenant.name)
    return collection
  }

  /** 多租户最小集：默认租户兜底（存量数据全部落 t_default）。 */
  ensureDefaultTenant(): TenantRecord {
    const existing = this.tenants().get(DEFAULT_TENANT_ID)
    if (existing) return existing
    return this.tenants().insert({
      id: DEFAULT_TENANT_ID,
      name: '默认租户',
      status: 'active',
      plan: 'standard',
    })
  }

  createTenant(input: { name: string; plan?: TenantRecord['plan'] }): TenantRecord {
    if (!input.name?.trim()) throw new Error('租户名称不能为空')
    if (this.tenants().findOne((tenant) => tenant.name === input.name)) throw new Error(`租户已存在：${input.name}`)
    return this.tenants().insert({
      id: newId('t'),
      name: input.name,
      status: 'active',
      plan: input.plan ?? 'trial',
    })
  }

  /** 租户解析：org → tenant；缺省 t_default（usage/钱包/分账统一入口）。 */
  tenantOfOrg(orgId: string): string {
    return this.orgs().get(orgId)?.tenantId ?? DEFAULT_TENANT_ID
  }

  // -- 组织 ---------------------------------------------------------------

  orgTree(): OrgTreeNode[] {
    const nodes = new Map<string, OrgTreeNode>()
    for (const org of this.orgs().all()) {
      nodes.set(org.id, { ...org, children: [] })
    }
    const roots: OrgTreeNode[] = []
    for (const node of nodes.values()) {
      if (node.parentId && nodes.has(node.parentId)) {
        nodes.get(node.parentId)!.children.push(node)
      } else {
        roots.push(node)
      }
    }
    const sortRec = (list: OrgTreeNode[]): OrgTreeNode[] => {
      list.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'zh'))
      for (const item of list) sortRec(item.children)
      return list
    }
    return sortRec(roots)
  }

  createOrg(input: { name: string; parentId?: string | null; order?: number; customFields?: Record<string, string>; tenantId?: string; leaderUserIds?: string[] }): OrgRecord {
    if (!input.name?.trim()) throw new Error('组织名称不能为空')
    const parentId = input.parentId ?? null
    if (parentId && !this.orgs().get(parentId)) throw new Error(`父组织不存在：${parentId}`)
    // 同级同名判重与引擎唯一键同口径：按连接器归属分区（无 connectorId 的手工组织一个分区）。
    const ownerKey = input.customFields?.['connectorId'] ?? ''
    const duplicate = this.orgs().findOne((org) => org.name === input.name && org.parentId === parentId
      && (org.customFields['connectorId'] ?? '') === ownerKey)
    if (duplicate) throw new Error(`同级下已存在同名组织「${input.name}」`)
    const record = this.orgs().insert({
      id: newId('org'),
      name: input.name.trim(),
      parentId,
      order: input.order ?? this.orgs().count() + 1,
      status: 'active',
      customFields: input.customFields ?? {},
      ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
      ...(input.leaderUserIds !== undefined ? { leaderUserIds: input.leaderUserIds } : {}),
    })
    this.ctx.platformBus.emit(PlatformEvents.OrgChanged, { kind: 'create', orgId: record.id, name: record.name })
    return record
  }

  /** 维护组织负责人（控制台补录 / leaderVacant 告警后的处置入口）。传空数组即清空。 */
  setOrgLeaders(id: string, leaderUserIds: string[]): OrgRecord {
    this.requireOrg(id)
    for (const userId of leaderUserIds) {
      if (!this.users().get(userId)) throw new Error(`负责人账号不存在：${userId}`)
    }
    return this.orgs().update(id, { leaderUserIds: [...new Set(leaderUserIds)] })
  }

  /** 兼容读取：负责人历史口径 customFields['leaderUserIds']（逗号分隔），结构化字段优先。 */
  leadersOf(orgId: string): string[] {
    const org = this.orgs().get(orgId)
    if (!org) return []
    if (Array.isArray(org.leaderUserIds)) return org.leaderUserIds
    const legacy = String(org.customFields?.['leaderUserIds'] ?? '').trim()
    return legacy ? legacy.split(',').map((item) => item.trim()).filter(Boolean) : []
  }

  renameOrg(id: string, name: string): OrgRecord {
    const org = this.requireOrg(id)
    if (!name?.trim()) throw new Error('组织名称不能为空')
    const trimmed = name.trim()
    // 判重口径同 createOrg：只在同一连接器归属分区内拒绝同名。
    const duplicate = this.orgs().findOne((item) => item.id !== id && item.name === trimmed && item.parentId === org.parentId
      && (item.customFields['connectorId'] ?? '') === (org.customFields['connectorId'] ?? ''))
    if (duplicate) throw new Error(`同级下已存在同名组织「${trimmed}」`)
    const updated = this.orgs().update(id, { name: trimmed })
    this.ctx.platformBus.emit(PlatformEvents.OrgChanged, { kind: 'rename', orgId: id, name: trimmed })
    return updated
  }

  /** 移动组织（拖拽调岗），含环检测。 */
  moveOrg(id: string, newParentId: string | null): OrgRecord {
    this.requireOrg(id)
    if (newParentId) {
      if (newParentId === id) throw new Error('不能将组织移动到自身之下')
      let cursor: string | null = newParentId
      while (cursor) {
        if (cursor === id) throw new Error('不允许形成组织环')
        cursor = this.orgs().get(cursor)?.parentId ?? null
      }
    }
    const updated = this.orgs().update(id, { parentId: newParentId })
    this.ctx.platformBus.emit(PlatformEvents.OrgChanged, { kind: 'move', orgId: id })
    return updated
  }

  /**
   * 删除组织。默认仅允许空组织（无子组织且无直属账号）；
   * cascade=true 一键删除整棵子树：子树内组织全部移除，直接挂载的账号上移到
   * 存活的最近上级组织（被删根的父组织；删除根组织时上移到首个存活根组织）。
   */
  deleteOrg(id: string, options?: { cascade?: boolean }): { deleted: boolean; removedOrgs: number; movedUsers: number; fallbackOrgId?: string } {
    const org = this.requireOrg(id)
    if (!options?.cascade) {
      if (this.orgs().find((item) => item.parentId === id).length > 0) throw new Error('存在子组织，无法删除；请改用「连同子组织一键删除」')
      if (this.users().find((user) => user.orgId === id).length > 0) throw new Error('组织下仍有账号，无法删除；请改用「连同子组织一键删除」（账号将上移到上级组织）')
      this.orgs().remove(id)
      this.ctx.platformBus.emit(PlatformEvents.OrgChanged, { kind: 'delete', orgId: id, name: org.name })
      return { deleted: true, removedOrgs: 1, movedUsers: 0 }
    }
    const subtree = this.orgSubtreeIds(id)
    const subtreeSet = new Set(subtree)
    // 账号落点：被删根的父组织必然不在子树内（树无环）；删根组织时落到首个存活根组织
    const fallbackOrgId = org.parentId ?? this.orgs().find((item) => !subtreeSet.has(item.id) && !item.parentId)[0]?.id ?? null
    const movedUsers = this.users().find((user) => subtreeSet.has(user.orgId))
    if (!fallbackOrgId && movedUsers.length > 0) throw new Error('删除后将没有任何组织可挂载账号，请先把账号迁移到其他组织再删除')
    if (fallbackOrgId) {
      for (const user of movedUsers) this.users().update(user.id, { orgId: fallbackOrgId })
    }
    for (const orgId of subtree) {
      if (this.orgs().get(orgId)) this.orgs().remove(orgId)
    }
    this.ctx.platformBus.emit(PlatformEvents.OrgChanged, {
      kind: 'delete', orgId: id, name: org.name, cascade: true,
      removedOrgs: subtree.length, movedUsers: movedUsers.length,
    })
    return { deleted: true, removedOrgs: subtree.length, movedUsers: movedUsers.length, ...(fallbackOrgId ? { fallbackOrgId } : {}) }
  }

  private requireOrg(id: string): OrgRecord {
    const org = this.orgs().get(id)
    if (!org) throw new Error(`组织不存在：${id}`)
    return org
  }

  /** 组织子树 id 集合（数据权限范围）。 */
  orgSubtreeIds(rootId: string): string[] {
    const result: string[] = [rootId]
    const walk = (parentId: string): void => {
      for (const org of this.orgs().find((item) => item.parentId === parentId)) {
        result.push(org.id)
        walk(org.id)
      }
    }
    walk(rootId)
    return result
  }

  // -- 账号 ---------------------------------------------------------------

  /** 创建账号：未显式指定口令时生成随机初始口令（仅本次调用返回，须安全传达给本人）。 */
  createUser(input: {
    username: string
    displayName: string
    orgId: string
    email?: string
    phone?: string
    title?: string
    roleIds?: string[]
    password?: string
    jobNumber?: string
  }): { user: UserRecord; initialPassword?: string } {
    if (!input.username?.trim()) throw new Error('用户名不能为空')
    if (!/^[a-z0-9_.-]+$/i.test(input.username)) throw new Error('用户名仅支持字母、数字与 _ . -')
    if (this.users().findOne((user) => user.username === input.username)) throw new Error(`用户名已存在：${input.username}`)
    if (!this.orgs().get(input.orgId)) throw new Error(`组织不存在：${input.orgId}`)
    const salt = generateSecret('salt').slice(0, 16)
    const password = input.password ?? generateSecret('init')
    const user = this.users().insert({
      id: newId('usr'),
      username: input.username,
      displayName: input.displayName || input.username,
      email: input.email ?? `${input.username}@yuanbingke.com`,
      phone: input.phone ?? '',
      orgId: input.orgId,
      title: input.title ?? '',
      status: 'pending',
      roleIds: input.roleIds ?? [],
      passwordSalt: salt,
      passwordHash: hashPassword(password, salt),
      bindings: [],
      ...(input.jobNumber !== undefined ? { jobNumber: input.jobNumber } : {}),
    })
    return input.password ? { user } : { user, initialPassword: password }
  }

  /** 重置口令：不传 password 则生成随机初始口令；传入则设置为指定口令（均仅本次返回明文）。 */
  resetPassword(id: string, password?: string): { user: UserRecord; initialPassword: string } {
    const user = this.requireUser(id)
    if (user.status === 'deactivated') throw new Error('账号已注销，无法重置口令')
    if (password !== undefined) {
      if (password.trim().length < 8) throw new Error('口令长度不得少于 8 位')
      if (/[\u4e00-\u9fff]/.test(password)) throw new Error('口令不得包含中文')
    }
    const next = password ?? generateSecret('init')
    const salt = generateSecret('salt').slice(0, 16)
    this.users().update(id, { passwordSalt: salt, passwordHash: hashPassword(next, salt) })
    return { user: this.users().get(id)!, initialPassword: next }
  }

  importUsers(items: Array<{ username: string; displayName: string; orgId: string; title?: string; email?: string }>): { created: UserRecord[]; skipped: string[] } {
    const created: UserRecord[] = []
    const skipped: string[] = []
    for (const item of items) {
      if (this.users().findOne((user) => user.username === item.username)) {
        skipped.push(item.username)
        continue
      }
      created.push(this.createUser(item).user)
    }
    return { created, skipped }
  }

  activateUser(id: string): UserRecord {
    const user = this.requireUser(id)
    if (user.status !== 'pending') throw new Error('仅待激活账号可激活')
    return this.users().update(id, { status: 'active' })
  }

  freezeUser(id: string, reason: string): UserRecord {
    this.requireUser(id)
    if (!reason?.trim()) throw new Error('冻结必须填写原因（审计要求）')
    const updated = this.users().update(id, { status: 'frozen', frozenReason: reason })
    this.ctx.platformBus.emit(PlatformEvents.UserFrozen, { userId: id, username: updated.username, reason })
    return updated
  }

  unfreezeUser(id: string): UserRecord {
    this.requireUser(id)
    const updated = this.users().update(id, { status: 'active', frozenReason: undefined })
    this.ctx.platformBus.emit(PlatformEvents.UserActivated, { userId: id })
    return updated
  }

  deactivateUser(id: string, reason: string): UserRecord {
    this.requireUser(id)
    if (!reason?.trim()) throw new Error('注销必须填写原因')
    const updated = this.users().update(id, { status: 'deactivated', frozenReason: reason })
    this.ctx.platformBus.emit(PlatformEvents.UserFrozen, { userId: id, username: updated.username, reason: `注销：${reason}` })
    return updated
  }

  updateUser(id: string, patch: Partial<Pick<UserRecord, 'displayName' | 'email' | 'phone' | 'title' | 'orgId' | 'accountType' | 'primaryOrgId'>>): UserRecord {
    this.requireUser(id)
    if (patch.orgId && !this.orgs().get(patch.orgId)) throw new Error(`组织不存在：${patch.orgId}`)
    if (patch.primaryOrgId && !this.orgs().get(patch.primaryOrgId)) throw new Error(`主归属组织不存在：${patch.primaryOrgId}`)
    if (patch.accountType !== undefined && !['internal', 'external', 'suspended-review'].includes(patch.accountType)) {
      throw new Error(`非法账号类型：${patch.accountType}`)
    }
    return this.users().update(id, patch)
  }

  deleteUser(id: string): boolean {
    const user = this.requireUser(id)
    if (user.status !== 'deactivated') throw new Error('仅已注销账号可物理删除')
    return this.users().remove(id)
  }

  /** 绑定三方身份：事实源为 identityLinks（引擎级唯一约束），user.bindings 为投影。 */
  bindThirdParty(id: string, binding: { provider: ThirdPartyBinding['provider']; unionId: string; displayName: string; corpId?: string; verifyCode?: string }): UserRecord {
    const user = this.requireUser(id)
    if (binding.verifyCode !== '000000' && binding.verifyCode !== undefined && binding.verifyCode.length !== 6) {
      throw new Error('二次验证码格式不正确')
    }
    // corpId 缺省取该 provider 已配置主体的 corpId（控制台手工绑定即针对已接入主体），
    // 保证「一人一号」唯一约束（provider|corpId|providerUserId）对存量链接生效。
    const corpId = binding.corpId ?? this.connectorConfig(binding.provider)?.corpId ?? ''
    if (user.bindings.some((item) => item.provider === binding.provider && (item.corpId ?? '') === corpId)) {
      throw new Error(`该账号已绑定${binding.provider}身份，请先解绑`)
    }
    // 唯一约束冲突由存储引擎兜底（同一主体下同一三方身份只能映射一个账号）
    this.linkIdentity(id, {
      provider: binding.provider,
      providerUserId: binding.unionId,
      corpId,
      displayName: binding.displayName,
    }, 'console')
    return this.users().get(id)!
  }

  unbindThirdParty(id: string, provider: ThirdPartyBinding['provider'], verifyCode: string): UserRecord {
    const user = this.requireUser(id)
    if (!verifyCode || verifyCode.length !== 6) throw new Error('解绑需二次验证（6 位验证码）')
    this.unlinkIdentity(id, provider)
    return this.users().get(id)!
  }

  verifyPassword(username: string, password: string): UserRecord {
    const user = this.users().findOne((item) => item.username === username)
    if (!user) throw new Error('用户名或密码错误')
    if (user.passwordHash !== hashPassword(password, user.passwordSalt)) throw new Error('用户名或密码错误')
    if (user.status === 'frozen') throw new Error(`账号已冻结：${user.frozenReason ?? '联系管理员'}`)
    if (user.status === 'deactivated') throw new Error('账号已注销')
    if (user.status === 'pending') throw new Error('账号待激活，请联系管理员')
    return user
  }

  markLogin(id: string): void {
    this.users().update(id, { lastLoginAt: new Date().toISOString() })
  }

  private requireUser(id: string): UserRecord {
    const user = this.users().get(id)
    if (!user) throw new Error(`账号不存在：${id}`)
    return user
  }

  // -- 角色 ---------------------------------------------------------------

  ensureBuiltinRoles(): void {
    for (const role of BuiltinRoles) {
      if (!this.roles().findOne((item) => item.code === role.code)) {
        this.roles().insert({ id: newId('rol'), ...role })
      }
    }
  }

  /**
   * 内置角色权限迁移（幂等）：给已落库的 resource_admin/developer/auditor 补齐连接器纳管
   * 权限点。只补缺不覆盖；迁移标记入 iam:migrations 集合供观测（P2 修正⑯）。
   */
  ensureConnectorPermissionsMigration(): { applied: boolean; touched: string[] } {
    const collection = this.ctx.opsStorage.collection<RecordBase & { key: string; note?: string }>('iam:migrations')
    const marker = collection.findOne((item) => item.key === 'connector-permissions-v1')
    const touched: string[] = []
    for (const [code, additions] of Object.entries(BUILTIN_ROLE_MIGRATION)) {
      const role = this.roles().findOne((item) => item.code === code)
      if (!role) continue
      const missing = additions.filter((point) => !role.permissions.includes(point))
      if (missing.length > 0) {
        this.roles().update(role.id, { permissions: [...role.permissions, ...missing] })
        this.ctx.platformBus.emit(PlatformEvents.PermissionChanged, { kind: 'builtin_role_migration', roleId: role.id })
        touched.push(`${code}+${missing.join(',')}`)
      }
    }
    // 通配语义复查：resource_admin 持有 mcp.* 形态的通配时 userPermissions 已可展开 connector.*
    // （旧库存量不含 connector.*），故此处显式并入该通配保证无需逐点追加。
    const resourceAdmin = this.roles().findOne((item) => item.code === 'resource_admin')
    if (resourceAdmin && !resourceAdmin.permissions.includes('connector.*')) {
      this.roles().update(resourceAdmin.id, { permissions: [...resourceAdmin.permissions, 'connector.*'] })
      this.ctx.platformBus.emit(PlatformEvents.PermissionChanged, { kind: 'builtin_role_migration', roleId: resourceAdmin.id })
      touched.push('resource_admin+connector.*')
    }
    if (!marker) {
      collection.insert({
        id: newId('mig'), key: 'connector-permissions-v1',
        ...(touched.length > 0 ? { note: touched.join('; ') } : {}),
      })
    }
    return { applied: marker === undefined || touched.length > 0, touched }
  }

  createRole(input: { code: string; name: string; description?: string; permissions: string[] }): RoleRecord {
    if (!input.code || !/^[a-z0-9_]+$/.test(input.code)) throw new Error('角色 code 仅支持小写字母/数字/下划线')
    if (this.roles().findOne((role) => role.code === input.code)) throw new Error(`角色 code 已存在：${input.code}`)
    this.assertPermissions(input.permissions)
    return this.roles().insert({
      id: newId('rol'),
      code: input.code,
      name: input.name,
      builtin: false,
      description: input.description ?? '',
      permissions: input.permissions,
    })
  }

  updateRole(id: string, patch: { name?: string; description?: string; permissions?: string[] }): RoleRecord {
    const role = this.roles().get(id)
    if (!role) throw new Error(`角色不存在：${id}`)
    if (role.builtin && patch.permissions) throw new Error('内置角色的权限不可修改')
    if (patch.permissions) this.assertPermissions(patch.permissions)
    const updated = this.roles().update(id, patch)
    this.ctx.platformBus.emit(PlatformEvents.PermissionChanged, { kind: 'role', roleId: id })
    return updated
  }

  private assertPermissions(permissions: string[]): void {
    for (const permission of permissions) {
      if (permission === '*' || permission.endsWith('.*')) continue
      if (!PermissionCatalog.some((item) => item.point === permission)) {
        throw new Error(`未知权限点：${permission}`)
      }
    }
  }

  assignRoles(userId: string, roleIds: string[]): UserRecord {
    this.requireUser(userId)
    for (const roleId of roleIds) {
      if (!this.roles().get(roleId)) throw new Error(`角色不存在：${roleId}`)
    }
    const updated = this.users().update(userId, { roleIds })
    this.ctx.platformBus.emit(PlatformEvents.PermissionChanged, { kind: 'user_roles', userId })
    return updated
  }

  /** 解析一组角色的实际权限点集合（并集，支持通配）；人机两侧共用同一解析规则。 */
  resolveRolePermissions(roleIds: string[]): string[] {
    const result = new Set<string>()
    for (const roleId of roleIds) {
      const role = this.roles().get(roleId)
      if (!role) continue
      if (role.permissions.includes('*')) return ['*']
      for (const permission of role.permissions) {
        if (permission.endsWith('.*')) {
          const prefix = permission.slice(0, -2)
          for (const item of PermissionCatalog) {
            if (item.point.startsWith(`${prefix}.`)) result.add(item.point)
          }
        } else {
          result.add(permission)
        }
      }
    }
    return [...result]
  }

  /** 计算用户的实际权限点集合（角色并集，支持通配）。 */
  userPermissions(userId: string): string[] {
    const user = this.users().get(userId)
    if (!user) return []
    return this.resolveRolePermissions(user.roleIds)
  }

  hasPermission(userId: string, point: string): boolean {
    const permissions = this.userPermissions(userId)
    return permissions.includes('*') || permissions.includes(point)
  }

  // -- 用户组 -------------------------------------------------------------

  createGroup(input: { name: string; type: 'static' | 'dynamic'; rule?: UserGroupRule; memberIds?: string[]; description?: string }): UserGroupRecord {
    if (!input.name?.trim()) throw new Error('用户组名称不能为空')
    if (this.groups().findOne((group) => group.name === input.name)) throw new Error(`用户组已存在：${input.name}`)
    if (input.type === 'dynamic' && !input.rule) throw new Error('动态用户组必须提供圈人规则')
    return this.groups().insert({
      id: newId('grp'),
      name: input.name,
      type: input.type,
      ...(input.rule !== undefined ? { rule: input.rule } : {}),
      memberIds: input.type === 'static' ? (input.memberIds ?? []) : [],
      description: input.description ?? '',
    })
  }

  updateGroup(id: string, patch: { name?: string; memberIds?: string[]; rule?: UserGroupRule; description?: string }): UserGroupRecord {
    const group = this.groups().get(id)
    if (!group) throw new Error(`用户组不存在：${id}`)
    return this.groups().update(id, patch)
  }

  deleteGroup(id: string): boolean {
    return this.groups().remove(id)
  }

  /** 解析用户组成员（动态组按规则实时圈人）。 */
  resolveGroupMembers(id: string): UserRecord[] {
    const group = this.groups().get(id)
    if (!group) throw new Error(`用户组不存在：${id}`)
    if (group.type === 'static') {
      return group.memberIds
        .map((memberId) => this.users().get(memberId))
        .filter((user): user is UserRecord => Boolean(user) && user!.status === 'active')
    }
    const rule = group.rule ?? {}
    const orgIds = rule.orgIds?.length ? new Set(this.orgSubtreeIds(rule.orgIds[0]!).concat(rule.orgIds)) : undefined
    return this.users().find((user) => {
      if (user.status !== 'active') return false
      if (orgIds && !orgIds.has(user.orgId)) return false
      if (rule.title && user.title !== rule.title) return false
      return true
    })
  }

  groupsOfUser(userId: string): UserGroupRecord[] {
    return this.groups().find((group) => {
      if (group.type === 'static') return group.memberIds.includes(userId)
      return this.resolveGroupMembers(group.id).some((user) => user.id === userId)
    })
  }

  /** 动态用户组成员快照（dev-plan-nas-authz §2.2：重算结果落快照，漂移可观测）。 */
  groupSnapshots(): Collection<GroupSnapshotRecord> {
    return this.ctx.opsStorage.collection<GroupSnapshotRecord>('iam:groupSnapshots')
  }

  /**
   * 重算全部动态用户组成员并与快照比对（连接器同步收尾 / REST 手动触发）。
   * 漂移人数 ≥ 阈值（组上 driftAlertThreshold，缺省 5）或组被标记为 NAS C 关联组（authzRoleC）
   * 时发 `nas.authz.cGroupDrift` 事件——防止 HR 调整静默改变跨域只读范围。
   * 返回本次发生漂移的组清单（含增减明细），供调用方展示/断言。
   */
  refreshGroupSnapshots(actor: string): Array<{ groupId: string; groupName: string; added: string[]; removed: string[]; threshold: number; alerted: boolean }> {
    const drifts: Array<{ groupId: string; groupName: string; added: string[]; removed: string[]; threshold: number; alerted: boolean }> = []
    for (const group of this.groups().find((item) => item.type === 'dynamic')) {
      const memberIds = this.resolveGroupMembers(group.id).map((user) => user.id).sort()
      const existing = this.groupSnapshots().findOne((item) => item.groupId === group.id)
      const previous = existing?.memberIds ?? null
      if (previous !== null) {
        const prevSet = new Set(previous)
        const nextSet = new Set(memberIds)
        const added = memberIds.filter((id) => !prevSet.has(id))
        const removed = previous.filter((id) => !nextSet.has(id))
        if (added.length > 0 || removed.length > 0) {
          const threshold = group.driftAlertThreshold ?? DEFAULT_GROUP_DRIFT_THRESHOLD
          // C 关联组任何幅度的漂移都告警（跨域只读范围敏感）；其余组按阈值
          const alerted = group.authzRoleC === true || (added.length + removed.length) >= threshold
          if (alerted) {
            this.ctx.platformBus.emit('nas.authz.cGroupDrift', {
              groupId: group.id, groupName: group.name, added, removed,
              addedCount: added.length, removedCount: removed.length, threshold, actor,
            })
          }
          drifts.push({ groupId: group.id, groupName: group.name, added, removed, threshold, alerted })
        }
      }
      const record: GroupSnapshotRecord = { id: existing?.id ?? `gsn_${group.id}`, groupId: group.id, memberIds, computedAt: new Date().toISOString() }
      if (existing) this.groupSnapshots().update(existing.id, record)
      else this.groupSnapshots().insert(record)
    }
    return drifts
  }

  // -- 三方接入 -----------------------------------------------------------

  /** 按平台类型取第一条配置（旧调用兼容；多主体请用 connectorConfigById/resolveConnectorConfig）。 */
  connectorConfig(provider: string): ConnectorConfigRecord | undefined {
    return this.connectorConfigs().findOne((config) => config.provider === provider)
  }

  /** 按配置实例 id 寻址（多主体：配置实例以 ConnectorConfigRecord.id 寻址，provider 仅表示平台类型）。 */
  connectorConfigById(id: string): ConnectorConfigRecord | undefined {
    return this.connectorConfigs().get(id)
  }

  /** 解析配置实例：先按 id 找，找不到按 provider 取第一条（enabled 优先）——REST 旧参数兼容入口。 */
  resolveConnectorConfig(idOrProvider: string): ConnectorConfigRecord | undefined {
    const byId = this.connectorConfigById(idOrProvider)
    if (byId) return byId
    const candidates = this.connectorConfigs().find((config) => config.provider === idOrProvider)
    return candidates.find((config) => config.enabled) ?? candidates[0]
  }

  /** 更新/创建接入配置：带 id 按 id 更新；不带 id 维持旧行为（按 provider 第一条更新，无则建）。 */
  upsertConnectorConfig(input: {
    /** 配置实例 id（多主体按 id 更新；缺省=旧的按 provider 第一条语义）。 */
    id?: string
    provider: 'dingtalk' | 'feishu' | 'wecom'
    /** 主体名称（缺省 `${provider}-${corpId}`）。 */
    name?: string
    corpId: string
    appKey: string
    appSecret?: string
    enabled?: boolean
    syncOrgRoot?: string
    intervalMinutes?: number
    callbackUrl?: string
    loginEnabled?: boolean
    conflictStrategy?: ConnectorConfigRecord['conflictStrategy']
    /** real=真实 OpenAPI（需真实企业凭证）；mock=演示降级。 */
    mode?: 'real' | 'mock'
    /** OpenAPI 基址覆盖（测试/专有部署）。 */
    apiBase?: string
    /** 通讯录 topapi 基址覆盖（默认 https://oapi.dingtalk.com）。 */
    oapiBase?: string
    /** 同步树挂载的目标组织 ID（空=平台根）。 */
    targetOrgId?: string
  }): ConnectorConfigRecord {
    if (!IamService.BUILTIN_CONNECTOR_PROVIDERS.has(input.provider)) throw new Error(`未注册的连接器：${input.provider}`)
    let existing: ConnectorConfigRecord | undefined
    if (input.id !== undefined) {
      existing = this.connectorConfigById(input.id)
      if (!existing) throw new Error(`接入配置不存在：${input.id}`)
    } else {
      existing = this.connectorConfig(input.provider)
    }
    const secret = input.appSecret ?? existing?.secretActual ?? 'demo-secret'
    // 非演示密钥的全新配置默认 real（表单不采集 mode，靠密钥形态推导；demo- 前缀=演示降级）。
    const mode = input.mode ?? (secret.startsWith('demo-') ? 'mock' : existing?.mode ?? 'real')
    const payload = {
      provider: input.provider,
      name: input.name ?? existing?.name ?? `${input.provider}-${input.corpId}`,
      enabled: input.enabled ?? existing?.enabled ?? true,
      corpId: input.corpId,
      appKey: input.appKey,
      secretMasked: mask(secret, 4),
      secretActual: secret,
      syncOrgRoot: input.syncOrgRoot ?? existing?.syncOrgRoot ?? '',
      intervalMinutes: input.intervalMinutes ?? existing?.intervalMinutes ?? 60,
      callbackUrl: input.callbackUrl ?? existing?.callbackUrl ?? '',
      loginEnabled: input.loginEnabled ?? existing?.loginEnabled ?? false,
      conflictStrategy: input.conflictStrategy ?? existing?.conflictStrategy ?? 'manual',
      mode,
      ...(input.apiBase !== undefined ? { apiBase: input.apiBase } : existing?.apiBase !== undefined ? { apiBase: existing.apiBase } : {}),
      ...(input.oapiBase !== undefined ? { oapiBase: input.oapiBase } : existing?.oapiBase !== undefined ? { oapiBase: existing.oapiBase } : {}),
      ...(input.targetOrgId !== undefined ? { targetOrgId: input.targetOrgId } : existing?.targetOrgId !== undefined ? { targetOrgId: existing.targetOrgId } : {}),
    }
    const saved = existing
      ? this.connectorConfigs().update(existing.id, payload)
      : this.connectorConfigs().insert({ id: newId('conn'), ...payload })
    this.applyConnectorMode(saved.id)
    return saved
  }

  /** 新建接入配置实例（多主体：同一 provider 可接入多家企业，provider|corpId 由引擎级唯一约束拒绝重复主体）。 */
  createConnectorConfig(input: {
    provider: 'dingtalk' | 'feishu' | 'wecom'
    /** 主体名称（缺省 `${provider}-${corpId}`）。 */
    name?: string
    corpId: string
    appKey: string
    appSecret?: string
    enabled?: boolean
    syncOrgRoot?: string
    intervalMinutes?: number
    callbackUrl?: string
    loginEnabled?: boolean
    conflictStrategy?: ConnectorConfigRecord['conflictStrategy']
    /** real=真实 OpenAPI（需真实企业凭证）；mock=演示降级。 */
    mode?: 'real' | 'mock'
    /** OpenAPI 基址覆盖（测试/专有部署）。 */
    apiBase?: string
    /** 通讯录 topapi 基址覆盖（默认 https://oapi.dingtalk.com）。 */
    oapiBase?: string
    /** 同步树挂载的目标组织 ID（空=平台根）。 */
    targetOrgId?: string
  }): ConnectorConfigRecord {
    if (!IamService.BUILTIN_CONNECTOR_PROVIDERS.has(input.provider)) throw new Error(`未注册的连接器：${input.provider}`)
    const secret = input.appSecret ?? 'demo-secret'
    // 与 upsert 同一推导：demo- 前缀密钥=演示降级（mock），其余全新配置默认 real。
    const mode = input.mode ?? (secret.startsWith('demo-') ? 'mock' : 'real')
    const saved = this.connectorConfigs().insert({
      id: newId('conn'),
      provider: input.provider,
      name: input.name ?? `${input.provider}-${input.corpId}`,
      enabled: input.enabled ?? true,
      corpId: input.corpId,
      appKey: input.appKey,
      secretMasked: mask(secret, 4),
      secretActual: secret,
      syncOrgRoot: input.syncOrgRoot ?? '',
      intervalMinutes: input.intervalMinutes ?? 60,
      callbackUrl: input.callbackUrl ?? '',
      loginEnabled: input.loginEnabled ?? false,
      conflictStrategy: input.conflictStrategy ?? 'manual',
      mode,
      ...(input.apiBase !== undefined ? { apiBase: input.apiBase } : {}),
      ...(input.oapiBase !== undefined ? { oapiBase: input.oapiBase } : {}),
      ...(input.targetOrgId !== undefined ? { targetOrgId: input.targetOrgId } : {}),
    })
    this.applyConnectorMode(saved.id)
    return saved
  }

  /** 删除接入配置实例：同时注销运行时连接器/身份源注册项（不存在则抛错）。 */
  deleteConnectorConfig(id: string): void {
    if (!this.connectorConfigById(id)) throw new Error(`接入配置不存在：${id}`)
    this.connectorConfigs().remove(id)
    this.connectors.delete(id)
    this.authProviders.delete(id)
  }

  /** 按单条配置实例实例化连接器/身份源 Adapter 的 real/mock 实现（第 0 步：连接器真实化；多主体按 configId 注册）。 */
  applyConnectorMode(configId: string): void {
    const config = this.connectorConfigById(configId)
    if (!config) return
    if (config.provider === 'dingtalk') {
      if (config.mode === 'real' && config.secretActual) {
        const credentials: DingTalkCredentials = {
          corpId: config.corpId,
          appKey: config.appKey,
          appSecret: config.secretActual,
          ...(config.apiBase !== undefined ? { apiBase: config.apiBase } : {}),
          ...(config.oapiBase !== undefined ? { oapiBase: config.oapiBase } : {}),
        }
        this.registerConnector(config.id, new RealDingTalkConnector(credentials, { syncOrgRoot: config.syncOrgRoot }))
        this.registerAuthProvider(config.id, new RealDingTalkAuthAdapter(credentials))
      } else if (config.mode === 'mock') {
        // 显式声明 mock（演示/联调）：仅 DEMO_SEED 环境允许注册 mock 身份源，
        // 生产基线禁止将 mock 作为可登录身份源暴露。
        if (process.env.DEMO_SEED === '1') {
          this.registerConnector(config.id, new DingTalkConnector())
          this.registerAuthProvider(config.id, new DingTalkAuthAdapter())
        } else {
          this.registerConnector(config.id, new DingTalkConnector())
        }
      }
    }
  }

  async testConnector(idOrProvider: string): Promise<{ ok: boolean; latencyMs: number; message: string }> {
    const config = this.resolveConnectorConfig(idOrProvider)
    const connector = config ? this.connectors.get(config.id) : undefined
    if (!connector) throw new Error(`未注册的连接器：${idOrProvider}`)
    return connector.healthCheck()
  }

  /** 全量同步：目录映射 + 冲突入队 + 离职联动。失败同样落 lastSyncResult（ok:false），避免「点了没反应」。 */
  async syncConnector(idOrProvider: string, actor: string): Promise<{ created: number; updated: number; conflicts: number; frozen: number; message: string }> {
    const config = this.resolveConnectorConfig(idOrProvider)
    if (!config || !config.enabled) throw new Error(`连接器未启用：${idOrProvider}`)
    const connector = this.connectors.get(config.id)
    if (!connector) throw new Error(`未注册的连接器：${idOrProvider}`)
    try {
      return await this.runSync(config.provider, actor, config, connector)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const result = { ok: false, created: 0, updated: 0, conflicts: 0, frozen: 0, message: `同步失败：${message}` }
      this.connectorConfigs().update(config.id, { lastSyncAt: new Date().toISOString(), lastSyncResult: result })
      throw error
    }
  }

  private async runSync(provider: ConnectorConfigRecord['provider'], actor: string, config: ConnectorConfigRecord, connector: OrgConnector): Promise<{ created: number; updated: number; conflicts: number; frozen: number; message: string }> {
    const directory = await connector.fetchDirectory()

    const remoteOrgToId = new Map<string, string>()
    let created = 0
    let updated = 0
    for (const remoteOrg of directory.orgs) {
      // 多主体：同步树根挂到 config.targetOrgId（空=平台根）
      const parent = remoteOrg.parentRemoteId ? remoteOrgToId.get(remoteOrg.parentRemoteId) : (config.targetOrgId ?? null)
      if (parent === undefined && remoteOrg.parentRemoteId) continue
      // 部门归属双键 customFields { remoteId, connectorId }：旧数据只有 remoteId 的视为不属于任何连接器，不会被误匹配
      const local = this.orgs().findOne((org) => org.customFields['remoteId'] === remoteOrg.remoteId && org.customFields['connectorId'] === config.id)
        // 名称兜底只认领「无归属（手工/历史）或本连接器」的组织——其他主体名下的同名部门不能合并
        ?? this.orgs().findOne((org) => org.name === remoteOrg.name && org.parentId === parent
          && (org.customFields['connectorId'] === undefined || org.customFields['connectorId'] === config.id))
      if (local) {
        // 认领即盖章：名称兜底命中的无归属组织补写 remoteId/connectorId，
        // 之后其他主体的名称兜底不再能命中它（否则第二主体会合并进第一主体的树）。
        if (local.customFields['connectorId'] !== config.id || local.customFields['remoteId'] !== remoteOrg.remoteId) {
          this.orgs().update(local.id, { customFields: { ...local.customFields, remoteId: remoteOrg.remoteId, connectorId: config.id } })
        }
        remoteOrgToId.set(remoteOrg.remoteId, local.id)
      } else {
        const record = this.createOrg({ name: remoteOrg.name, parentId: parent, customFields: { remoteId: remoteOrg.remoteId, connectorId: config.id } })
        remoteOrgToId.set(remoteOrg.remoteId, record.id)
        created++
      }
    }

    let conflicts = 0
    let frozen = 0

    for (const remoteUser of directory.users) {
      const orgId = remoteOrgToId.get(remoteUser.orgRemoteId)
      if (!orgId) continue
      // 一人多部门（兼任语义，dev-plan-nas-authz §2.1）：主归属=orgId（首个部门），挂靠=extraOrgRemoteIds 首个命中。
      // 引擎侧 primaryOrgId=主归属锚点，orgId 子树按兼任只读——双身份权限并存不冲突。
      const secondaryOrgId = (remoteUser.extraOrgRemoteIds ?? []).map((remoteOrgId) => remoteOrgToId.get(remoteOrgId)).find(Boolean)
      // 多主体：bindings 按 provider+corpId 匹配（binding.corpId 为空串/undefined 时只匹配同空）
      let local = this.users().findOne((user) => user.bindings.some((binding) => binding.provider === provider && binding.unionId === remoteUser.remoteId && (binding.corpId ?? '') === config.corpId))
        ?? this.users().findOne((user) => user.jobNumber === remoteUser.jobNumber)
      if (!local) {
        const { user: record } = this.createUser({
          username: remoteUser.jobNumber.toLowerCase(),
          displayName: remoteUser.name,
          orgId,
          title: remoteUser.title,
          email: remoteUser.email,
          jobNumber: remoteUser.jobNumber,
        })
        this.users().update(record.id, secondaryOrgId ? { status: 'active', primaryOrgId: orgId, orgId: secondaryOrgId } : { status: 'active' })
        this.linkIdentity(record.id, { provider, providerUserId: remoteUser.remoteId, corpId: config.corpId, displayName: remoteUser.name }, 'connector-sync')
        created++
        continue
      }
      if (!local.bindings.some((binding) => binding.provider === provider && (binding.corpId ?? '') === config.corpId)) {
        try {
          this.linkIdentity(local.id, { provider, providerUserId: remoteUser.remoteId, corpId: config.corpId, displayName: remoteUser.name }, 'connector-sync')
        } catch {
          // 唯一约束冲突：该三方身份已绑定其他账号（一人一号），跳过并保留冲突语义
        }
      }
      // 运营身份链（nasAuthz P0）：unionId 供 SSO 登录匹配，userid 供 nasAuthz 身份反查
      // （hermes X-On-Behalf-User 上报 userid 口径）与 dept_manager_userid_list 负责人映射——两链并存互不覆盖。
      if (remoteUser.remoteUserId && !this.identityLinks().findOne((link) => link.provider === provider && link.providerUserId === remoteUser.remoteUserId && (link.corpId ?? '') === config.corpId)) {
        try {
          this.linkIdentity(local.id, { provider, providerUserId: remoteUser.remoteUserId, corpId: config.corpId, displayName: remoteUser.name }, 'connector-sync')
        } catch {
          // 唯一约束冲突：该 userid 已绑定其他账号，跳过（沿用 unionId 链语义）
        }
      }
      // 兼任归属是组织架构事实（钉钉多部门），不进属性冲突机制，直接落库收敛：
      // primaryOrgId 锚定主归属，orgId 切到兼任挂靠（引擎对其子树授只读）
      if (secondaryOrgId && (local.primaryOrgId !== orgId || local.orgId !== secondaryOrgId)) {
        this.users().update(local.id, { primaryOrgId: orgId, orgId: secondaryOrgId })
        local = this.users().get(local.id) ?? local
      }
      if (!remoteUser.active) {
        if (local.status === 'active' || local.status === 'pending') {
          this.freezeUser(local.id, `三方同步：${provider} 通讯录已离职`)
          frozen++
        }
        continue
      }
      const attrDiffers = local.displayName !== remoteUser.name || local.title !== remoteUser.title || local.orgId !== (secondaryOrgId ?? orgId)
      if (attrDiffers) {
        if (config.conflictStrategy === 'third_party_wins') {
          this.users().update(local.id, { displayName: remoteUser.name, title: remoteUser.title, orgId: secondaryOrgId ?? orgId })
          updated++
        } else if (config.conflictStrategy === 'platform_wins') {
          updated++
        } else {
          this.conflicts().insert({
            id: newId('cfl'),
            provider,
            kind: 'user_attr',
            thirdPartyData: { displayName: remoteUser.name, title: remoteUser.title, orgId, orgName: this.orgs().get(orgId)?.name },
            platformData: { displayName: local.displayName, title: local.title, orgId: local.orgId, orgName: this.orgs().get(local.orgId)?.name },
            status: 'pending',
          })
          conflicts++
        }
      }
    }

    // 负责人同步（dev-plan-nas-authz 步骤 1）：dept_manager_userid_list → 平台 userId（identityLinks 反查）。
    // 置于用户循环之后：userid 身份链在同一轮先落库，负责人才映射得上（钉钉负责人列表是 userid 口径）。
    // 远端显式给空列表=清空负责人；字段缺省=不动本地（兼容旧目录源）。映射不上的远端负责人被丢弃（不落悬空 ID）。
    let leaderSynced = 0
    for (const remoteOrg of directory.orgs) {
      if (!Array.isArray(remoteOrg.managerRemoteIds)) continue
      const localOrgId = remoteOrgToId.get(remoteOrg.remoteId)
      if (!localOrgId) continue
      const leaderUserIds = remoteOrg.managerRemoteIds
        .map((remoteUserId) => this.identityLinks().findOne((link) => link.provider === provider && link.providerUserId === remoteUserId && (link.corpId ?? '') === config.corpId)?.userId)
        .filter((id): id is string => Boolean(id))
      this.orgs().update(localOrgId, { leaderUserIds })
      leaderSynced++
    }

    // 动态用户组重算快照 + 漂移告警（dev-plan-nas-authz §2.2）：HR 调整 title/org 后
    // 组成员可能静默变化，同步收尾时统一重算并与快照比对，漂移超阈值或涉及 C 关联组即告警。
    const drifts = this.refreshGroupSnapshots('connector-sync')

    const result = { ok: true, created, updated, conflicts, frozen, message: `同步完成：新建 ${created}，更新 ${updated}，冲突 ${conflicts}，离职冻结 ${frozen}${leaderSynced > 0 ? `，负责人 ${leaderSynced}` : ''}${drifts.length > 0 ? `，组漂移 ${drifts.length}` : ''}` }
    this.connectorConfigs().update(config.id, { lastSyncAt: new Date().toISOString(), lastSyncResult: result })
    this.ctx.platformBus.emit(PlatformEvents.ConnectorSynced, { provider, actor, ...result })
    return result
  }

  resolveConflict(id: string, keep: 'third_party' | 'platform', actor: string): SyncConflictRecord {
    const conflict = this.conflicts().get(id)
    if (!conflict) throw new Error(`冲突记录不存在：${id}`)
    if (conflict.status === 'resolved') throw new Error('该冲突已处理')
    if (conflict.kind === 'user_attr') {
      const jobNumber = String(conflict.thirdPartyData.jobNumber ?? '')
      const local = this.users().findOne((user) => user.bindings.some((binding) => binding.provider === conflict.provider && binding.unionId === conflict.thirdPartyData.unionId))
        ?? (jobNumber ? this.users().findOne((user) => user.jobNumber === jobNumber) : undefined)
      if (local) {
        const source = keep === 'third_party' ? conflict.thirdPartyData : conflict.platformData
        this.users().update(local.id, {
          displayName: String(source.displayName ?? local.displayName),
          title: String(source.title ?? local.title),
          orgId: String(source.orgId ?? local.orgId),
        })
      }
    }
    return this.conflicts().update(id, {
      status: 'resolved',
      resolution: keep,
      resolvedBy: actor,
      resolvedAt: new Date().toISOString(),
    })
  }
}

export interface OrgTreeNode extends OrgRecord {
  children: OrgTreeNode[]
}

function hashPassword(password: string, salt: string): string {
  return sha256Hex(`${salt}:${password}`)
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/cordis' {
  interface Context {
    iam: IamService
  }
}

export const name = 'iam'
export const inject = ['opsStorage', 'platformBus']

export function apply(ctx: Context) {
  ctx.plugin(IamService)
  ctx.plugin(iamTools)
}
