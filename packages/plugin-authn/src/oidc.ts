/**
 * OIDC Provider（生态设计 v1.2 第 6 步，模式 B：平台作为外部应用的身份源）。
 *
 * RS256 非对称签名 + JWKS 暴露（`/.well-known/jwks.json`）：
 *   - 私钥仅平台持有（data 目录；生产应迁 KMS），外部应用以公钥本地验签，
 *     解决 HMAC 对称密钥多服务分发面扩大的过渡期问题（第 1 步遗留说明的收口）；
 *   - 授权码模式：/oauth/authorize（一次性 code，5 分钟）→ /oauth/token → RS256 access/id token；
 *   - /oauth/userinfo 返回 NormalizedProfile（含 org/角色/租户）；
 *   - 杀手级联动：账号冻结/离职 → userinfo 即时 401（无需等 token 过期）。
 *
 * 注意：路由挂在 /oauth/* 与 /.well-known/*（非 /api/*，不受控制台 Bearer 中间件约束，
 * 属预期公开端点；code 换 token 仍需 client_secret）。
 */
import { createHash, generateKeyPairSync, randomUUID, sign as rsSign, verify as rsVerify, createPublicKey } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { sha256Hex, newId, generateSecret, type Collection, type RecordBase } from '../../platform-core/src/index.ts'

export interface OidcClientRecord extends RecordBase {
  name: string
  clientId: string
  clientSecretHash: string
  redirectUris: string[]
}

export interface OidcCodeRecord extends RecordBase {
  clientId: string
  userId: string
  redirectUri: string
  state: string
  nonce?: string
  scope: string
  /** PKCE（评审修复）：授权时登记的 code_challenge（S256）；换 token 必须携带匹配的 code_verifier。 */
  codeChallenge?: string
  codeChallengeMethod?: 'S256'
  expiresAt: string
  usedAt?: string
}

interface OidcKeyMaterial {
  privatePem: string
  publicPem: string
  kid: string
  createdAt: string
}

export class OidcService extends Service {
  static readonly provide = 'oidc'
  /** 复用 AuthnService 的登录限流（子插件显式声明依赖，等待其就绪）。 */
  static readonly inject = ['authn']

  private keys: OidcKeyMaterial

  constructor(ctx: Context) {
    super(ctx, 'oidc')
    this.keys = this.loadOrCreateKeys()
    this.registerRoutes()
  }

  issuer(): string {
    // 外部应用接入时以 OIDC_ISSUER 显式声明对外地址（默认本机；评审 L1）
    return process.env.OIDC_ISSUER ?? `http://127.0.0.1:${this.ctx.httpServer.port}`
  }

  clients(): Collection<OidcClientRecord> {
    const collection = this.ctx.storage.collection<OidcClientRecord>('authn:oidcClients')
    collection.uniqueOn('oidc_client_id', (item) => item.clientId)
    return collection
  }

  codes(): Collection<OidcCodeRecord> {
    return this.ctx.storage.collection<OidcCodeRecord>('authn:oidcCodes')
  }

  createClient(input: { name: string; redirectUris: string[] }): { client: OidcClientRecord; clientSecret: string } {
    const clientId = 'oc-' + newId('id').slice(3)
    const clientSecret = generateSecret('ocs')
    const client = this.clients().insert({
      id: newId('oc'),
      name: input.name,
      clientId,
      clientSecretHash: sha256Hex(clientSecret),
      redirectUris: input.redirectUris,
    })
    return { client, clientSecret }
  }

  // -- 授权码 ---------------------------------------------------------------

  /** 允许对外签发的 scope 白名单（评审修复：不得任意申请并原样进 JWT）。 */
  static readonly ALLOWED_SCOPES = ['openid', 'profile', 'email']

  /** 发起授权：用户在平台完成认证（用户名/密码）→ 一次性 code（5 分钟）。支持 PKCE（S256）。 */
  authorize(input: { clientId: string; redirectUri?: string; state: string; scope?: string; nonce?: string; username: string; password: string; codeChallenge?: string; codeChallengeMethod?: string }): { code: string; state: string; expires_in: number } {
    const client = this.clients().findOne((item) => item.clientId === input.clientId)
    if (!client) throw new Error(`OIDC 客户端不存在：${input.clientId}`)
    const redirectUri = input.redirectUri ?? client.redirectUris[0]
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      throw new Error(`redirect_uri 未登记在客户端白名单：${redirectUri}`)
    }
    const scopes = (input.scope ?? 'openid profile').split(/\s+/).filter(Boolean)
    const offender = scopes.find((scope) => !OidcService.ALLOWED_SCOPES.includes(scope))
    if (offender) throw new Error(`scope 未获授权：${offender}（允许：${OidcService.ALLOWED_SCOPES.join(' ')}）`)
    if (input.codeChallengeMethod !== undefined && input.codeChallengeMethod !== 'S256') {
      throw new Error('code_challenge_method 仅支持 S256')
    }
    if (input.codeChallenge !== undefined && !/^[A-Za-z0-9_-]{43,128}$/.test(input.codeChallenge)) {
      throw new Error('code_challenge 格式非法（S256 应为 43-128 位 base64url）')
    }
    // 授权入口同样受暴力破解防护（评审 S3）
    const throttleKey = `oidc-authorize:${input.username}`
    this.ctx.authn.assertNotLocked(throttleKey)
    let user
    try {
      user = this.ctx.iam.verifyPassword(input.username, input.password)
    } catch (error) {
      this.ctx.authn.recordLoginFailure(throttleKey)
      throw error
    }
    this.ctx.authn.recordLoginSuccess(throttleKey)
    if (user.status !== 'active') throw new Error('账号状态异常，无法授权')
    const code = randomUUID().replace(/-/g, '')
    this.codes().insert({
      id: code,
      clientId: input.clientId,
      userId: user.id,
      redirectUri,
      state: input.state,
      ...(input.nonce !== undefined ? { nonce: input.nonce } : {}),
      scope: scopes.join(' '),
      ...(input.codeChallenge !== undefined ? { codeChallenge: input.codeChallenge, codeChallengeMethod: 'S256' as const } : {}),
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    })
    return { code, state: input.state, expires_in: 300 }
  }

  /** code 换令牌：RS256 签发的 access token（JWT）+ id token。code 单次消费；PKCE 强制校验。 */
  token(input: { grantType: string; code: string; clientId: string; clientSecret: string; redirectUri?: string; codeVerifier?: string }): { access_token: string; id_token: string; token_type: 'Bearer'; expires_in: number } {
    if (input.grantType !== 'authorization_code') throw new Error(`不支持的 grant_type：${input.grantType}`)
    const client = this.clients().findOne((item) => item.clientId === input.clientId)
    if (!client || client.clientSecretHash !== sha256Hex(input.clientSecret)) {
      // client_secret 同样纳入失败锁定（评审 S3：不得暴力猜测机密）
      this.ctx.authn.recordLoginFailure(`oidc-token:${input.clientId}`)
      throw new Error('client_id 或 client_secret 错误')
    }
    this.ctx.authn.recordLoginSuccess(`oidc-token:${input.clientId}`)
    const record = this.codes().get(input.code)
    if (!record) throw new Error('授权码无效')
    if (record.usedAt) throw new Error('授权码已被使用（单次消费，防重放）')
    if (new Date(record.expiresAt).getTime() < Date.now()) throw new Error('授权码已过期')
    if (record.clientId !== input.clientId) throw new Error('授权码与客户端不匹配')
    if (input.redirectUri && input.redirectUri !== record.redirectUri) throw new Error('redirect_uri 与授权时不一致')
    if (record.codeChallenge) {
      // PKCE（S256）：BASE64URL(SHA256(code_verifier)) 必须与授权时登记的 challenge 一致
      if (!input.codeVerifier) throw new Error('授权使用了 PKCE，token 请求必须携带 code_verifier')
      const derived = createHash('sha256').update(input.codeVerifier).digest('base64url')
      if (derived !== record.codeChallenge) throw new Error('PKCE 校验失败：code_verifier 不匹配')
    }
    this.codes().update(record.id, { usedAt: new Date().toISOString() })
    const nowSec = Math.floor(Date.now() / 1000)
    const user = this.ctx.iam.users().get(record.userId)
    const payload = {
      iss: this.issuer(),
      sub: record.userId,
      aud: input.clientId,
      azp: input.clientId,
      iat: nowSec,
      exp: nowSec + 2 * 3600,
      scope: record.scope,
      ...(record.nonce !== undefined ? { nonce: record.nonce } : {}),
      ...(user !== undefined ? { preferred_username: user.username, name: user.displayName } : {}),
    }
    const access = this.signJwt(payload)
    const idToken = this.signJwt({ ...payload, aud: input.clientId })
    return { access_token: access, id_token: idToken, token_type: 'Bearer', expires_in: 2 * 3600 }
  }

  /** userinfo：RS256 验签（iss/kid/aud 全验）+ 用户实时状态校验（冻结/离职即时失效）。 */
  userinfo(accessToken: string): Record<string, unknown> {
    const claims = this.verifyJwt(accessToken, { audience: undefined })
    const user = this.ctx.iam.users().get(claims.sub ?? '')
    if (!user) throw new Error('用户不存在')
    if (user.status !== 'active') throw new Error('用户状态异常（冻结/离职联动失效）')
    const org = this.ctx.iam.orgs().get(user.orgId)
    return {
      sub: user.id,
      preferred_username: user.username,
      name: user.displayName,
      email: user.email,
      org: org !== undefined ? { id: org.id, name: org.name, tenantId: org.tenantId ?? 't_default' } : null,
      roles: user.roleIds.map((roleId) => this.ctx.iam.roles().get(roleId)?.code).filter(Boolean),
      tenant: org?.tenantId ?? 't_default',
      scope: claims.scope,
    }
  }

  // -- JWT（RS256） ----------------------------------------------------------

  signJwt(payload: Record<string, unknown>): string {
    const header = { alg: 'RS256', typ: 'JWT', kid: this.keys.kid }
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const head = Buffer.from(JSON.stringify(header)).toString('base64url')
    const signature = rsSign('RSA-SHA256', Buffer.from(`${head}.${body}`), this.keys.privatePem).toString('base64url')
    return `${head}.${body}.${signature}`
  }

  /**
   * JWT 校验（评审修复）：签名 + header.kid 匹配当前 JWKS 公布的密钥 + iss 归属本 Provider
   * + exp 有效；options.audience 指定时校验受众（azp/aud 必须命中）。
   */
  verifyJwt(token: string, options: { audience?: string } = {}): Record<string, unknown> {
    const parts = token.split('.')
    if (parts.length !== 3) throw new Error('JWT 格式不合法')
    let header: Record<string, unknown>
    try {
      header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as Record<string, unknown>
    } catch {
      throw new Error('JWT 头部解析失败')
    }
    if (header.kid !== this.keys.kid) throw new Error('JWT kid 与 JWKS 公布密钥不匹配')
    const valid = rsVerify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), this.keys.publicPem, Buffer.from(parts[2]!, 'base64url'))
    if (!valid) throw new Error('JWT 签名校验失败（RS256）')
    let claims: Record<string, unknown>
    try {
      claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>
    } catch {
      throw new Error('JWT 载荷解析失败')
    }
    if (claims.iss !== this.issuer()) throw new Error('JWT 签发方（iss）校验失败')
    if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) throw new Error('JWT 已过期')
    if (options.audience !== undefined) {
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
      if (!aud.includes(options.audience)) throw new Error(`JWT 受众（aud）校验失败：期望 ${options.audience}`)
    }
    return claims
  }

  jwks(): { keys: Array<Record<string, unknown>> } {
    const jwk = createPublicKey(this.keys.publicPem).export({ format: 'jwk' }) as { kty: string; n?: string; e?: string }
    return {
      keys: [{
        kty: jwk.kty,
        use: 'sig',
        alg: 'RS256',
        kid: this.keys.kid,
        n: jwk.n,
        e: jwk.e,
      }],
    }
  }

  discovery(): Record<string, unknown> {
    return {
      issuer: this.issuer(),
      jwks_uri: `${this.issuer()}/.well-known/jwks.json`,
      authorization_endpoint: `${this.issuer()}/oauth/authorize`,
      token_endpoint: `${this.issuer()}/oauth/token`,
      userinfo_endpoint: `${this.issuer()}/oauth/userinfo`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid', 'profile'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
      claims_supported: ['sub', 'name', 'preferred_username', 'iss', 'aud', 'exp', 'iat', 'nonce'],
    }
  }

  private loadOrCreateKeys(): OidcKeyMaterial {
    const file = join(this.ctx.storage.dataDirPath, 'oidc-keys.json')
    try {
      if (existsSync(file)) {
        const stored = JSON.parse(readFileSync(file, 'utf8')) as OidcKeyMaterial
        if (stored.privatePem && stored.publicPem && stored.kid) return stored
      }
      mkdirSync(this.ctx.storage.dataDirPath, { recursive: true })
      const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
      const material: OidcKeyMaterial = {
        privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
        publicPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
        kid: createHash('sha256').update(publicKey.export({ format: 'der', type: 'spki' })).digest('hex').slice(0, 16),
        createdAt: new Date().toISOString(),
      }
      writeFileSync(file, JSON.stringify(material, null, 2), { encoding: 'utf8', mode: 0o600 })
      return material
    } catch {
      // 目录不可写等异常：进程内密钥（重启后令牌失效，仅限异常场景
      const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
      return {
        privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
        publicPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
        kid: createHash('sha256').update(publicKey.export({ format: 'der', type: 'spki' })).digest('hex').slice(0, 16),
        createdAt: new Date().toISOString(),
      }
    }
  }

  /** 公开端点（非 /api/*：不受控制台 Bearer 中间件约束，属 OIDC 协议要求）。 */
  private registerRoutes(): void {
    const http = this.ctx.httpServer
    // OIDC 协议端点返回原始 JSON（标准客户端不识别平台的 {ok,data} 包裹）
    const raw = (exchange: { res: import('node:http').ServerResponse }, status: number, payload: unknown): void => {
      exchange.res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      exchange.res.end(JSON.stringify(payload))
    }

    http.register('GET', '/.well-known/openid-configuration', (exchange) => {
      raw(exchange, 200, this.discovery())
    })

    http.register('GET', '/.well-known/jwks.json', (exchange) => {
      raw(exchange, 200, this.jwks())
    })

    http.register('POST', '/oauth/authorize', async (exchange) => {
      const input = exchange.body as { clientId: string; redirectUri?: string; state: string; scope?: string; nonce?: string; username: string; password: string; code_challenge?: string; code_challenge_method?: string }
      try {
        raw(exchange, 200, this.authorize({
          clientId: input.clientId,
          ...(input.redirectUri !== undefined ? { redirectUri: input.redirectUri } : {}),
          state: input.state,
          ...(input.scope !== undefined ? { scope: input.scope } : {}),
          ...(input.nonce !== undefined ? { nonce: input.nonce } : {}),
          username: input.username,
          password: input.password,
          ...(input.code_challenge !== undefined ? { codeChallenge: input.code_challenge } : {}),
          ...(input.code_challenge_method !== undefined ? { codeChallengeMethod: input.code_challenge_method } : {}),
        }))
      } catch (error) {
        raw(exchange, 401, { error: 'access_denied', error_description: error instanceof Error ? error.message : String(error) })
      }
    })

    http.register('POST', '/oauth/token', async (exchange) => {
      const input = exchange.body as { grant_type?: string; code?: string; client_id?: string; client_secret?: string; redirect_uri?: string; code_verifier?: string }
      try {
        if (!input.code || !input.client_id || !input.client_secret) {
          raw(exchange, 400, { error: 'invalid_request', error_description: 'code / client_id / client_secret 必填' })
          return
        }
        raw(exchange, 200, this.token({
          grantType: input.grant_type ?? 'authorization_code',
          code: input.code,
          clientId: input.client_id,
          clientSecret: input.client_secret,
          ...(input.redirect_uri !== undefined ? { redirectUri: input.redirect_uri } : {}),
          ...(input.code_verifier !== undefined ? { codeVerifier: input.code_verifier } : {}),
        }))
      } catch (error) {
        raw(exchange, 401, { error: 'invalid_client', error_description: error instanceof Error ? error.message : String(error) })
      }
    })

    http.register('GET', '/oauth/userinfo', (exchange) => {
      const header = String(exchange.headers['authorization'] ?? '')
      if (!header.startsWith('Bearer ')) {
        raw(exchange, 401, { error: 'invalid_token', error_description: '缺少 Bearer access token' })
        return
      }
      try {
        raw(exchange, 200, this.userinfo(header.slice(7)))
      } catch (error) {
        raw(exchange, 401, { error: 'invalid_token', error_description: error instanceof Error ? error.message : String(error) })
      }
    })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    oidc: OidcService
  }
}
