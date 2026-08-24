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
}

export interface ConnectorConfigRecord extends RecordBase {
  id: string
  provider: 'dingtalk' | 'feishu' | 'wecom'
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
  lastSyncAt?: string
  lastSyncResult?: { ok: boolean; created: number; updated: number; conflicts: number; frozen: number; message: string }
}

/**
 * 三方身份链接（融合 auth-identity 的 user_identity_links 设计）。
 * 活跃链接在 (provider, providerUserId) 上引擎级唯一——「一人一号」由唯一约束兜底，
 * 禁止以「先查后插」替代约束（红线）。解绑即物理删除记录（等价 WHERE unlinked_at IS NULL 的部分唯一索引）。
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
  { point: 'skill.read', label: '浏览 Skill 市场', group: 'Skill 市场' },
  { point: 'skill.submit', label: '提交 Skill', group: 'Skill 市场' },
  { point: 'skill.approve', label: '审批 Skill', group: 'Skill 市场' },
  { point: 'skill.publish', label: '上架/下架 Skill', group: 'Skill 市场' },
  { point: 'skill.install', label: '安装 Skill', group: 'Skill 市场' },
  { point: 'skill.storage.write', label: '配置 Skill 包存储后端（本地/NAS）', group: 'Skill 市场' },
  { point: 'nas.read', label: '查看 NAS 存储', group: 'NAS 存储' },
  { point: 'nas.write', label: '管理 NAS 存储（纳管/上线/文件读写）', group: 'NAS 存储' },
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
  { code: 'resource_admin', name: '资源管理员', builtin: true, description: '管理 MCP/Skill/Agent/应用/NAS 资源', permissions: ['console.login', 'mcp.*', 'skill.*', 'agent.*', 'app.*', 'nas.*', 'authn.oidc.*', 'approval.read'] },
  { code: 'developer', name: '开发者', builtin: true, description: '提交与调试资源（应用限自身 owner 范围，服务端校验）', permissions: ['console.login', 'iam.user.read', 'iam.org.read', 'mcp.service.read', 'mcp.invoke', 'skill.read', 'skill.submit', 'skill.install', 'agent.read', 'app.read', 'app.write', 'nas.read'] },
  { code: 'member', name: '普通用户', builtin: true, description: '浏览市场与可用资源', permissions: ['console.login', 'skill.read', 'agent.read', 'app.read'] },
  { code: 'auditor', name: '审计员（只读）', builtin: true, description: '全平台只读审计', permissions: ['console.login', 'iam.org.read', 'iam.user.read', 'authn.principal.read', 'authn.oidc.read', 'mcp.service.read', 'skill.read', 'agent.read', 'app.read', 'nas.read', 'audit.read', 'approval.read'] },
]

// ---------------------------------------------------------------------------
// 三方连接器接口
// ---------------------------------------------------------------------------

export interface RemoteDirectory {
  orgs: Array<{ remoteId: string; name: string; parentRemoteId: string | null }>
  users: Array<{ remoteId: string; name: string; jobNumber: string; title: string; orgRemoteId: string; email: string; active: boolean }>
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
      { remoteId: 'dd_root', name: '元冰可集团', parentRemoteId: null },
      { remoteId: 'dd_tech', name: '技术中心', parentRemoteId: 'dd_root' },
      { remoteId: 'dd_ai', name: 'AI 平台部', parentRemoteId: 'dd_tech' },
      { remoteId: 'dd_be', name: '后端部', parentRemoteId: 'dd_tech' },
      { remoteId: 'dd_fe', name: '前端部', parentRemoteId: 'dd_tech' },
      { remoteId: 'dd_prod', name: '产品运营部', parentRemoteId: 'dd_root' },
      { remoteId: 'dd_mkt', name: '市场部', parentRemoteId: 'dd_root' },
    ],
    users: [
      { remoteId: 'dd_u001', name: '陈远舟', jobNumber: 'DD0001', title: '技术总监', orgRemoteId: 'dd_tech', email: 'chenyz@yuanbingke.com', active: true },
      { remoteId: 'dd_u002', name: '林小满', jobNumber: 'DD0002', title: '算法工程师', orgRemoteId: 'dd_ai', email: 'linxm@yuanbingke.com', active: true },
      { remoteId: 'dd_u003', name: '周既白', jobNumber: 'DD0003', title: '算法工程师', orgRemoteId: 'dd_ai', email: 'zhoujb@yuanbingke.com', active: true },
      { remoteId: 'dd_u004', name: '苏砚秋', jobNumber: 'DD0004', title: '后端工程师', orgRemoteId: 'dd_be', email: 'suyq@yuanbingke.com', active: true },
      { remoteId: 'dd_u005', name: '何青梧', jobNumber: 'DD0005', title: '前端工程师', orgRemoteId: 'dd_fe', email: 'heqw@yuanbingke.com', active: true },
      { remoteId: 'dd_u006', name: '顾星阑', jobNumber: 'DD0006', title: '产品经理', orgRemoteId: 'dd_prod', email: 'guxl@yuanbingke.com', active: true },
      { remoteId: 'dd_u007', name: '叶栖迟', jobNumber: 'DD0007', title: '运营专员', orgRemoteId: 'dd_prod', email: 'yqz@yuanbingke.com', active: true },
      { remoteId: 'dd_u008', name: '孟疏桐', jobNumber: 'DD0008', title: '市场专员', orgRemoteId: 'dd_mkt', email: 'mst@yuanbingke.com', active: true },
      { remoteId: 'dd_u009', name: '周明澜', jobNumber: 'DD0009', title: '前端工程师', orgRemoteId: 'dd_fe', email: 'zhml@yuanbingke.com', active: true },
      { remoteId: 'dd_u010', name: '姜叙白', jobNumber: 'DD0010', title: '数据工程师', orgRemoteId: 'dd_be', email: 'jxb@yuanbingke.com', active: false },
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
 * 链路：企业内部应用 accessToken（POST /v1.0/oauth2/accessToken）
 *   → 部门树（POST /v1.0/contact/departments/listByParent，自根遍历）
 *   → 部门成员（POST /v1.0/contact/users/findByDept 分页）。
 */
export class RealDingTalkConnector implements OrgConnector {
  provider = 'dingtalk'
  label = '钉钉'
  private corpTokenCache: { token: string; expiresAt: number } | undefined
  private readonly credentials: DingTalkCredentials

  constructor(credentials: DingTalkCredentials) {
    this.credentials = credentials
  }

  private get apiBase(): string {
    return this.credentials.apiBase ?? 'https://api.dingtalk.com'
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

  async fetchDirectory(): Promise<RemoteDirectory> {
    const token = await this.corpAccessToken()
    const orgs: RemoteDirectory['orgs'] = [{ remoteId: '1', name: this.credentials.corpId, parentRemoteId: null }]
    const users: RemoteDirectory['users'] = []
    // 自根部门 BFS（上限 3 层 / 每层 50 部门，防御异常目录）
    let frontier = ['1']
    for (let depth = 0; depth < 3 && frontier.length > 0; depth++) {
      const next: string[] = []
      for (const deptId of frontier.slice(0, 50)) {
        const children = await this.listDepartments(token, deptId)
        for (const child of children) {
          orgs.push({ remoteId: String(child.deptId), name: child.name, parentRemoteId: deptId })
          next.push(String(child.deptId))
        }
      }
      frontier = next
    }
    for (const org of orgs) {
      const members = await this.listUsers(token, org.remoteId)
      for (const member of members) {
        if (users.some((user) => user.remoteId === member.remoteId)) continue
        users.push({ ...member, orgRemoteId: org.remoteId })
      }
    }
    return { orgs, users }
  }

  private async listDepartments(token: string, deptId: string): Promise<Array<{ deptId: number; name: string }>> {
    const response = await fetch(`${this.apiBase}/v1.0/contact/departments/listByParent?deptId=${encodeURIComponent(deptId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
      body: JSON.stringify({ maxResults: 100 }),
    })
    if (!response.ok) return []
    const payload = (await response.json().catch(() => ({}))) as { result?: Array<{ deptId: number; name: string }> }
    return payload.result ?? []
  }

  private async listUsers(token: string, deptId: string): Promise<RemoteDirectory['users']> {
    const users: RemoteDirectory['users'] = []
    let cursor = 0
    for (let page = 0; page < 10; page++) {
      const response = await fetch(`${this.apiBase}/v1.0/contact/users/findByDept?deptId=${encodeURIComponent(deptId)}&cursor=${cursor}&size=100`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
        body: JSON.stringify({}),
      })
      if (!response.ok) break
      const payload = (await response.json().catch(() => ({}))) as {
        result?: Array<{ unionId?: string; userId?: string; name?: string; jobNumber?: string; title?: string; email?: string; active?: boolean }>
        hasMore?: boolean
        nextToken?: number
      }
      for (const item of payload.result ?? []) {
        const remoteId = item.unionId ?? item.userId
        if (!remoteId) continue
        users.push({
          remoteId,
          name: item.name ?? remoteId,
          jobNumber: item.jobNumber ?? remoteId,
          title: item.title ?? '',
          orgRemoteId: deptId,
          email: item.email ?? '',
          active: item.active ?? true,
        })
      }
      if (!payload.hasMore) break
      cursor = Number(payload.nextToken ?? cursor + 100)
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

  private connectors = new Map<string, OrgConnector>()
  private authProviders = new Map<string, IdentityProviderAdapter>()

  constructor(ctx: Context) {
    super(ctx, 'iam')
    // 默认不注册任何三方身份源：生产基线三方登录入口自动隐藏（未配置连接器时 sso 不可用）。
    // mock 钉钉 IdP 仅在显式 DEMO_SEED=1 演示环境下注册，避免生产基线暴露演示身份/匿名注册入口。
    if (process.env.DEMO_SEED === '1') {
      this.registerConnector(new DingTalkConnector())
      this.registerAuthProvider(new DingTalkAuthAdapter())
    }
    this.ensureDefaultTenant()
    // 连接器/身份源注册表仅存内存：重启后须按持久化配置重建，否则 real 模式的
    // Real*Adapter 不会恢复（扫码登录/同步将报「未注册」）。
    for (const config of this.connectorConfigs().all()) {
      this.applyConnectorMode(config.provider)
    }
  }

  registerConnector(connector: OrgConnector): () => void {
    this.connectors.set(connector.provider, connector)
    return () => this.connectors.delete(connector.provider)
  }

  /** 注册身份源 Adapter：登录主流程面向接口编程，新增平台零侵入。 */
  registerAuthProvider(adapter: IdentityProviderAdapter): () => void {
    this.authProviders.set(adapter.type, adapter)
    return () => this.authProviders.delete(adapter.type)
  }

  getAuthProvider(type: string): IdentityProviderAdapter {
    const adapter = this.authProviders.get(type)
    if (!adapter) throw new Error(`未注册的身份源：${type}`)
    return adapter
  }

  /** 三方身份链接集合（活跃唯一约束：同一三方身份只能映射一个平台账号）。 */
  identityLinks(): Collection<IdentityLinkRecord> {
    const collection = this.ctx.opsStorage.collection<IdentityLinkRecord>('iam:identityLinks')
    collection.uniqueOn('identity_link_active', (record) => `${record.provider}|${record.providerUserId}`)
    return collection
  }

  /** 命中查找：按归一化档案定位已绑定的平台账号。 */
  findLinkByProfile(provider: string, providerUserId: string): IdentityLinkRecord | undefined {
    return this.identityLinks().findOne((link) => link.provider === provider && link.providerUserId === providerUserId)
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
    // 投影同步（bindings 仅作展示，事实源是 identityLinks）
    if (!user.bindings.some((item) => item.provider === profile.provider)) {
      this.users().update(userId, {
        bindings: [...user.bindings, { provider: profile.provider, unionId: profile.providerUserId, displayName: profile.displayName, boundAt: link.linkedAt }],
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

  connectorProviders(): Array<{ provider: string; label: string }> {
    return [...this.connectors.values()].map(({ provider, label }) => ({ provider, label }))
  }

  // -- 集合 ---------------------------------------------------------------

  orgs(): Collection<OrgRecord> {
    const collection = this.ctx.opsStorage.collection<OrgRecord>('iam:orgs')
    collection.uniqueOn('org_same_level_name', (org) => `${org.parentId ?? '-'}|${org.name}`)
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
    return this.ctx.opsStorage.collection<ConnectorConfigRecord>('iam:connectors')
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

  createOrg(input: { name: string; parentId?: string | null; order?: number; customFields?: Record<string, string>; tenantId?: string }): OrgRecord {
    if (!input.name?.trim()) throw new Error('组织名称不能为空')
    const parentId = input.parentId ?? null
    if (parentId && !this.orgs().get(parentId)) throw new Error(`父组织不存在：${parentId}`)
    const duplicate = this.orgs().findOne((org) => org.name === input.name && org.parentId === parentId)
    if (duplicate) throw new Error(`同级下已存在同名组织「${input.name}」`)
    const record = this.orgs().insert({
      id: newId('org'),
      name: input.name.trim(),
      parentId,
      order: input.order ?? this.orgs().count() + 1,
      status: 'active',
      customFields: input.customFields ?? {},
      ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
    })
    this.ctx.platformBus.emit(PlatformEvents.OrgChanged, { kind: 'create', orgId: record.id, name: record.name })
    return record
  }

  renameOrg(id: string, name: string): OrgRecord {
    this.requireOrg(id)
    return this.orgs().update(id, { name })
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

  deleteOrg(id: string): boolean {
    this.requireOrg(id)
    if (this.orgs().find((org) => org.parentId === id).length > 0) throw new Error('存在子组织，无法删除')
    if (this.users().find((user) => user.orgId === id).length > 0) throw new Error('组织下仍有账号，无法删除')
    return this.orgs().remove(id)
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

  updateUser(id: string, patch: Partial<Pick<UserRecord, 'displayName' | 'email' | 'phone' | 'title' | 'orgId'>>): UserRecord {
    this.requireUser(id)
    if (patch.orgId && !this.orgs().get(patch.orgId)) throw new Error(`组织不存在：${patch.orgId}`)
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
    if (user.bindings.some((item) => item.provider === binding.provider)) {
      throw new Error(`该账号已绑定${binding.provider}身份，请先解绑`)
    }
    // 唯一约束冲突由存储引擎兜底（同一 provider|unionId 只能映射一个账号）
    this.linkIdentity(id, {
      provider: binding.provider,
      providerUserId: binding.unionId,
      corpId: binding.corpId ?? '',
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

  /** 计算用户的实际权限点集合（角色并集，支持通配）。 */
  userPermissions(userId: string): string[] {
    const user = this.users().get(userId)
    if (!user) return []
    const result = new Set<string>()
    for (const roleId of user.roleIds) {
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

  // -- 三方接入 -----------------------------------------------------------

  connectorConfig(provider: string): ConnectorConfigRecord | undefined {
    return this.connectorConfigs().findOne((config) => config.provider === provider)
  }

  upsertConnectorConfig(input: {
    provider: 'dingtalk' | 'feishu' | 'wecom'
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
  }): ConnectorConfigRecord {
    if (!IamService.BUILTIN_CONNECTOR_PROVIDERS.has(input.provider)) throw new Error(`未注册的连接器：${input.provider}`)
    const existing = this.connectorConfig(input.provider)
    const secret = input.appSecret ?? existing?.secretActual ?? 'demo-secret'
    // 非演示密钥的全新配置默认 real（表单不采集 mode，靠密钥形态推导；demo- 前缀=演示降级）。
    const mode = input.mode ?? (secret.startsWith('demo-') ? 'mock' : existing?.mode ?? 'real')
    const payload = {
      provider: input.provider,
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
    }
    const saved = existing
      ? this.connectorConfigs().update(existing.id, payload)
      : this.connectorConfigs().insert({ id: newId('conn'), ...payload })
    this.applyConnectorMode(input.provider)
    return saved
  }

  /** 按配置切换连接器/身份源 Adapter 的 real/mock 实现（第 0 步：连接器真实化）。 */
  applyConnectorMode(provider: 'dingtalk' | 'feishu' | 'wecom'): void {
    const config = this.connectorConfig(provider)
    if (!config) return
    if (provider === 'dingtalk') {
      if (config.mode === 'real' && config.secretActual) {
        const credentials: DingTalkCredentials = {
          corpId: config.corpId,
          appKey: config.appKey,
          appSecret: config.secretActual,
          ...(config.apiBase !== undefined ? { apiBase: config.apiBase } : {}),
        }
        this.registerConnector(new RealDingTalkConnector(credentials))
        this.registerAuthProvider(new RealDingTalkAuthAdapter(credentials))
      } else if (config.mode === 'mock') {
        // 显式声明 mock（演示/联调）：仅 DEMO_SEED 环境允许注册 mock 身份源，
        // 生产基线禁止将 mock 作为可登录身份源暴露。
        if (process.env.DEMO_SEED === '1') {
          this.registerConnector(new DingTalkConnector())
          this.registerAuthProvider(new DingTalkAuthAdapter())
        } else {
          this.registerConnector(new DingTalkConnector())
        }
      }
    }
  }

  async testConnector(provider: string): Promise<{ ok: boolean; latencyMs: number; message: string }> {
    const connector = this.connectors.get(provider)
    if (!connector) throw new Error(`未注册的连接器：${provider}`)
    return connector.healthCheck()
  }

  /** 全量同步：目录映射 + 冲突入队 + 离职联动。 */
  async syncConnector(provider: string, actor: string): Promise<{ created: number; updated: number; conflicts: number; frozen: number; message: string }> {
    const config = this.connectorConfig(provider)
    if (!config || !config.enabled) throw new Error(`连接器未启用：${provider}`)
    const connector = this.connectors.get(provider)
    if (!connector) throw new Error(`未注册的连接器：${provider}`)
    const directory = await connector.fetchDirectory()

    const remoteOrgToId = new Map<string, string>()
    let created = 0
    let updated = 0
    for (const remoteOrg of directory.orgs) {
      const parent = remoteOrg.parentRemoteId ? remoteOrgToId.get(remoteOrg.parentRemoteId) : null
      if (parent === undefined && remoteOrg.parentRemoteId) continue
      const local = this.orgs().findOne((org) => org.customFields['remoteId'] === remoteOrg.remoteId)
        ?? this.orgs().findOne((org) => org.name === remoteOrg.name && org.parentId === parent)
      if (local) {
        remoteOrgToId.set(remoteOrg.remoteId, local.id)
      } else {
        const record = this.createOrg({ name: remoteOrg.name, parentId: parent, customFields: { remoteId: remoteOrg.remoteId } })
        remoteOrgToId.set(remoteOrg.remoteId, record.id)
        created++
      }
    }

    let conflicts = 0
    let frozen = 0
    for (const remoteUser of directory.users) {
      const orgId = remoteOrgToId.get(remoteUser.orgRemoteId)
      if (!orgId) continue
      const local = this.users().findOne((user) => user.bindings.some((binding) => binding.provider === provider && binding.unionId === remoteUser.remoteId))
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
        this.users().update(record.id, { status: 'active' })
        this.linkIdentity(record.id, { provider, providerUserId: remoteUser.remoteId, corpId: config.corpId, displayName: remoteUser.name }, 'connector-sync')
        created++
        continue
      }
      if (!local.bindings.some((binding) => binding.provider === provider)) {
        try {
          this.linkIdentity(local.id, { provider, providerUserId: remoteUser.remoteId, corpId: config.corpId, displayName: remoteUser.name }, 'connector-sync')
        } catch {
          // 唯一约束冲突：该三方身份已绑定其他账号（一人一号），跳过并保留冲突语义
        }
      }
      if (!remoteUser.active) {
        if (local.status === 'active' || local.status === 'pending') {
          this.freezeUser(local.id, `三方同步：${provider} 通讯录已离职`)
          frozen++
        }
        continue
      }
      const attrDiffers = local.displayName !== remoteUser.name || local.title !== remoteUser.title || local.orgId !== orgId
      if (attrDiffers) {
        if (config.conflictStrategy === 'third_party_wins') {
          this.users().update(local.id, { displayName: remoteUser.name, title: remoteUser.title, orgId })
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

    const result = { created, updated, conflicts, frozen, message: `同步完成：新建 ${created}，更新 ${updated}，冲突 ${conflicts}，离职冻结 ${frozen}` }
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
