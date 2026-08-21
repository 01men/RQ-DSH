/**
 * @dsh-ops/plugin-authn —— 统一认证中心。
 *
 * 双轨身份：人（SSO/密码）与机器（Client Credentials）共用一套 Principal 体系。
 * 令牌：HMAC 签名的短期访问令牌（默认 2h，可刷新），支持吊销与密钥轮换。
 * 令牌链（on-behalf-of）：用户 → 应用 → Agent → MCP，act 链在令牌中叠加，审计可还原。
 */
import { createHmac, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import {
  PlatformEvents, generateSecret, newId, sha256Hex,
  type Collection, type RecordBase,
} from '@dsh-ops/platform-core'
import * as authnTools from './tools.ts'

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

export interface PrincipalRecord extends RecordBase {
  type: 'human' | 'machine'
  /** human: userId；machine: 资源引用（agent:xxx / app:xxx）或自由主体。 */
  refType?: 'user' | 'agent' | 'app' | 'external'
  refId?: string
  name: string
  status: 'active' | 'disabled'
  clientId?: string
  clientSecretHash?: string
  /** 机器身份的权限点快照（human 实时解析角色）。 */
  scopes: string[]
}

export interface ActEntry {
  principalId: string
  name: string
  type: 'human' | 'machine'
}

export interface TokenRecord extends RecordBase {
  jti: string
  principalId: string
  kind: 'access' | 'machine' | 'refresh'
  scopes: string[]
  actChain: ActEntry[]
  issuedAt: string
  expiresAt: string
  lastUsedAt?: string
  revokedAt?: string
  revokedReason?: string
  issuedBy: string
}

export interface VerifiedPrincipal {
  principal: PrincipalRecord
  token: TokenRecord
  scopes: string[]
  actChain: ActEntry[]
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class AuthnService extends Service {
  static readonly provide = 'authn'

  private signingSecret: string
  private revocations = new Set<string>()

  constructor(ctx: Context) {
    super(ctx, 'authn')
    this.signingSecret = this.loadOrCreateSecret()
    // 事件联动：账号冻结 → 吊销全部令牌；Agent 下线 → 吊销机器凭证
    ctx.platformBus.on(PlatformEvents.UserFrozen, (payload) => {
      const { userId, reason } = payload as { userId: string; reason: string }
      const principal = this.humanPrincipal(userId)
      if (principal) this.revokePrincipalTokens(principal.id, `账号冻结联动：${reason}`)
    })
    ctx.platformBus.on(PlatformEvents.AgentOfflined, (payload) => {
      const { id } = payload as { id: string }
      for (const principal of this.principals().find((item) => item.refType === 'agent' && item.refId === id)) {
        this.disablePrincipal(principal.id, 'Agent 下线联动')
      }
    })
    ctx.platformBus.on(PlatformEvents.AppOfflined, (payload) => {
      const { id } = payload as { id: string }
      for (const principal of this.principals().find((item) => item.refType === 'app' && item.refId === id)) {
        this.disablePrincipal(principal.id, '应用下线联动')
      }
    })
  }

  principals(): Collection<PrincipalRecord> {
    return this.ctx.storage.collection<PrincipalRecord>('authn:principals')
  }

  tokens(): Collection<TokenRecord> {
    return this.ctx.storage.collection<TokenRecord>('authn:tokens')
  }

  private loadOrCreateSecret(): string {
    const file = join(this.ctx.storage.dataDirPath, 'authn-signing-secret')
    try {
      if (existsSync(file)) return readFileSync(file, 'utf8').trim()
      mkdirSync(this.ctx.storage.dataDirPath, { recursive: true })
      const secret = generateSecret('sign')
      writeFileSync(file, secret, { encoding: 'utf8', mode: 0o600 })
      return secret
    } catch {
      return generateSecret('sign')
    }
  }

  /** 轮换签名密钥：现有令牌在宽限期后失效（演示实现为立即失效并留痕）。 */
  rotateSigningSecret(): void {
    this.signingSecret = generateSecret('sign')
    const file = join(this.ctx.storage.dataDirPath, 'authn-signing-secret')
    writeFileSync(file, this.signingSecret, 'utf8')
    for (const token of this.tokens().all()) {
      if (!token.revokedAt) {
        this.revocations.add(token.jti)
        this.tokens().update(token.id, { revokedAt: new Date().toISOString(), revokedReason: '签名密钥轮换' })
      }
    }
  }

  // -- Principal ----------------------------------------------------------

  humanPrincipal(userId: string): PrincipalRecord | undefined {
    return this.principals().findOne((item) => item.type === 'human' && item.refId === userId)
  }

  ensureHumanPrincipal(userId: string, name: string): PrincipalRecord {
    const existing = this.humanPrincipal(userId)
    if (existing) return existing
    return this.principals().insert({
      id: newId('pri'),
      type: 'human',
      refType: 'user',
      refId: userId,
      name,
      status: 'active',
      scopes: [],
    })
  }

  /** 创建机器身份凭证（Client Credentials）。secret 仅返回一次。 */
  createMachineCredential(input: {
    name: string
    refType?: 'agent' | 'app' | 'external'
    refId?: string
    scopes: string[]
  }): { principal: PrincipalRecord; clientId: string; clientSecret: string } {
    const clientId = `mc-${newId('id').slice(3)}`
    const clientSecret = generateSecret('cs')
    const principal = this.principals().insert({
      id: newId('pri'),
      type: 'machine',
      ...(input.refType !== undefined ? { refType: input.refType } : {}),
      ...(input.refId !== undefined ? { refId: input.refId } : {}),
      name: input.name,
      status: 'active',
      clientId,
      clientSecretHash: sha256Hex(clientSecret),
      scopes: input.scopes,
    })
    return { principal, clientId, clientSecret }
  }

  disablePrincipal(id: string, reason: string): PrincipalRecord {
    const principal = this.principals().get(id)
    if (!principal) throw new Error(`身份不存在：${id}`)
    this.revokePrincipalTokens(id, reason)
    return this.principals().update(id, { status: 'disabled' })
  }

  enablePrincipal(id: string): PrincipalRecord {
    return this.principals().update(id, { status: 'active' })
  }

  // -- 登录 ---------------------------------------------------------------

  login(username: string, password: string): { token: string; record: TokenRecord; principal: PrincipalRecord; userId: string } {
    const user = this.ctx.iam.verifyPassword(username, password)
    const principal = this.ensureHumanPrincipal(user.id, user.displayName)
    const { token, record } = this.issueToken(principal.id, {
      kind: 'access',
      ttlHours: 2,
      scopes: [],
      issuedBy: `password:${username}`,
    })
    this.ctx.iam.markLogin(user.id)
    this.ctx.platformBus.emit(PlatformEvents.TokenIssued, { jti: record.jti, principalId: principal.id, kind: 'access' })
    return { token, record, principal, userId: user.id }
  }

  /** 三方扫码/免密登录（演示：code = 三方 unionId 或工号）。 */
  loginByThirdParty(provider: string, code: string): { token: string; record: TokenRecord; principal: PrincipalRecord; userId: string } {
    const user = this.ctx.iam.users().findOne((candidate) =>
      candidate.bindings.some((binding) => binding.provider === provider && (binding.unionId === code || binding.displayName === code))
      || candidate.jobNumber === code)
    if (!user) throw new Error(`${provider} 免密登录失败：未找到绑定 ${code} 的平台账号（首次使用请先在个人中心绑定）`)
    if (user.status !== 'active') throw new Error('账号状态异常，无法登录')
    const principal = this.ensureHumanPrincipal(user.id, user.displayName)
    const { token, record } = this.issueToken(principal.id, {
      kind: 'access',
      ttlHours: 2,
      scopes: [],
      issuedBy: `sso:${provider}`,
    })
    this.ctx.iam.markLogin(user.id)
    this.ctx.platformBus.emit(PlatformEvents.TokenIssued, { jti: record.jti, principalId: principal.id, kind: 'access' })
    return { token, record, principal, userId: user.id }
  }

  clientCredentialsLogin(clientId: string, clientSecret: string): { token: string; record: TokenRecord; principal: PrincipalRecord } {
    const principal = this.principals().findOne((item) => item.clientId === clientId)
    if (!principal || principal.clientSecretHash !== sha256Hex(clientSecret)) {
      throw new Error('client_id 或 client_secret 错误')
    }
    if (principal.status !== 'active') throw new Error('机器身份已禁用')
    const { token, record } = this.issueToken(principal.id, {
      kind: 'machine',
      ttlHours: 2,
      scopes: principal.scopes,
      issuedBy: 'client_credentials',
    })
    this.ctx.platformBus.emit(PlatformEvents.TokenIssued, { jti: record.jti, principalId: principal.id, kind: 'machine' })
    return { token, record, principal }
  }

  // -- 令牌 ---------------------------------------------------------------

  issueToken(principalId: string, options: {
    kind: TokenRecord['kind']
    ttlHours?: number
    scopes?: string[]
    actChain?: ActEntry[]
    issuedBy?: string
  }): { token: string; record: TokenRecord } {
    const principal = this.principals().get(principalId)
    if (!principal) throw new Error(`身份不存在：${principalId}`)
    if (principal.status !== 'active') throw new Error('身份已禁用，无法签发令牌')
    const jti = randomUUID()
    const issuedAt = new Date()
    const expiresAt = new Date(issuedAt.getTime() + (options.ttlHours ?? 2) * 3600_000)
    const payload = {
      iss: 'dsh-ops-authn',
      sub: principal.id,
      typ: options.kind,
      jti,
      iat: Math.floor(issuedAt.getTime() / 1000),
      exp: Math.floor(expiresAt.getTime() / 1000),
      scope: options.scopes ?? [],
      act: options.actChain ?? [],
    }
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const sig = createHmac('sha256', this.signingSecret).update(body).digest('base64url')
    const token = `dst1.${body}.${sig}`
    const record = this.tokens().insert({
      id: jti,
      jti,
      principalId,
      kind: options.kind,
      scopes: options.scopes ?? [],
      actChain: options.actChain ?? [],
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      issuedBy: options.issuedBy ?? 'api',
    })
    return { token, record }
  }

  /** on-behalf-of：以当前主体身份为另一主体签发透传令牌（act 链叠加）。 */
  issueOnBehalfOf(parent: VerifiedPrincipal, targetPrincipalId: string): { token: string; record: TokenRecord } {
    const target = this.principals().get(targetPrincipalId)
    if (!target) throw new Error(`目标身份不存在：${targetPrincipalId}`)
    const actChain: ActEntry[] = [
      ...parent.actChain,
      { principalId: parent.principal.id, name: parent.principal.name, type: parent.principal.type },
    ]
    return this.issueToken(targetPrincipalId, {
      kind: 'machine',
      ttlHours: 1,
      scopes: intersectScopes(parent.scopes, target.scopes),
      actChain,
      issuedBy: `obo:${parent.principal.id}`,
    })
  }

  verify(tokenString: string): VerifiedPrincipal {
    const parts = tokenString.split('.')
    if (parts.length !== 3 || parts[0] !== 'dst1') throw new Error('令牌格式不合法')
    const expected = createHmac('sha256', this.signingSecret).update(parts[1]!).digest('base64url')
    if (expected !== parts[2]) throw new Error('令牌签名校验失败')
    let payload: any
    try {
      payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'))
    } catch {
      throw new Error('令牌载荷解析失败')
    }
    if (payload.exp * 1000 < Date.now()) throw new Error('令牌已过期')
    if (this.revocations.has(payload.jti)) throw new Error('令牌已被吊销')
    const record = this.tokens().get(payload.jti)
    if (!record) throw new Error('令牌不存在或已被清理')
    if (record.revokedAt) throw new Error(`令牌已被吊销：${record.revokedReason ?? '策略吊销'}`)
    const principal = this.principals().get(record.principalId)
    if (!principal) throw new Error('令牌主体不存在')
    if (principal.status !== 'active') throw new Error('令牌主体已禁用')
    const scopes = principal.type === 'human'
      ? this.ctx.iam.userPermissions(principal.refId ?? '')
      : record.scopes
    this.tokens().update(record.id, { lastUsedAt: new Date().toISOString() })
    return { principal, token: record, scopes, actChain: record.actChain }
  }

  hasPermission(verified: VerifiedPrincipal, point: string): boolean {
    return verified.scopes.includes('*') || verified.scopes.includes(point)
  }

  revokeToken(jti: string, reason: string): TokenRecord {
    const record = this.tokens().get(jti)
    if (!record) throw new Error(`令牌不存在：${jti}`)
    if (record.revokedAt) return record
    this.revocations.add(jti)
    const updated = this.tokens().update(record.id, {
      revokedAt: new Date().toISOString(),
      revokedReason: reason,
    })
    this.ctx.platformBus.emit(PlatformEvents.TokenRevoked, { jti, principalId: record.principalId, reason })
    return updated
  }

  revokePrincipalTokens(principalId: string, reason: string): number {
    let count = 0
    for (const token of this.tokens().find((item) => item.principalId === principalId && !item.revokedAt)) {
      this.revokeToken(token.jti, reason)
      count++
    }
    return count
  }

  activeTokenCount(principalId: string): number {
    return this.tokens().find((item) => item.principalId === principalId && !item.revokedAt).length
  }
}

function intersectScopes(a: string[], b: string[]): string[] {
  if (a.includes('*')) return [...b]
  if (b.includes('*')) return [...a]
  const setB = new Set(b)
  return a.filter((scope) => setB.has(scope))
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/cordis' {
  interface Context {
    authn: AuthnService
  }
}

export const name = 'authn'
export const inject = ['storage', 'platformBus', 'iam']

export function apply(ctx: Context) {
  ctx.plugin(AuthnService)
  ctx.plugin(authnTools)
}
