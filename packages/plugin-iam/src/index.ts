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
} from '@dsh-ops/platform-core'
import * as iamTools from './tools.ts'

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

export interface OrgRecord extends RecordBase {
  name: string
  parentId: string | null
  order: number
  status: 'active' | 'archived'
  customFields: Record<string, string>
}

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
  lastSyncAt?: string
  lastSyncResult?: { ok: boolean; created: number; updated: number; conflicts: number; message: string }
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
]

export const BuiltinRoles: Array<Omit<RoleRecord, 'id' | 'createdAt' | 'updatedAt'>> = [
  { code: 'super_admin', name: '平台超级管理员', builtin: true, description: '拥有全部权限点', permissions: ['*'] },
  { code: 'org_admin', name: '组织管理员', builtin: true, description: '管理本组织账号与用户组', permissions: ['console.login', 'iam.*', 'approval.read'] },
  { code: 'resource_admin', name: '资源管理员', builtin: true, description: '管理 MCP/Skill/Agent/应用资源', permissions: ['console.login', 'mcp.*', 'skill.*', 'agent.*', 'app.*', 'approval.read'] },
  { code: 'developer', name: '开发者', builtin: true, description: '提交与调试资源', permissions: ['console.login', 'iam.user.read', 'iam.org.read', 'mcp.service.read', 'mcp.invoke', 'skill.read', 'skill.submit', 'skill.install', 'agent.read', 'app.read'] },
  { code: 'member', name: '普通用户', builtin: true, description: '浏览市场与可用资源', permissions: ['console.login', 'skill.read', 'agent.read', 'app.read'] },
  { code: 'auditor', name: '审计员（只读）', builtin: true, description: '全平台只读审计', permissions: ['console.login', 'iam.org.read', 'iam.user.read', 'authn.principal.read', 'mcp.service.read', 'skill.read', 'agent.read', 'app.read', 'audit.read', 'approval.read'] },
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
  healthCheck(): Promise<{ ok: boolean; latencyMs: number; message: string }>
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

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; message: string }> {
    const started = Date.now()
    await delay(40)
    return { ok: true, latencyMs: Date.now() - started, message: '模拟钉钉 OpenAPI 连通正常' }
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

  private connectors = new Map<string, OrgConnector>()

  constructor(ctx: Context) {
    super(ctx, 'iam')
    this.registerConnector(new DingTalkConnector())
  }

  registerConnector(connector: OrgConnector): () => void {
    this.connectors.set(connector.provider, connector)
    return () => this.connectors.delete(connector.provider)
  }

  connectorProviders(): Array<{ provider: string; label: string }> {
    return [...this.connectors.values()].map(({ provider, label }) => ({ provider, label }))
  }

  // -- 集合 ---------------------------------------------------------------

  orgs(): Collection<OrgRecord> {
    return this.ctx.storage.collection<OrgRecord>('iam:orgs')
  }

  users(): Collection<UserRecord> {
    return this.ctx.storage.collection<UserRecord>('iam:users')
  }

  roles(): Collection<RoleRecord> {
    return this.ctx.storage.collection<RoleRecord>('iam:roles')
  }

  groups(): Collection<UserGroupRecord> {
    return this.ctx.storage.collection<UserGroupRecord>('iam:groups')
  }

  connectorConfigs(): Collection<ConnectorConfigRecord> {
    return this.ctx.storage.collection<ConnectorConfigRecord>('iam:connectors')
  }

  conflicts(): Collection<SyncConflictRecord> {
    return this.ctx.storage.collection<SyncConflictRecord>('iam:conflicts')
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

  createOrg(input: { name: string; parentId?: string | null; order?: number; customFields?: Record<string, string> }): OrgRecord {
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
  }): UserRecord {
    if (!input.username?.trim()) throw new Error('用户名不能为空')
    if (!/^[a-z0-9_.-]+$/i.test(input.username)) throw new Error('用户名仅支持字母、数字与 _ . -')
    if (this.users().findOne((user) => user.username === input.username)) throw new Error(`用户名已存在：${input.username}`)
    if (!this.orgs().get(input.orgId)) throw new Error(`组织不存在：${input.orgId}`)
    const salt = generateSecret('salt').slice(0, 16)
    const password = input.password ?? 'Ybk@2026'
    return this.users().insert({
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
  }

  importUsers(items: Array<{ username: string; displayName: string; orgId: string; title?: string; email?: string }>): { created: UserRecord[]; skipped: string[] } {
    const created: UserRecord[] = []
    const skipped: string[] = []
    for (const item of items) {
      if (this.users().findOne((user) => user.username === item.username)) {
        skipped.push(item.username)
        continue
      }
      created.push(this.createUser(item))
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

  bindThirdParty(id: string, binding: { provider: ThirdPartyBinding['provider']; unionId: string; displayName: string; verifyCode?: string }): UserRecord {
    const user = this.requireUser(id)
    if (binding.verifyCode !== '000000' && binding.verifyCode !== undefined && binding.verifyCode.length !== 6) {
      throw new Error('二次验证码格式不正确')
    }
    if (user.bindings.some((item) => item.provider === binding.provider)) {
      throw new Error(`该账号已绑定${binding.provider}身份，请先解绑`)
    }
    const conflict = this.users().findOne((candidate) =>
      candidate.id !== id && candidate.bindings.some((item) => item.provider === binding.provider && item.unionId === binding.unionId))
    if (conflict) throw new Error(`该三方身份已被 ${conflict.displayName} 绑定（一人一号原则）`)
    return this.users().update(id, {
      bindings: [...user.bindings, {
        provider: binding.provider,
        unionId: binding.unionId,
        displayName: binding.displayName,
        boundAt: new Date().toISOString(),
      }],
    })
  }

  unbindThirdParty(id: string, provider: ThirdPartyBinding['provider'], verifyCode: string): UserRecord {
    const user = this.requireUser(id)
    if (!verifyCode || verifyCode.length !== 6) throw new Error('解绑需二次验证（6 位验证码）')
    return this.users().update(id, { bindings: user.bindings.filter((item) => item.provider !== provider) })
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
  }): ConnectorConfigRecord {
    if (!this.connectors.has(input.provider)) throw new Error(`未注册的连接器：${input.provider}`)
    const existing = this.connectorConfig(input.provider)
    const secret = input.appSecret ?? existing?.secretActual ?? 'demo-secret'
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
    }
    if (existing) return this.connectorConfigs().update(existing.id, payload)
    return this.connectorConfigs().insert({ id: newId('conn'), ...payload })
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
        const record = this.createUser({
          username: remoteUser.jobNumber.toLowerCase(),
          displayName: remoteUser.name,
          orgId,
          title: remoteUser.title,
          email: remoteUser.email,
          jobNumber: remoteUser.jobNumber,
        })
        this.users().update(record.id, {
          status: 'active',
          bindings: [{ provider, unionId: remoteUser.remoteId, displayName: remoteUser.name, boundAt: new Date().toISOString() }],
        })
        created++
        continue
      }
      if (!local.bindings.some((binding) => binding.provider === provider)) {
        this.users().update(local.id, {
          bindings: [...local.bindings, { provider, unionId: remoteUser.remoteId, displayName: remoteUser.name, boundAt: new Date().toISOString() }],
        })
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
export const inject = ['storage', 'platformBus']

export function apply(ctx: Context) {
  ctx.plugin(IamService)
  ctx.plugin(iamTools)
}
