/**
 * @dsh-ops/plugin-update —— 平台自更新插件（版本检查 / 更新通知 / 一键升级）。
 *
 * 面向两类安装形态（上游均为 GitHub 仓库 01men/ybkk-AIOS）：
 *   - source（git 源码检出）：版本比对 + GitHub compare API 给出「落后 N 个提交及摘要」；
 *     支持控制台/CLI/Agent 一键升级（git pull --ff-only + npm install + 提示重启），
 *     支持 dry-run 预演，全程审计留痕
 *   - bundle（dsh plugin add 安装）：版本比对同样可用；升级给出 dsh 侧命令指引
 *     （运行中的插件进程不回写宿主 profile，这是刻意的安全边界）
 *
 * 检查策略（对标 npm update-notifier / Gitea 的成熟做法）：
 *   - 自动检查：默认开启，每 24h 一次（启动 30s 后首查），结果持久化；
 *     发现新版本广播 platform.update.available（audit 联动留痕）+ 日志提醒
 *   - 手动检查：控制台抽屉 / dshctl update check / Agent 工具 update_check，
 *     60s 冷却防滥用（GitHub API 未认证限额 60 次/小时/IP）
 *   - 是否升级永远由管理员决定：自动检查只通知、不自动执行（数据型平台不冒进）
 *
 * 三端一致：REST（/api/update/*）· CLI（dshctl update）· Agent 工具（update_*）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import {
  PlatformEvents, defineTool, platformVersionInfo, readRootVersion,
  type Collection, type RecordBase,
} from '../../platform-core/src/index.ts'
import { readGitHead, runGit, runNpm } from './git.ts'

// ---------------------------------------------------------------------------
// 配置与环境覆盖
// ---------------------------------------------------------------------------

export interface UpdateConfig {
  /** 自动检查（默认 true；运行期可经控制台/CLI 调整，持久化于 update:state）。 */
  autoCheck?: boolean
  /** 自动检查间隔小时数（默认 24；运行期可调，0 视为关闭自动检查）。 */
  intervalHours?: number
  /** 上游仓库 owner/name（默认 01men/ybkk-AIOS）。 */
  repo?: string
  /** 上游默认分支（默认 main）。 */
  branch?: string
  /** GitHub API 基址（默认 https://api.github.com；内网镜像/代理可覆盖）。 */
  apiBase?: string
  /** raw 文件基址（默认 https://raw.githubusercontent.com）。 */
  rawBase?: string
  /** 单次检查的网络超时毫秒（默认 10000）。 */
  timeoutMs?: number
}

export interface ResolvedSource {
  repo: string
  branch: string
  apiBase: string
  rawBase: string
  timeoutMs: number
}

const DEFAULT_REPO = '01men/ybkk-AIOS'
const DEFAULT_BRANCH = 'main'
const DEFAULT_API_BASE = 'https://api.github.com'
const DEFAULT_RAW_BASE = 'https://raw.githubusercontent.com'
const MANUAL_CHECK_COOLDOWN_MS = 60_000
/** 构造后延迟初始化：等平台装载完（opsStorage 就绪）再种子状态与定时器。 */
const BOOTSTRAP_DELAY_MS = 15_000
const AUTO_CHECK_TICK_MS = 60 * 60_000

/** 环境变量覆盖（自测 stub / 私有镜像部署用）：DSH_UPDATE_REPO / _BRANCH / _API_BASE / _RAW_BASE。 */
export function resolveSource(config: UpdateConfig): ResolvedSource {
  return {
    repo: process.env.DSH_UPDATE_REPO ?? config.repo ?? DEFAULT_REPO,
    branch: process.env.DSH_UPDATE_BRANCH ?? config.branch ?? DEFAULT_BRANCH,
    apiBase: (process.env.DSH_UPDATE_API_BASE ?? config.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, ''),
    rawBase: (process.env.DSH_UPDATE_RAW_BASE ?? config.rawBase ?? DEFAULT_RAW_BASE).replace(/\/+$/, ''),
    timeoutMs: Math.max(Number(config.timeoutMs) || 10_000, 2_000),
  }
}

// ---------------------------------------------------------------------------
// 状态持久化（opsStorage 单例记录）
// ---------------------------------------------------------------------------

export interface UpstreamCommit {
  sha: string
  message: string
  date: string
  author: string
}

export interface LatestSnapshot {
  version: string
  commit: string
  checkedAt: string
  /** 数据来源标注（github-raw / github-api），排障用。 */
  sources: string[]
}

export interface UpdateStateRecord extends RecordBase {
  autoCheck: boolean
  intervalHours: number
  lastCheckedAt: string
  lastError: string
  latest: LatestSnapshot | null
  hasUpdate: boolean
  behindBy: number
  recentCommits: UpstreamCommit[]
  /** 已忽略的版本（控制台「忽略此版本」后不再弹横幅，新版本出现自动恢复）。 */
  dismissedVersion: string | null
  /** 最近一次广播过 platform.update.available 的版本（防重复通知）。 */
  announcedVersion: string
}

const STATE_ID = 'singleton'

export function updateStateCollection(ctx: Context): Collection<UpdateStateRecord> {
  return ctx.opsStorage.collection<UpdateStateRecord>('update:state')
}

function defaultState(autoCheck = true, intervalHours = 24): Omit<UpdateStateRecord, 'id'> {
  return {
    autoCheck,
    intervalHours,
    lastCheckedAt: '',
    lastError: '',
    latest: null,
    hasUpdate: false,
    behindBy: 0,
    recentCommits: [],
    dismissedVersion: null,
    announcedVersion: '',
  }
}

export function ensureUpdateState(ctx: Context, init?: { autoCheck: boolean; intervalHours: number }): UpdateStateRecord {
  const collection = updateStateCollection(ctx)
  const existing = collection.get(STATE_ID)
  if (existing) return existing
  const init0 = init ?? { autoCheck: true, intervalHours: 24 }
  return collection.insert({ id: STATE_ID, ...defaultState(init0.autoCheck, init0.intervalHours) })
}

// ---------------------------------------------------------------------------
// 版本比较（semver 主三段；非标准版本号返回 0——宁可漏报不可误报）
// ---------------------------------------------------------------------------

export function compareVersions(a: string, b: string): number {
  const parse = (value: string): number[] => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim())
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : []
  }
  const left = parse(a)
  const right = parse(b)
  if (!left.length || !right.length) return 0
  for (let i = 0; i < 3; i++) {
    if (left[i]! > right[i]!) return 1
    if (left[i]! < right[i]!) return -1
  }
  return 0
}

// ---------------------------------------------------------------------------
// 更新服务
// ---------------------------------------------------------------------------

export interface UpdateStatus {
  currentVersion: string
  installMode: 'source' | 'bundle'
  repo: string
  branch: string
  localCommit: string
  localBranch: string
  latest: LatestSnapshot | null
  hasUpdate: boolean
  /** version=远端版本号更高；commits=版本号未变但上游提交领先（源码形态）；none。 */
  updateKind: 'version' | 'commits' | 'none'
  behindBy: number
  recentCommits: UpstreamCommit[]
  lastCheckedAt: string
  lastError: string
  autoCheck: boolean
  intervalHours: number
  dismissedVersion: string | null
  dismissed: boolean
  canApply: boolean
  nextCheckHint: string
}

export class UpdateService extends Service {
  static readonly provide = 'update'

  private readonly config0: UpdateConfig
  private readonly envAutoCheck: boolean | undefined
  readonly source: ResolvedSource
  private lastManualCheckAt = 0
  private checking = false
  private bootstrapped = false
  private tickTimer: ReturnType<typeof setInterval> | undefined

  constructor(ctx: Context, config: UpdateConfig = {}) {
    super(ctx, 'update')
    this.config0 = config
    const envAuto = process.env.DSH_UPDATE_AUTO_CHECK
    this.envAutoCheck = envAuto === undefined ? undefined : (envAuto === 'on' || envAuto === 'true' || envAuto === '1')
    this.source = resolveSource(config)
    // 本 cordis 版本不驱动 Service.start 生命周期（对照 authn/mcp 均为构造期初始化）：
    // 构造后短延迟完成一次 bootstrap（种子状态 + 启动定时器）；此后任意入口访问也会兜底触发。
    setTimeout(() => {
      try { this.ensureBootstrapped() } catch { /* 平台仍在装载时静默，交由首次访问兜底 */ }
    }, BOOTSTRAP_DELAY_MS)
  }

  /** 幂等初始化：种子持久化状态 + 启动自动检查定时器（仅执行一次）。 */
  private ensureBootstrapped(): void {
    if (this.bootstrapped) return
    this.bootstrapped = true
    const state = ensureUpdateState(this.ctx, {
      autoCheck: this.envAutoCheck ?? this.config0.autoCheck ?? true,
      intervalHours: clampIntervalHours(this.config0.intervalHours ?? 24),
    })
    this.tickTimer = setInterval(() => void this.maybeAutoCheck(), AUTO_CHECK_TICK_MS)
    this.ctx.effect?.(() => () => {
      if (this.tickTimer) clearInterval(this.tickTimer)
    })
    if (!state.autoCheck) {
      this.ctx.logger('update').info('自动更新检查已关闭（update:state.autoCheck=false），仅手动检查')
    } else {
      // 启动首查：上次检查时间超出间隔（含从未检查）立即执行
      void this.maybeAutoCheck()
    }
  }

  private state(): UpdateStateRecord {
    this.ensureBootstrapped()
    return ensureUpdateState(this.ctx)
  }

  serverVersion(): string {
    return platformVersionInfo().version
  }

  installMode(): 'source' | 'bundle' {
    return platformVersionInfo().installMode
  }

  /** 手动检查冷却剩余毫秒（防滥用 GitHub 限额）。 */
  cooldownRemainingMs(): number {
    return Math.max(0, MANUAL_CHECK_COOLDOWN_MS - (Date.now() - this.lastManualCheckAt))
  }

  status(): UpdateStatus {
    const info = platformVersionInfo()
    const state = this.state()
    const head = info.installMode === 'source' ? readGitHead(info.rootDir) : null
    const latestVersion = state.latest?.version ?? ''
    const versionAhead = latestVersion !== '' && compareVersions(latestVersion, info.version) > 0
    const commitsAhead = state.behindBy > 0
    const hasUpdate = versionAhead || commitsAhead
    return {
      currentVersion: info.version,
      installMode: info.installMode,
      repo: this.source.repo,
      branch: this.source.branch,
      localCommit: head?.sha ?? '',
      localBranch: head?.branch ?? (head ? '(detached)' : ''),
      latest: state.latest,
      hasUpdate,
      updateKind: versionAhead ? 'version' : commitsAhead ? 'commits' : 'none',
      behindBy: state.behindBy,
      recentCommits: state.recentCommits,
      lastCheckedAt: state.lastCheckedAt,
      lastError: state.lastError,
      autoCheck: state.autoCheck,
      intervalHours: state.intervalHours,
      dismissedVersion: state.dismissedVersion,
      dismissed: hasUpdate && state.dismissedVersion === latestVersion && latestVersion !== '',
      canApply: info.installMode === 'source',
      nextCheckHint: state.autoCheck && state.intervalHours > 0
        ? `自动检查每 ${state.intervalHours}h 一次`
        : '自动检查已关闭，需手动检查',
    }
  }

  /** 立即执行一次上游检查（自动/手动共用；manual=true 记录手动冷却）。 */
  async checkNow(options: { manual?: boolean } = {}): Promise<UpdateStatus> {
    if (options.manual) {
      const cooldown = this.cooldownRemainingMs()
      if (cooldown > 0) throw new Error(`检查过于频繁，请 ${Math.ceil(cooldown / 1000)} 秒后再试`)
      this.lastManualCheckAt = Date.now()
    }
    if (this.checking) throw new Error('已有检查在进行中，请稍候')
    this.checking = true
    try {
      const info = platformVersionInfo()
      const head = info.installMode === 'source' ? readGitHead(info.rootDir) : null
      const headers: Record<string, string> = {
        accept: 'application/vnd.github+json',
        'user-agent': `dsh-ops-update-checker/${info.version}`,
      }
      const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
      if (token) headers.authorization = `Bearer ${token}`
      const signal = AbortSignal.timeout(this.source.timeoutMs)
      const sources: string[] = []
      let latestVersion = ''
      let latestCommit = ''
      let behindBy = 0
      let commits: UpstreamCommit[] = []
      const errors: string[] = []

      // 1) 远端版本号（raw package.json，两种安装形态通用）
      try {
        const rawUrl = `${this.source.rawBase}/${this.source.repo}/${this.source.branch}/package.json`
        const res = await fetch(rawUrl, { headers, signal })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const pkg = await res.json() as { version?: string }
        latestVersion = String(pkg.version ?? '')
        if (!latestVersion) throw new Error('远端 package.json 无 version 字段')
        sources.push('github-raw')
      } catch (error) {
        errors.push(`版本获取失败：${error instanceof Error ? error.message : String(error)}`)
      }

      // 2) 提交差（GitHub compare API，仅源码形态且能定位本地 HEAD）
      if (head?.sha) {
        try {
          const apiUrl = `${this.source.apiBase}/repos/${this.source.repo}/compare/${head.sha}...${this.source.branch}`
          const res = await fetch(apiUrl, { headers, signal })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const data = await res.json() as {
            behind_by?: number
            commits?: Array<{ sha?: string; commit?: { message?: string; author?: { name?: string; date?: string } } }>
          }
          behindBy = Math.max(0, Number(data.behind_by ?? 0))
          latestCommit = String(data.commits?.at(-1)?.sha ?? '')
          commits = (data.commits ?? []).slice(-10).reverse().map((item) => ({
            sha: String(item.sha ?? '').slice(0, 7),
            message: String(item.commit?.message ?? '').split('\n')[0] ?? '',
            date: String(item.commit?.author?.date ?? ''),
            author: String(item.commit?.author?.name ?? ''),
          }))
          sources.push('github-api')
        } catch (error) {
          errors.push(`提交对比失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }

      if (sources.length === 0) {
        const message = errors.join('；') || '无法访问上游（网络不可达或被限流）'
        updateStateCollection(this.ctx).update(STATE_ID, { lastError: message })
        throw new Error(message)
      }

      const prev = this.state()
      const versionAhead = latestVersion !== '' && compareVersions(latestVersion, info.version) > 0
      const hasUpdate = versionAhead || behindBy > 0
      const checkedAt = new Date().toISOString()
      const latest: LatestSnapshot = {
        version: latestVersion || prev.latest?.version || '',
        commit: latestCommit || prev.latest?.commit || '',
        checkedAt,
        sources,
      }
      updateStateCollection(this.ctx).update(STATE_ID, {
        lastCheckedAt: checkedAt,
        lastError: errors.join('；'),
        latest,
        hasUpdate,
        behindBy,
        recentCommits: commits.length > 0 ? commits : prev.recentCommits,
      })

      // 新版本通知（同版本只广播一次；audit 插件订阅总线联动留痕）
      if (hasUpdate && latest.version !== '' && latest.version !== prev.announcedVersion) {
        updateStateCollection(this.ctx).update(STATE_ID, { announcedVersion: latest.version })
        this.ctx.platformBus.emit(PlatformEvents.UpdateAvailable, {
          currentVersion: info.version,
          latestVersion: latest.version,
          behindBy,
          installMode: info.installMode,
        })
        this.ctx.logger('update').info(
          `发现上游新版本：${info.version} → ${latest.version}${behindBy > 0 ? `（落后 ${behindBy} 个提交）` : ''}`,
        )
      } else if (!hasUpdate && prev.announcedVersion !== '') {
        updateStateCollection(this.ctx).update(STATE_ID, { announcedVersion: '' })
      }
      return this.status()
    } finally {
      this.checking = false
    }
  }

  private maybeAutoCheck(): void {
    try {
      const state = this.state()
      if (!state.autoCheck || state.intervalHours <= 0) return
      const elapsed = state.lastCheckedAt ? Date.now() - new Date(state.lastCheckedAt).getTime() : Infinity
      if (elapsed < state.intervalHours * 3_600_000) return
      void this.checkNow().catch((error) => {
        this.ctx.logger('update').warn(`自动更新检查失败：${error instanceof Error ? error.message : String(error)}`)
      })
    } catch { /* 状态异常不致命 */ }
  }

  setSettings(patch: { autoCheck?: boolean; intervalHours?: number; dismissedVersion?: string | null }): UpdateStatus {
    const update: Partial<UpdateStateRecord> = {}
    if (typeof patch.autoCheck === 'boolean') update.autoCheck = patch.autoCheck
    if (patch.intervalHours !== undefined) {
      update.intervalHours = clampIntervalHours(Number(patch.intervalHours))
    }
    if (patch.dismissedVersion !== undefined) {
      update.dismissedVersion = patch.dismissedVersion === null || patch.dismissedVersion === ''
        ? null
        : String(patch.dismissedVersion)
    }
    if (Object.keys(update).length > 0) updateStateCollection(this.ctx).update(STATE_ID, update)
    return this.status()
  }

  /**
   * 一键升级（仅 source 形态）：
   *   git pull --ff-only（脏工作区/分叉会安全失败而非强改）→ npm install → 提示重启。
   * bundle 形态返回宿主侧升级指引（不支持进程内回写 dsh profile，安全边界）。
   */
  async applyUpdate(options: { dryRun?: boolean; reason?: string; actor?: { id: string; name: string } } = {}): Promise<Record<string, unknown>> {
    const info = platformVersionInfo()
    const status = this.status()
    const base = {
      installMode: info.installMode,
      currentVersion: info.version,
      latestVersion: status.latest?.version ?? '',
      behindBy: status.behindBy,
    }
    if (info.installMode !== 'source') {
      return {
        ...base,
        ok: false,
        supported: false,
        instructions: [
          '本实例为 dsh 插件市场安装形态（bundle），升级请在宿主 dsh 侧执行：',
          `  dsh plugin update github:${this.source.repo}    # 或重新安装：dsh plugin add github:${this.source.repo}`,
          '完成后重启 dsh 宿主进程生效。',
        ].join('\n'),
      }
    }
    if (options.dryRun) {
      return {
        ...base,
        ok: true,
        supported: true,
        dryRun: true,
        steps: [
          `git pull --ff-only（目录 ${info.rootDir}；脏工作区/分叉将安全失败，不会强改本地修改）`,
          'npm install（依赖同步，package-lock 有变化时生效）',
          '重启平台进程（systemd / pm2 / 手动 node src/main.ts），新版本生效',
        ],
        ...(status.behindBy > 0
          ? { incomingCommits: status.recentCommits.map((item) => `${item.sha} ${item.message}`) }
          : {}),
      }
    }
    const reason = (options.reason ?? '').trim()
    if (!reason) throw new Error('升级原因必填（留痕要求）')
    const actor = options.actor ?? { id: 'api', name: 'api' }
    const from = info.version
    let gitOutput = ''
    let npmOutput = ''
    let npmFailed = false
    try {
      gitOutput = await runGit(info.rootDir, ['pull', '--ff-only'])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.audit?.record({
        type: 'change', actorType: 'human', actorId: actor.id, actorName: actor.name,
        action: 'platform.update.apply', resourceType: 'platform', resourceId: 'self', resourceName: '平台升级',
        result: 'failed', detail: `git pull 失败：${message.slice(0, 300)}`,
      })
      throw new Error(`git pull 失败（本地有未提交修改或分叉，请人工处理）：${message.slice(0, 300)}`)
    }
    try {
      npmOutput = await runNpm(info.rootDir, ['install', '--no-audit', '--no-fund'])
    } catch (error) {
      npmFailed = true
      npmOutput = error instanceof Error ? error.message : String(error)
    }
    const to = readRootVersion(info.rootDir)
    this.ctx.audit?.record({
      type: 'change', actorType: 'human', actorId: actor.id, actorName: actor.name,
      action: 'platform.update.apply', resourceType: 'platform', resourceId: 'self', resourceName: '平台升级',
      result: npmFailed ? 'partial' : 'ok',
      detail: `${from} → ${to}，原因：${reason}${npmFailed ? '；npm install 失败需人工重试' : ''}`,
    })
    this.ctx.platformBus.emit(PlatformEvents.UpdateApplied, { from, to, reason, actor: actor.name, npmFailed })
    this.ctx.logger('update').info(`平台升级完成：${from} → ${to}（请重启进程生效）`)
    return {
      ...base,
      ok: !npmFailed,
      supported: true,
      from,
      to,
      gitOutput: gitOutput.slice(0, 2000),
      ...(npmOutput ? { npmOutput: npmOutput.slice(0, 2000) } : {}),
      npmFailed,
      needRestart: true,
      notice: npmFailed
        ? '代码已更新但依赖同步失败：请在本目录手动执行 npm install 后重启平台进程'
        : '升级已拉取完成，请重启平台进程（systemd/pm2 或手动重启）后生效',
    }
  }
}

function clampIntervalHours(value: number | undefined): number {
  return Math.min(Math.max(Math.floor(Number(value) || 0), 0), 24 * 30)
}

// ---------------------------------------------------------------------------
// REST 装配（挂载在共享 httpServer；鉴权由 console 中间件统一完成）
// ---------------------------------------------------------------------------

interface PrincipalInfo {
  permissions?: string[]
  principalId?: string
  userId?: string
  name?: string
}

export const updateApi = {
  name: 'update-api',
  inject: ['httpServer', 'opsStorage', 'platformBus', 'update'],
  apply(ctx: Context) {
    const http = ctx.httpServer
    const service = ctx.update

    const requirePermission = (exchange: { principal?: unknown; fail: (status: number, code: string, message: string, extra?: Record<string, unknown>) => void; path: string }, point: string): boolean => {
      const info = exchange.principal as PrincipalInfo | undefined
      const permissions = info?.permissions ?? []
      if (permissions.includes('*') || permissions.includes(point)) return true
      ctx.platformBus.emit('audit.authz.denied', {
        actorId: info?.userId ?? info?.principalId ?? 'anonymous',
        actorName: info?.name ?? 'anonymous',
        point,
        path: exchange.path,
      })
      exchange.fail(403, 'FORBIDDEN', `缺少权限点 ${point}，请联系平台管理员`, { permission: point })
      return false
    }

    const actorOf = (exchange: { principal?: unknown }): { id: string; name: string } => {
      const info = exchange.principal as PrincipalInfo | undefined
      return { id: info?.userId ?? info?.principalId ?? 'api', name: info?.name ?? 'api' }
    }

    // 状态对全部已登录用户开放（顶栏更新横幅人人可见；不含敏感信息）
    http.register('GET', '/api/update/status', (exchange) => {
      exchange.ok(service.status())
    })

    http.register('POST', '/api/update/check', async (exchange) => {
      if (!requirePermission(exchange, 'platform.update.read')) return
      try {
        exchange.ok(await service.checkNow({ manual: true }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('过于频繁')) {
          exchange.fail(429, 'TOO_FREQUENT', message)
        } else {
          exchange.fail(502, 'UPSTREAM_ERROR', message)
        }
      }
    })

    http.register('POST', '/api/update/settings', (exchange) => {
      if (!requirePermission(exchange, 'platform.update.apply')) return
      const input = (exchange.body ?? {}) as { autoCheck?: boolean; intervalHours?: number; dismissedVersion?: string | null }
      exchange.ok(service.setSettings(input))
    })

    http.register('POST', '/api/update/apply', async (exchange) => {
      if (!requirePermission(exchange, 'platform.update.apply')) return
      const input = (exchange.body ?? {}) as { dryRun?: boolean; reason?: string }
      try {
        exchange.ok(await service.applyUpdate({ dryRun: input.dryRun === true, reason: input.reason, actor: actorOf(exchange) }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        exchange.fail(400, 'APPLY_FAILED', message)
      }
    })
  },
}

// ---------------------------------------------------------------------------
// Agent 工具（dsh 会话里自然语言即可检查/升级平台）
// ---------------------------------------------------------------------------

export const updateTools = {
  name: 'update-tools',
  inject: ['tools', 'opsStorage', 'platformBus', 'update'],
  apply(ctx: Context) {
    const service = ctx.update
    const t = ctx.tools

    t.register(defineTool({
      name: 'update_status',
      description: '查看平台版本与上游更新状态：当前版本、安装形态（source=git 检出 / bundle=市场安装）、最新版本、是否落后及落后提交数、最近检查时间与自动检查设置。',
      permission: 'platform.update.read',
      parameters: {},
      output: { type: 'object', additionalProperties: true },
      async execute() {
        return service.status()
      },
    }))

    t.register(defineTool({
      name: 'update_check',
      description: '立即向上游仓库（GitHub）发起一次更新检查并返回最新状态（60 秒冷却）。发现新版本会广播平台事件并留审计记录。',
      permission: 'platform.update.read',
      parameters: {},
      output: { type: 'object', additionalProperties: true },
      async execute() {
        return await service.checkNow({ manual: true })
      },
    }))

    t.register(defineTool({
      name: 'update_apply',
      description: '执行平台升级（仅 source 安装形态）：git pull --ff-only + npm install，完成后需重启进程生效。dryRun=true 只预演不执行。bundle 形态返回宿主侧升级命令指引。reason 必填（永久留痕）。',
      permission: 'platform.update.apply',
      parameters: {
        dryRun: { type: 'boolean', description: '预演模式：只返回将执行的步骤，不做任何变更' },
        reason: { type: 'string', description: '升级原因（留痕要求，正式执行时必填）' },
      },
      output: { type: 'object', additionalProperties: true },
      async execute(args) {
        const dryRun = args.dryRun === true
        const reason = String(args.reason ?? '')
        if (!dryRun && !reason.trim()) throw new Error('正式执行升级必须给出 reason（留痕要求）')
        return await service.applyUpdate({ dryRun, reason, actor: { id: 'tool:update_apply', name: 'dsh Agent' } })
      },
    }))
  },
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

export const name = 'update'
export const inject = ['httpServer', 'opsStorage', 'platformBus', 'tools', 'audit']

export function apply(ctx: Context, config: UpdateConfig = {}) {
  // 服务本体（定时自动检查随服务启动）
  ctx.plugin(UpdateService, config)
  // REST + Agent 工具（子插件经服务键 ctx.update 复用同一实例）
  ctx.plugin(updateApi)
  ctx.plugin(updateTools)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    update: UpdateService
  }
}
