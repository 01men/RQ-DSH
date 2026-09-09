/**
 * 宿主连接服务（hostlink）——「装好插件即可用」的连接半部（M2 连接与登录）。
 *
 * 【定位】dsh 客户端装好插件后，向导/设置面/面板 SPA 都需要一个「本机如何到达榕器数据面」
 * 的统一答案。本服务给出三种模式：
 *   - none   ：未配置（全新 dsh 首启态）——前端渲染连接向导；
 *   - local  ：本机即宿主（形态 B，本插件与 platform-core 同进程），面板直连同源 /api；
 *   - remote ：连接远端宿主（形态 C）——面板 REST 经本服务内置代理转发远端，浏览器零跨域。
 *
 * 【端点命名空间】全部挂 /rqcard/*（非 /api/*）。这是刻意选择：console 鉴权中间件只拦
 * /api/*，向导必须在「登录之前」可用（选宿主、设 admin 口令都发生在持令牌之前），走
 * /rqcard/* 免登命名空间 + 自带防线，与 /api/panel/stream（公开路径 + 内部 token 自校验）、
 * /api/connect/enroll（接入码本身即凭证）同一安全族。
 *
 * 【自带防线（免登命名空间的义务）】
 *   1. 向导头：所有 /rqcard/* 请求必须带 `x-rqcard-call: 1`。自定义头跨站发不出
 *      （会触发 CORS 预检，而非 /api 路径不放行预检）——挡住恶意网页对
 *      127.0.0.1 向导端点的 drive-by CSRF（改宿主指向钓鱼服务器截获登录凭据）。
 *   2. 代理白名单：/rqcard/proxy/* 只转发 auth 族 + /api/panel/* + /api/health，
 *      白名单外 403；SSE（/api/panel/stream）不透传（前端走既有 30s 轮询降级）。
 *   3. 代理只透传 Authorization 头（不带 Cookie）、redirect: 'manual'（令牌不随 302 外泄）。
 *
 * 【配置落盘】<dataDir>/rq-host-link.json（0600，参照 connect-client.json 惯例）。
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { networkInterfaces } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { HttpExchange } from '../../platform-core/src/index.ts'

/** 持久化的宿主连接配置（对浏览器可见的形状：不含任何机密）。 */
export interface HostLinkConfig {
  /** none=未配置（首启向导态）；local=本机即宿主；remote=连接远端宿主。 */
  mode: 'none' | 'local' | 'remote'
  /** remote 模式下的宿主基址（如 http://192.168.1.5:3080）。 */
  hubBase?: string
  /** 宿主数据面挂载前缀：形态 B（dsh 挂载）为 '/rq'；形态 A（独立宿主）为 ''。探测时自动判定。 */
  hubMountPrefix?: string
  /** 连接备注名（向导里可读的标识）。 */
  label?: string
  savedAt?: string
}

/** 健康探测结果。 */
export interface HubProbe {
  reachable: boolean
  /** HTTP 状态码（不可达为 0）。 */
  status: number
  /** 宿主平台版本（/api/health 返回时透出）。 */
  version?: string
  /** 数据面挂载前缀（探测命中 '/rq' 或 ''）。 */
  mountPrefix?: string
}

/** 向导必须携带的调用头（CSRF 防线，见文件头注释第 1 条）。 */
export const RQCARD_CALL_HEADER = 'x-rqcard-call'

/** 代理白名单：精确路径。 */
const PROXY_ALLOW_EXACT = new Set([
  '/api/health',
  '/api/auth/login',
  '/api/auth/refresh',
  '/api/auth/me',
  '/api/auth/logout',
  '/api/auth/entry-ticket-session',
  '/api/authn/entry-tickets/redeem',
])

/** 代理白名单：前缀族（auth SSO 全族 + 面板 REST 全族）。 */
const PROXY_ALLOW_PREFIXES = ['/api/auth/sso', '/api/panel/']

/** 代理显式拒绝（白名单前缀内但不适合转发的路径）。 */
const PROXY_DENY_EXACT = new Set(['/api/panel/stream'])

/** 判定路径是否在代理白名单内。 */
export function proxyPathAllowed(path: string): boolean {
  if (PROXY_DENY_EXACT.has(path)) return false
  if (PROXY_ALLOW_EXACT.has(path)) return true
  return PROXY_ALLOW_PREFIXES.some((prefix) => path.startsWith(prefix))
}

/** LAN 扫描的默认候选端口（独立宿主 7300 / dsh web 3080）。 */
const DEFAULT_SCAN_PORTS = [7300, 3080]
/** 单探针超时（毫秒）——局域网内 350ms 足够判定，慢网靠手输兜底。 */
const PROBE_TIMEOUT_MS = 350
/** 代理转发超时（毫秒）。 */
const PROXY_TIMEOUT_MS = 30_000
/** 扫描候选总量上限（多网卡 /24 × 端口下的有界保证）。 */
const SCAN_CANDIDATE_LIMIT = 600

/** 规范化宿主基址：去尾斜杠、补 http://（与 connect 的 normalizeBaseUrl 同规）。 */
export function normalizeHubBase(input: string): string {
  let value = String(input ?? '').trim()
  if (value === '') throw new Error('宿主地址不能为空')
  // 非 http(s) 显式 scheme 先行拒绝（QA P2-O-1）：若先补 http:// 前缀，ftp://host 会被
  // 静默规范化成 http://ftp 并以「宿主不可达」误导用户，专属错误分支永不可达。
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value)
  if (scheme && !/^https?$/i.test(scheme[1]!)) throw new Error('宿主地址仅支持 http/https')
  if (!scheme) value = `http://${value}`
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('宿主地址仅支持 http/https')
  if (!url.hostname) throw new Error('宿主地址缺少主机名')
  return `${url.protocol}//${url.host}`.replace(/\/+$/, '')
}

export interface HostLinkOptions {
  /** 配置文件目录（默认与平台存储同目录）。 */
  dataDir?: string
  /** 扫描候选端口覆盖（测试注入用）。 */
  scanPorts?: number[]
}

export class HostLinkService {
  private readonly ctx: Context
  private configFile: string
  private config: HostLinkConfig
  private readonly scanPorts: number[]

  constructor(ctx: Context, options: HostLinkOptions = {}) {
    this.ctx = ctx
    this.configFile = join(options.dataDir ?? ctx.opsStorage.dataDirPath, 'rq-host-link.json')
    this.config = this.load()
    this.scanPorts = options.scanPorts ?? DEFAULT_SCAN_PORTS
  }

  /** 当前配置（对外只读）。 */
  getConfig(): Readonly<HostLinkConfig> {
    return this.config
  }

  /** 是否已连接（local/remote 均算；none=向导首启态）。 */
  isLinked(): boolean {
    return this.config.mode !== 'none'
  }

  // ---------------------------------------------------------------- 配置三通道

  /** 声明本机宿主模式（形态 B：本插件与数据面同进程，幂等）。 */
  setLocal(label?: string): HostLinkConfig {
    this.config = { mode: 'local', ...(label ? { label } : {}), savedAt: new Date().toISOString() }
    this.save()
    return this.config
  }

  /** 连接远端宿主（形态 C）：先探测（自动判定挂载前缀），可达才落盘。 */
  async setRemote(hubBaseInput: string, label?: string): Promise<{ config: HostLinkConfig; probe: HubProbe }> {
    const hubBase = normalizeHubBase(hubBaseInput)
    const probe = await this.probeHub(hubBase)
    if (!probe.reachable) {
      throw new Error(`宿主不可达：${hubBase}（健康检查无响应，请确认地址/端口/防火墙）`)
    }
    this.config = {
      mode: 'remote',
      hubBase,
      hubMountPrefix: probe.mountPrefix ?? '',
      ...(label ? { label } : {}),
      savedAt: new Date().toISOString(),
    }
    this.save()
    return { config: this.config, probe }
  }

  /** 断开：回到未配置态（远端连接凭据在浏览器侧，本服务无令牌可清）。 */
  reset(): HostLinkConfig {
    this.config = { mode: 'none' }
    this.save()
    return this.config
  }

  // ---------------------------------------------------------------- 探测与扫描

  /**
   * 探测宿主：依次试 `${base}/rq/api/health`（dsh 挂载形态）与 `${base}/api/health`（独立宿主）。
   * 命中即返回，携带自动判定的挂载前缀。
   *
   * 【严格判据（Bug1 修复）】独立宿主对 `/rq/api/health` 这类未匹配路径会以 SPA 兜底返回
   * 200 HTML——只看 HTTP 200 会把挂载前缀误判成 '/rq'（钉钉登录跳错地址、代理打错路径）。
   * 必须解析出健康 JSON 信封（ok===true）才算命中，HTML/非 JSON 一律视为该前缀不可用。
   */
  async probeHub(hubBase: string): Promise<HubProbe> {
    for (const mountPrefix of ['/rq', '']) {
      const url = `${hubBase}${mountPrefix}/api/health`
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS * 4), headers: { accept: 'application/json' } })
        if (!response.ok) continue
        const contentType = String(response.headers.get('content-type') ?? '')
        if (!contentType.includes('json')) continue
        const payload = await response.json().catch(() => null) as { ok?: boolean; data?: { version?: string } } | null
        if (payload?.ok !== true) continue
        return { reachable: true, status: response.status, version: payload.data?.version, mountPrefix }
      } catch { /* 该前缀不可达，试下一个 */ }
    }
    return { reachable: false, status: 0 }
  }

  /**
   * 局域网扫描：各 IPv4 网卡 /24 网段 × 候选端口，并行短超时探活。
   * @param candidates 显式候选（测试注入 / 向导历史地址），缺省按网卡推导。
   */
  async scan(candidates?: string[]): Promise<{ hosts: Array<{ endpoint: string; mountPrefix: string; version?: string }>; scanned: number }> {
    let list: string[]
    if (Array.isArray(candidates) && candidates.length > 0) {
      list = candidates.map((item) => normalizeHubBase(String(item)))
    } else {
      const seen = new Set<string>()
      list = []
      for (const addrs of Object.values(networkInterfaces())) {
        for (const addr of addrs ?? []) {
          if (addr.family !== 'IPv4' || addr.internal) continue
          const base = addr.address.split('.').slice(0, 3).join('.')
          for (let host = 1; host <= 254; host++) {
            for (const port of this.scanPorts) {
              const endpoint = `http://${base}.${host}:${port}`
              if (!seen.has(endpoint)) { seen.add(endpoint); list.push(endpoint) }
            }
          }
        }
      }
    }
    const bounded = list.slice(0, SCAN_CANDIDATE_LIMIT)
    const found: Array<{ endpoint: string; mountPrefix: string; version?: string }> = []
    await Promise.all(bounded.map(async (endpoint) => {
      const probe = await this.probeHub(endpoint).catch(() => null)
      if (probe?.reachable) found.push({ endpoint, mountPrefix: probe.mountPrefix ?? '', version: probe.version })
    }))
    return { hosts: found, scanned: bounded.length }
  }

  // ---------------------------------------------------------------- 代理（remote 模式数据面）

  /**
   * 把一次面板/auth 请求转发到远端宿主。白名单校验先于模式校验（未连接时
   * 白名单外路径同样回 403 PROXY_PATH_DENIED，语义不随连接状态漂移）。
   * 返回给 dispatch 的处理结果由调用方（中间件包装）写回响应。
   */
  async proxy(exchange: HttpExchange): Promise<void> {
    const path = exchange.path.replace(/^\/rqcard\/proxy/, '') || '/'
    if (!proxyPathAllowed(path)) {
      exchange.fail(403, 'PROXY_PATH_DENIED', `代理白名单之外的路由：${path}`)
      return
    }
    if (this.config.mode !== 'remote' || !this.config.hubBase) {
      exchange.fail(409, 'NOT_REMOTE', '当前不是远端连接模式（先在向导里选择并连接宿主）')
      return
    }
    const query = exchange.query.toString()
    // 远端登录入口（钉钉扫码页）按宿主真实挂载前缀构造——前缀判定由 probeHub 严格判据保证
    const target = `${this.config.hubBase}${this.config.hubMountPrefix ?? ''}${path}${query ? `?${query}` : ''}`
    const headers: Record<string, string> = { accept: 'application/json' }
    const authorization = exchange.headers.authorization
    if (authorization !== undefined) headers.authorization = String(authorization)
    let bodyText: string | undefined
    if (exchange.body !== undefined) {
      bodyText = typeof exchange.body === 'string' ? exchange.body : JSON.stringify(exchange.body)
      headers['content-type'] = 'application/json'
    }
    let response: Response
    try {
      response = await fetch(target, {
        method: exchange.method === 'HEAD' ? 'GET' : exchange.method,
        headers,
        body: bodyText,
        redirect: 'manual',
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      exchange.fail(502, 'HUB_UNREACHABLE', `远端宿主不可达：${message}`)
      return
    }
    // 宿主数据面只会回 JSON；拿到 HTML 说明地址/挂载前缀不对（SPA 兜底）——透传只会让
    // 前端把整页 HTML 当接口数据渲染，显式报错比静默错乱好（Bug1 的第二道防线）。
    const responseContentType = String(response.headers.get('content-type') ?? '')
    if (responseContentType.includes('text/html')) {
      exchange.fail(502, 'HUB_BAD_RESPONSE', '宿主返回了 HTML 而非 JSON（地址或挂载前缀可能不匹配，请在向导里重新测试连接）')
      return
    }
    const text = await response.text().catch(() => '')
    if (!exchange.res.writableEnded) {
      const headers: Record<string, string> = { 'content-type': String(response.headers.get('content-type') ?? 'application/json; charset=utf-8') }
      // 3xx Location 透传（QA T-02）：redirect:'manual' 下宿主 302（如 /api/auth/sso 登录跳转）
      // 的 location 若被静默丢弃，登录回跳链路将无声断裂——要么完整透传，要么别用 manual。
      const location = response.headers.get('location')
      if (response.status >= 300 && response.status < 400 && location) headers.location = location
      exchange.res.writeHead(response.status, headers)
      exchange.res.end(text)
    }
  }

  // ---------------------------------------------------------------- 本机初始化（形态 B 首启）

  /** admin 初始口令文件路径（console seed 在首启时一次性写入）。 */
  private initialPasswordFile(): string {
    return join(this.ctx.opsStorage.dataDirPath, 'admin-initial-password.txt')
  }

  /** 是否本机首启（admin 初始口令文件在场 = 尚无人登录过）。 */
  localFirstRun(): boolean {
    return existsSync(this.initialPasswordFile())
  }

  /** 本机对外候选地址（向导「选择 IP」数据源：非内部 IPv4 网卡）。 */
  localInterfaces(): Array<{ address: string; iface: string }> {
    const out: Array<{ address: string; iface: string }> = []
    for (const [iface, addrs] of Object.entries(networkInterfaces())) {
      for (const addr of addrs ?? []) {
        if (addr.family === 'IPv4' && !addr.internal) out.push({ address: addr.address, iface })
      }
    }
    return out
  }

  /**
   * 本机首启 admin 口令初始化：服务端读取一次性初始口令完成首登 + 改密 + 重登，
   * 口令全程不出服务端；成功后删除初始口令文件（防重放）。
   * 返回形状与 console /api/auth/login 对齐（面板 saveSession 直接可用）。
   */
  localInitAdmin(newPassword: string, username = 'admin'): Record<string, unknown> {
    const file = this.initialPasswordFile()
    if (!existsSync(file)) {
      throw new Error('初始化向导仅首次启动可用（初始口令文件已消费或不存在；请用常规登录）')
    }
    if (typeof newPassword !== 'string' || newPassword.trim().length < 8) throw new Error('新口令长度不得少于 8 位')
    if (/[\u4e00-\u9fff]/.test(newPassword)) throw new Error('口令不得包含中文')
    // 文件格式（console seed）：首行为中文标签说明行，口令在其后——过滤标签行取口令
    const initialPassword = readFileSync(file, 'utf8').split(/\r?\n/).map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('平台管理员'))[0] ?? ''
    if (initialPassword === '') throw new Error('初始口令文件为空，请用常规登录后自行改密')
    const first = this.ctx.authn.login(username, initialPassword)
    this.ctx.iam.resetPassword(first.userId, newPassword)
    // 一次性消费（防重放，QA SEC-05）：必须用 unlinkSync——Windows 实测 rmSync(force:true)
    // 会静默失败（不抛错、文件原地不动），口令文件残留=初始口令可被重放，防线破。
    try { unlinkSync(file) } catch { /* 文件已被并发消费 */ }
    const session = this.ctx.authn.login(username, newPassword)
    return {
      token: session.token,
      refreshToken: session.refreshToken,
      expiresAt: session.record.expiresAt,
      user: this.userPayload(session.userId),
    }
  }

  /** 组装与 console /api/auth/login 同形的 user 载荷。 */
  private userPayload(userId: string): Record<string, unknown> {
    const user = this.ctx.iam.users().get(userId)
    if (!user) throw new Error('用户不存在')
    return {
      id: user.id, username: user.username, displayName: user.displayName,
      orgId: user.orgId, roleIds: user.roleIds,
      roles: user.roleIds.map((roleId) => this.ctx.iam.roles().get(roleId)?.name).filter(Boolean),
      permissions: this.ctx.iam.userPermissions(user.id),
    }
  }

  // ---------------------------------------------------------------- 落盘

  private load(): HostLinkConfig {
    try {
      const raw = readFileSync(this.configFile, 'utf8')
      const parsed = JSON.parse(raw) as HostLinkConfig
      if (parsed && (parsed.mode === 'none' || parsed.mode === 'local' || parsed.mode === 'remote')) return parsed
    } catch { /* 无配置/坏配置一律回到首启态 */ }
    return { mode: 'none' }
  }

  private save(): void {
    writeFileSync(this.configFile, JSON.stringify(this.config, null, 2), { mode: 0o600 })
    try { chmodSync(this.configFile, 0o600) } catch { /* Windows 上 chmod 近似 no-op，尽力而为 */ }
  }
}
