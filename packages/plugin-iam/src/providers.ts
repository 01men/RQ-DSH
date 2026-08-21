/**
 * IdentityProviderAdapter —— 统一身份源适配层（融合自 OS-skill/auth-identity 模块设计）。
 *
 * 登录主流程只面向本接口编程，不感知钉钉/飞书/企微差异；
 * 新增身份源 = 新增一个 Adapter 实现 + 连接器配置插一行。
 * 演示环境内置钉钉 Mock Adapter：接口与官方 OpenAPI 归一化抽象对齐，
 * 接入真实环境时仅替换 exchangeCode/getUserInfo 的 HTTP 实现与凭证配置。
 */

/** 登录场景：四种形态归一为三类（auth-identity docs/04）。 */
export type LoginScene = 'web_qr' | 'h5' | 'in_app'

/** 归一化后的自然人档案——登录主流程只认这个结构。 */
export interface NormalizedProfile {
  /** 平台侧用户唯一键（优先 unionId：跨应用/跨企业同人标识）。 */
  providerUserId: string
  corpId: string
  name: string
  email?: string
  phone?: string
  avatar?: string
}

/** code 换到的令牌包裹（各家结构差异封在这里）。 */
export interface ProviderTokenSet {
  accessToken: string
  refreshToken?: string
  expiresIn: number
  raw: unknown
}

export class ProviderAuthError extends Error {
  readonly code: string
  constructor(message: string, code = 'PROVIDER_AUTH_FAILED') {
    super(message)
    this.code = code
  }
}

export interface IdentityProviderAdapter {
  readonly type: 'dingtalk' | 'feishu' | 'wecom'
  readonly label: string
  /** 构造授权跳转 URL 或二维码内容（in_app 场景可返回 null，由前端 SDK 取 code）。 */
  buildAuthorizeUrl(scene: LoginScene, state: string, redirectUri: string): Promise<string | null>
  /** code → 平台令牌。code 单次消费，失败/过期抛 ProviderAuthError。 */
  exchangeCode(code: string): Promise<ProviderTokenSet>
  /** 平台令牌 → 原始档案。 */
  getUserInfo(tokenSet: ProviderTokenSet): Promise<unknown>
  /** 原始档案 → 归一化档案（三家差异的最终收敛点）。 */
  normalizeProfile(raw: unknown): NormalizedProfile
}

/** 钉钉模拟目录（与 OrgConnector 共享同一份远端数据）。 */
export const DINGTALK_DIRECTORY = {
  corpId: 'ding-yuanbingke',
  users: [
    { unionId: 'dd_u001', name: '陈远舟', jobNumber: 'DD0001', email: 'chenyz@yuanbingke.com' },
    { unionId: 'dd_u002', name: '林小满', jobNumber: 'DD0002', email: 'linxm@yuanbingke.com' },
    { unionId: 'dd_u003', name: '周既白', jobNumber: 'DD0003', email: 'zhoujb@yuanbingke.com' },
    { unionId: 'dd_u004', name: '苏砚秋', jobNumber: 'DD0004', email: 'suyq@yuanbingke.com' },
    { unionId: 'dd_u005', name: '何青梧', jobNumber: 'DD0005', email: 'heqw@yuanbingke.com' },
    { unionId: 'dd_u006', name: '顾星阑', jobNumber: 'DD0006', email: 'guxl@yuanbingke.com' },
    { unionId: 'dd_u007', name: '叶栖迟', jobNumber: 'DD0007', email: 'yqz@yuanbingke.com' },
  ],
} as const

/** code 一次性消费窗口：窗口内重放拒绝，窗口外视为新授权码周期（演示友好且语义正确）。 */
const CODE_TTL_MS = 5 * 60_000

/** 钉钉 Auth Adapter（Mock）：code = 工号或 unionId，模拟「扫码」动作。 */
export class DingTalkAuthAdapter implements IdentityProviderAdapter {
  readonly type = 'dingtalk' as const
  readonly label = '钉钉'
  private consumedCodes = new Map<string, number>()

  async buildAuthorizeUrl(scene: LoginScene, state: string, redirectUri: string): Promise<string | null> {
    if (scene === 'in_app') return null
    const params = new URLSearchParams({
      client_id: 'demo-app-key',
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid corpid',
      state,
      prompt: 'consent',
    })
    return `https://login.dingtalk.com/oauth2/auth?${params}`
  }

  async exchangeCode(code: string): Promise<ProviderTokenSet> {
    const consumedAt = this.consumedCodes.get(code)
    const now = Date.now()
    if (consumedAt !== undefined && now - consumedAt < CODE_TTL_MS) {
      throw new ProviderAuthError('授权码已被使用（code 仅可消费一次）', 'CODE_REPLAY')
    }
    const user = DINGTALK_DIRECTORY.users.find((item) => item.jobNumber === code || item.unionId === code)
    if (!user) throw new ProviderAuthError('授权码无效或已过期', 'INVALID_CODE')
    this.consumedCodes.set(code, now)
    return {
      accessToken: `mock-user-token-${user.unionId}-${now}`,
      expiresIn: 7200,
      raw: { unionId: user.unionId, code },
    }
  }

  async getUserInfo(tokenSet: ProviderTokenSet): Promise<unknown> {
    const raw = tokenSet.raw as { unionId: string }
    const user = DINGTALK_DIRECTORY.users.find((item) => item.unionId === raw.unionId)
    if (!user) throw new ProviderAuthError('用户档案不存在', 'PROFILE_NOT_FOUND')
    return { ...user, corpId: DINGTALK_DIRECTORY.corpId }
  }

  normalizeProfile(raw: unknown): NormalizedProfile {
    const record = raw as { unionId: string; name: string; email?: string; corpId: string }
    return {
      providerUserId: record.unionId,
      corpId: record.corpId,
      name: record.name,
      ...(record.email !== undefined ? { email: record.email } : {}),
    }
  }
}
