/**
 * dws 钉钉 CLI 桥（01门装态钉钉连接兜底）：钉钉官方命令行工具（dingtalk-workspace-cli，
 * 命令前缀 dws）作为 01门 装态的消息出向通道——宿主面钉钉连接器/桥（plugin-dingtalk-bridge）
 * 缺席时，面板「钉钉同步」经本桥落 dws chat 命令投递；CLI 未安装时提供一键安装与诚实状态。
 *
 * 动机（2026-09-11 用户需求）：面板钉钉连接直接使用 dws CLI；客户机器没装时默认帮装；
 * 面板支持 CLI 调用-消息交互。设计边界：
 *   - 本桥零凭证：钉钉侧授权态归 dws CLI 自身；面板可「代发起」登录（dws auth login --device
 *     设备流，2026-09-11 补环）——激活指令（授权链接+用户码）弹给用户，授权完成即本机登录态生效；
 *   - plugin-dingtalk-bridge 在场（全量形态）→ 路由/事件全归桥，本模块不注册不订阅；
 *   - 发送失败如实回传（stdout/stderr 尾部），绝不造假成功；
 *   - 入向（钉钉→面板）：dws chat +chat-messages 拉取绑定群最新消息（按 messageId 幂等去重落库）。
 */
import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'

/** dws 绑定配置（opsStorage 单记录集合）。 */
export interface DwsBindingRecord {
  id: string
  /** 目标钉钉群（群名或 openConversationId，交由 dws CLI 解析）。 */
  group?: string
  boundAt?: string
  boundBy?: string
}

export interface DwsAuthSummary {
  authenticated: boolean
  corpName?: string
  userName?: string
  userId?: string
  expiresAt?: string
  /** 探测失败/未登录时的原始输出尾部（诚实呈现，绝不臆造登录态）。 */
  raw?: string
}

export interface DwsStatus {
  installed: boolean
  version?: string
  mode: 'dws-cli'
  bound: boolean
  group?: string
  installHint: string
  lastError?: string
  auth: DwsAuthSummary
}

/** 设备流激活指令（dws auth login --device stdout 解析产物，弹窗直出）。 */
export interface DeviceFlowInfo {
  /** 基础验证页（不含用户码）。 */
  link?: string
  userCode?: string
  /** 带 user_code 的一步直达链接（弹窗主按钮指向它）。 */
  verifyUrl?: string
  expiresInSeconds?: number
}

const INSTALL_CMD = 'npm install -g dingtalk-workspace-cli'
const INSTALL_HINT = `未检测到 dws CLI（钉钉官方命令行）。一键安装（本面板按钮）或手动执行：${INSTALL_CMD}；安装后在面板「钉钉连接」发起登录（设备码授权）完成钉钉授权。`
const SPAWN_TIMEOUT_MS = 20_000
const INSTALL_TIMEOUT_MS = 240_000
const OUTPUT_CAP = 8_000
/** 设备流授权码有效期 900s（CLI 输出声明）；进程超时给足余量，超时即杀防悬挂。 */
const LOGIN_TIMEOUT_MS = 960_000
/** 发起登录后等待激活指令（链接+用户码）出现在 stdout 的上限。 */
const LOGIN_INFO_WAIT_MS = 25_000
/** dws auth status 探测缓存：正值防高频 spawn；轮询终态一律 force。 */
const AUTH_CACHE_MS = 15_000

/** 设备流登录会话（进程句柄 + 渐进输出缓冲；授权态本身仍归 dws CLI，面板只观测）。 */
interface LoginSession {
  child?: ReturnType<typeof spawn>
  stdout: string
  stderr: string
  startedAt: number
  exited: boolean
  exitOk: boolean
  timer?: ReturnType<typeof setTimeout>
}

/** dws 绑定存储（单记录，id 固定 'dws'）。 */
export function dwsBinding(ctx: Context) {
  return ctx.opsStorage.collection<DwsBindingRecord>('panel:dingtalk')
}

function readBinding(ctx: Context): DwsBindingRecord | undefined {
  return dwsBinding(ctx).get('dws')
}

/** 引用安全的命令行拼接（Windows cmd 引号规则：内容不含引号时双引号包裹足够）。 */
const quote = (value: string): string => (/[^\w@%+=:,./-]/.test(value) ? `"${value.replace(/"/g, '')}"` : value)

function exec(command: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const line = [command, ...args.map(quote)].join(' ')
    const child = spawn(line, [], {
      shell: true,
      windowsHide: true,
      env: { ...process.env },
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok, stdout: stdout.slice(-OUTPUT_CAP), stderr: stderr.slice(-OUTPUT_CAP) })
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 进程已退出 */ }
      finish(false)
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => {
      stderr += String(error)
      finish(false)
    })
    child.on('close', (code) => finish(code === 0))
  })
}

/**
 * dws auth login --device 输出解析（纯函数，selftest 直测）：从渐进式人类可读输出中提取
 * 激活指令。实测形态（dws v1.0.61）：
 *   link: https://login.dingtalk.com/oauth2/device/verify.htm
 *   authorization code: VSGN-KGWV
 *   https://login.dingtalk.com/oauth2/device/verify.htm?user_code=VSGN-KGWV
 *   Authorization code will expire in 900 seconds.
 */
export function parseDeviceFlowOutput(text: string): DeviceFlowInfo {
  const link = text.match(/link:\s*(https?:\/\/\S+)/)?.[1]
  const userCode = text.match(/authorization code:\s*([A-Za-z0-9-]+)/i)?.[1]
    ?? text.match(/user_code=([A-Za-z0-9-]+)/)?.[1]
  const expiresInSeconds = Number(text.match(/expire in (\d+) seconds/i)?.[1] ?? 0) || undefined
  const combined = text.match(/https?:\/\/\S*user_code=[A-Za-z0-9-]+/)?.[0]
  if (link && userCode) return { link, userCode, verifyUrl: `${link}?user_code=${userCode}`, ...(expiresInSeconds ? { expiresInSeconds } : {}) }
  // 兜底：某些版本只给一条带 user_code 的完整链接
  if (combined) return { verifyUrl: combined, ...(userCode ? { userCode } : {}), ...(expiresInSeconds ? { expiresInSeconds } : {}) }
  return {
    ...(link ? { link } : {}),
    ...(userCode ? { userCode } : {}),
    ...(expiresInSeconds ? { expiresInSeconds } : {}),
  }
}

/** dws auth status --format json 输出 → 授权摘要（失败/未登录一律 authenticated:false + raw 尾部）。 */
export function parseAuthStatus(text: string): DwsAuthSummary {
  try {
    const parsed = JSON.parse(text) as {
      authenticated?: boolean
      corp_name?: string
      user_name?: string
      user_id?: string | number
      expires_at?: string
    }
    if (parsed?.authenticated !== true) return { authenticated: false, ...(text.trim() ? { raw: text.slice(-400) } : {}) }
    return {
      authenticated: true,
      ...(parsed.corp_name ? { corpName: parsed.corp_name } : {}),
      ...(parsed.user_name ? { userName: parsed.user_name } : {}),
      ...(parsed.user_id !== undefined ? { userId: String(parsed.user_id) } : {}),
      ...(parsed.expires_at ? { expiresAt: parsed.expires_at } : {}),
    }
  } catch {
    return { authenticated: false, ...(text.trim() ? { raw: text.slice(-400) } : {}) }
  }
}

/** dws CLI 是否可用（版本探测，结果缓存 30s——探测是毫秒级但避免高频 spawn）。 */
export class DwsCli {
  private versionCache: { at: number; installed: boolean; version?: string } | undefined
  private authCache: { at: number; auth: DwsAuthSummary } | undefined
  /** 进行中的设备流登录会话（同机同时至多一个；重发即顶掉旧会话）。 */
  private loginSession: LoginSession | undefined

  private readonly ctx: Context

  constructor(ctx: Context) {
    this.ctx = ctx
  }

  async probe(force = false): Promise<{ installed: boolean; version?: string }> {
    const cached = this.versionCache
    if (!force && cached && Date.now() - cached.at < 30_000) return cached
    const result = await exec('dws', ['--version'], 10_000)
    const version = result.ok ? result.stdout.trim().split(/\r?\n/)[0]?.trim() : undefined
    const probed = { at: Date.now(), installed: result.ok && Boolean(version), version }
    this.versionCache = probed
    return probed
  }

  /**
   * 授权态探测（dws auth status）。未装/未登录/输出异常一律 authenticated:false + raw 尾部，
   * 绝不把「探测失败」粉饰成「已登录」或反之。结果缓存 15s；登录终态判定走 force。
   */
  async authStatus(force = false): Promise<DwsAuthSummary> {
    const cached = this.authCache
    if (!force && cached && Date.now() - cached.at < AUTH_CACHE_MS) return cached.auth
    const result = await exec('dws', ['auth', 'status', '--format', 'json', '--timeout', '15'], 20_000)
    // 未登录时 CLI 可能以非零码退出但 JSON 照常输出——stdout 无条件解析，退出码仅作参考
    const auth = parseAuthStatus(result.stdout || result.stderr)
    this.authCache = { at: Date.now(), auth }
    return auth
  }

  /** 状态面（面板 pill/绑定弹窗消费）。 */
  async status(): Promise<DwsStatus> {
    const { installed, version } = await this.probe()
    const binding = readBinding(this.ctx)
    const auth = installed
      ? await this.authStatus().catch(() => ({ authenticated: false } as DwsAuthSummary))
      : { authenticated: false }
    return {
      installed,
      ...(version ? { version } : {}),
      mode: 'dws-cli',
      bound: Boolean(binding?.group),
      ...(binding?.group ? { group: binding.group } : {}),
      installHint: installed ? '' : INSTALL_HINT,
      auth,
    }
  }

  /** 一键安装（npm 全局装官方 CLI）；已装则直接返回成功。耗时长，调用面须放行 panel.config.write。 */
  async install(): Promise<{ ok: boolean; message: string }> {
    const { installed, version } = await this.probe(true)
    if (installed) return { ok: true, message: `dws CLI 已安装（${version}），无需重复安装` }
    const result = await exec(INSTALL_CMD, [], INSTALL_TIMEOUT_MS)
    const tail = (result.stdout + result.stderr).trim().split(/\r?\n/).slice(-6).join('\n')
    const after = await this.probe(true)
    if (after.installed) {
      return { ok: true, message: `dws CLI 安装完成（${after.version}）。可在面板「钉钉连接」直接发起登录（设备码授权），或终端执行 dws auth login` }
    }
    return {
      ok: false,
      message: `dws CLI 自动安装失败（npm 退出码非 0）。请手动执行：${INSTALL_CMD}\n${tail}`,
    }
  }

  // -- 登录授权面（2026-09-11 用户需求：面板代发起 dws 登录，未登录弹激活指令） ---------------

  /**
   * 代发起登录（dws auth login --device 设备流）：CLI 在本机起轮询、打印激活指令（授权链接 +
   * 用户码），面板把指令弹给用户；用户任意设备上完成授权后 CLI 轮询拿到 token，本机登录态生效。
   * 已登录 → already:true 幂等短路；已有进行中会话 → 直接复用（幂等，不重复起进程）。
   */
  async startLogin(): Promise<
    | { started: true; verifyUrl: string; userCode?: string; expiresInSeconds?: number }
    | { started: false; already?: true; auth?: DwsAuthSummary; message?: string }
  > {
    const auth = await this.authStatus(true)
    if (auth.authenticated) return { started: false, already: true, auth }
    // 已有会话且激活指令已出 → 幂等复用（前端轮询按钮连点安全）
    const existing = this.loginSession
    if (existing && !existing.exited) {
      const info = parseDeviceFlowOutput(existing.stdout)
      if (info.verifyUrl) {
        return { started: true, verifyUrl: info.verifyUrl, ...(info.userCode ? { userCode: info.userCode } : {}), ...(info.expiresInSeconds ? { expiresInSeconds: info.expiresInSeconds } : {}) }
      }
      // 指令还没出来：继续等（不重复起进程）
      const waited = await this.waitForLoginInfo(existing)
      if (waited.verifyUrl) return { started: true, verifyUrl: waited.verifyUrl, ...(waited.userCode ? { userCode: waited.userCode } : {}), ...(waited.expiresInSeconds ? { expiresInSeconds: waited.expiresInSeconds } : {}) }
      if (!existing.exited) return { started: false, message: 'dws 登录进程在位但激活指令未就绪，请稍后在状态轮询中重试' }
    }
    this.cancelLogin()
    const { installed } = await this.probe()
    if (!installed) return { started: false, message: INSTALL_HINT }
    const session: LoginSession = { stdout: '', stderr: '', startedAt: Date.now(), exited: false, exitOk: false }
    const line = ['dws', 'auth', 'login', '--device'].join(' ')
    const child = spawn(line, [], { shell: true, windowsHide: true, env: { ...process.env } })
    session.child = child
    child.stdout?.on('data', (chunk) => { session.stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { session.stderr += String(chunk) })
    child.on('error', (error) => { session.stderr += String(error); session.exited = true })
    child.on('close', (code) => { session.exited = true; session.exitOk = code === 0 })
    session.timer = setTimeout(() => {
      try { child.kill() } catch { /* 进程已退出 */ }
      session.exited = true
    }, LOGIN_TIMEOUT_MS)
    this.loginSession = session
    const info = await this.waitForLoginInfo(session)
    if (info.verifyUrl) {
      return { started: true, verifyUrl: info.verifyUrl, ...(info.userCode ? { userCode: info.userCode } : {}), ...(info.expiresInSeconds ? { expiresInSeconds: info.expiresInSeconds } : {}) }
    }
    if (session.exited) {
      const tail = (session.stderr || session.stdout).trim().split(/\r?\n/).slice(-4).join('；')
      this.loginSession = undefined
      return { started: false, message: `dws 登录进程启动失败：${tail || '退出码非 0'}` }
    }
    return { started: false, message: 'dws 登录进程已启动但激活指令迟迟未输出（请检查 dws 版本 ≥1.0），稍后可在状态面重试' }
  }

  /** 等激活指令出现在输出缓冲（300ms 步进，至多 LOGIN_INFO_WAIT_MS）。 */
  private waitForLoginInfo(session: LoginSession): Promise<DeviceFlowInfo> {
    return new Promise((resolve) => {
      const deadline = Date.now() + LOGIN_INFO_WAIT_MS
      const step = () => {
        const info = parseDeviceFlowOutput(session.stdout)
        if (info.verifyUrl) return resolve(info)
        if (session.exited || Date.now() > deadline) return resolve(info)
        setTimeout(step, 300)
      }
      step()
    })
  }

  /**
   * 登录会话状态（前端 3s 轮询）：进程在位 → active + 激活指令；进程退出 → force 复核授权态
   * 并就地消费会话（成功/失败都给终态，不悬挂）。
   */
  async loginState(): Promise<{ active: boolean; authenticated: boolean; verifyUrl?: string; userCode?: string; expiresInSeconds?: number; message?: string; auth?: DwsAuthSummary }> {
    const session = this.loginSession
    const auth = await this.authStatus(session?.exited === true)
    if (!session) return { active: false, authenticated: auth.authenticated, auth }
    const info = parseDeviceFlowOutput(session.stdout)
    if (!session.exited) {
      return { active: true, authenticated: auth.authenticated, ...(info.verifyUrl ? { verifyUrl: info.verifyUrl } : {}), ...(info.userCode ? { userCode: info.userCode } : {}), ...(info.expiresInSeconds ? { expiresInSeconds: info.expiresInSeconds } : {}), auth }
    }
    // 进程已退出：复核终态并消费会话
    this.loginSession = undefined
    clearTimeout(session.timer)
    if (auth.authenticated) return { active: false, authenticated: true, auth }
    const tail = (session.stderr || session.stdout).trim().split(/\r?\n/).slice(-3).join('；')
    return { active: false, authenticated: false, auth, message: session.exitOk ? 'dws 登录进程已结束但授权态未生效（可能授权码过期），请重新发起' : `dws 登录未完成：${tail || '进程非正常退出，请重新发起'}` }
  }

  /** 取消进行中的登录（杀进程 + 清理；无会话为幂等 no-op）。 */
  cancelLogin(): void {
    const session = this.loginSession
    if (!session) return
    this.loginSession = undefined
    clearTimeout(session.timer)
    try { session.child?.kill() } catch { /* 进程已退出 */ }
  }

  /** 绑定/换绑目标群（存群名或会话 ID，投递时由 dws 解析）。 */
  bind(group: string, boundBy: string): DwsBindingRecord {
    const trimmed = group.trim()
    if (!trimmed) throw new Error('群名/会话 ID 必填')
    const collection = dwsBinding(this.ctx)
    const existing = collection.get('dws')
    const record = existing
      ? collection.update('dws', { group: trimmed, boundAt: new Date().toISOString(), boundBy })
      : collection.insert({ id: 'dws', group: trimmed, boundAt: new Date().toISOString(), boundBy })
    return record
  }

  unbind(): void {
    const binding = readBinding(this.ctx)
    if (binding) dwsBinding(this.ctx).remove('dws')
  }

  /**
   * 出向投递：dws chat +send-to-group --group <群> --content <文本>（--format json 结构化判果）。
   * 失败抛错（调用方落 audit/事件留痕），绝不静默。
   */
  async sendToGroup(text: string, group?: string): Promise<{ group: string; version?: string }> {
    // 绑定前置校验（零成本同步读）先于 probe 子进程探测：本方法被 panel.message.created
    // 事件钩子以 fire-and-forget 调用，回执时延直接决定面板 ddSync 终态回写速度——
    // 未绑群是最常见失败态，不该为它白付一次 dws --version spawn（负载下可达数秒，QA T-04 竞态根源）。
    const target = group?.trim() || readBinding(this.ctx)?.group
    if (!target) throw new Error('未绑定钉钉群：请先在面板「钉钉」绑定目标群')
    const { installed, version } = await this.probe()
    if (!installed) throw new Error(`dws CLI 未安装，无法投递。${INSTALL_HINT}`)
    const result = await exec('dws', ['chat', '+send-to-group', '--group', target, '--content', text, '--format', 'json'], SPAWN_TIMEOUT_MS)
    if (!result.ok) {
      const tail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-4).join('；')
      throw new Error(`dws 投递失败：${tail || 'dws 命令退出码非 0（请检查 dws login 授权态与群名）'}`)
    }
    // dws --format json 输出 {ok:false} 形态时命令退出码可能仍为 0——按真实返回判果
    try {
      const parsed = JSON.parse(result.stdout) as { ok?: boolean; error?: { message?: string } | string }
      if (parsed && parsed.ok === false) {
        const reason = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message
        throw new Error(`dws 投递失败：${reason ?? 'CLI 返回 ok:false'}`)
      }
    } catch (error) {
      if (error instanceof SyntaxError) { /* 非 JSON 输出（旧版 CLI）→ 以退出码为准，视为成功 */ } else { throw error }
    }
    return { group: target, ...(version ? { version } : {}) }
  }

  /**
   * 入向拉取：dws chat +chat-messages 读绑定群最新消息（默认当前时间向前 --limit 条）。
   * 返回归一化消息（createTime 按 dws 输出的本地时区解析为 ISO）；失败抛错，绝不静默。
   */
  async pullLatestMessages(limit = 20, group?: string): Promise<Array<{ messageId: string; sender: string; text: string; createdAt: string }>> {
    const { installed } = await this.probe()
    if (!installed) throw new Error(`dws CLI 未安装，无法拉取。${INSTALL_HINT}`)
    const target = group?.trim() || readBinding(this.ctx)?.group
    if (!target) throw new Error('未绑定钉钉群：请先在面板「钉钉」绑定目标群')
    const capped = Math.min(Math.max(Math.floor(limit) || 20, 1), 50)
    const result = await exec('dws', ['chat', '+chat-messages', '--group', target, '--limit', String(capped), '--no-reactions', '--format', 'json'], SPAWN_TIMEOUT_MS)
    if (!result.ok) {
      const tail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-4).join('；')
      throw new Error(`dws 拉取失败：${tail || 'dws 命令退出码非 0（请检查 dws login 授权态与群名）'}`)
    }
    let parsed: {
      ok?: boolean
      error?: { message?: string } | string
      messages?: Array<{ messageId?: string; sender?: string; text?: string; createTime?: string }>
    }
    try {
      parsed = JSON.parse(result.stdout) as typeof parsed
    } catch {
      throw new Error('dws 拉取失败：CLI 返回了无法解析的输出（请检查 dws 版本 ≥1.0）')
    }
    if (parsed && parsed.ok === false) {
      const reason = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message
      throw new Error(`dws 拉取失败：${reason ?? 'CLI 返回 ok:false'}`)
    }
    return (parsed.messages ?? [])
      .filter((m) => m.messageId && (m.text ?? '').trim())
      .map((m) => ({
        messageId: String(m.messageId),
        sender: String(m.sender ?? '钉钉成员'),
        text: String(m.text ?? '').trim(),
        // dws createTime 为 "YYYY-MM-DD HH:mm:ss" 本地时区形态 → 按本地时区解析
        createdAt: new Date(String(m.createTime ?? '').replace(' ', 'T')).toISOString(),
      }))
  }
}
