/**
 * @dsh-ops/plugin-portal —— 门户数据通道（外部系统对接，非平台核心功能）。
 *
 * 企业门户（http://192.168.0.4:8092，纯前端静态站点）按「拉取（Pull）」策略主动来宿主平台
 * 获取已发布的 AI 应用 / 数字员工等数据（接口契约：docs/portal-integration.md，对接文档
 * api.md v1.0）。本插件只实现 6 个公开只读 GET 端点 + CORS 放行 + 可见性审计留痕，
 * 不向门户发起任何推送/回调请求。
 *
 * 边界（刻意保持，门户对接方式可能随门户方演进）：
 *   - 可整体停用：PORTAL_SYNC=off；摘除 = 删除本目录 + boot-all/cordis.yml 各一行，
 *     不影响平台任何业务链路；
 *   - 只读直读：端点实时读取 resourceCore/skillHub/mcpRegistry，无本地副本、无缓存，
 *     「上线/下架 → 门户刷新页面即可见」（契约的更新即时性要求）；
 *   - 契约可变：字段映射集中在 src/mapping.ts；端点前缀、放行来源均可环境变量覆盖。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { PlatformEvents, type HttpExchange } from '../../platform-core/src/index.ts'
import {
  emptySolutions, emptyTools, mapApps, mapEmployees, mapSkills, mapStats,
  type PortalMappingContext, type PortalSolution, type PortalTool,
} from './mapping.ts'

/** 端点前缀：门户 VITE_API_BASE 指向「<平台对外地址><前缀>」（默认 /api/portal）。 */
export function portalPrefix(): string {
  const raw = (process.env.PORTAL_API_PREFIX ?? '/api/portal').trim().replace(/\/+$/, '')
  return raw === '' ? '/api/portal' : (raw.startsWith('/') ? raw : `/${raw}`)
}

/** 数据通道总开关（默认开；PORTAL_SYNC=off 停用端点与留痕，门户侧降级展示内置样板）。 */
export function portalEnabled(): boolean {
  return String(process.env.PORTAL_SYNC ?? 'on').trim().toLowerCase() !== 'off'
}

const ENDPOINTS = ['apps', 'employees', 'solutions', 'tools', 'skills', 'stats', 'board'] as const

export class PortalFeedService extends Service {
  static readonly provide = 'portalFeed'

  /** 单端点契约快照（端点应答唯一出口；CLI/自测亦可复用）。 */
  feed(endpoint: string): unknown[] | undefined {
    const mctx = this.mappingCtx()
    switch (endpoint) {
      case 'apps': return mapApps(this.ctx.resourceCore.list('app'), mctx)
      case 'employees': return mapEmployees(this.ctx.resourceCore.list('agent'), mctx)
      case 'solutions': return emptySolutions() satisfies PortalSolution[]
      case 'tools': return emptyTools() satisfies PortalTool[]
      case 'skills': return mapSkills(this.ctx.skillHub.skills().all(), mctx)
      case 'stats': return mapStats({
        apps: mapApps(this.ctx.resourceCore.list('app'), mctx).length,
        employees: mapEmployees(this.ctx.resourceCore.list('agent'), mctx).length,
        skills: mapSkills(this.ctx.skillHub.skills().all(), mctx).length,
        mcp: this.ctx.mcpRegistry.services().all()
          .filter((service) => service.status === 'online' || service.status === 'gray').length,
      })
      default: return undefined
    }
  }

  /**
   * 老板战略视图聚合（WP-12 看板 v1）：portal 只读端点扩展——不开特权接口、全聚合零 PII。
   * 口径（D3）：漏斗=曝光/点击（behavior）→调用（usage）→完成（mcp ok 调用）；WAIC=usage 周聚合。
   */
  board(): Record<string, unknown> {
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000).toISOString()
    const behaviorCount = (type: string): number => {
      try { return this.ctx.behavior.query({ type, from: weekAgo }).total } catch { return 0 }
    }
    let usageCount = 0
    let chargeCents = 0
    let byDay: Array<{ day: string; count: number; charge_cents: number }> = []
    try {
      const totals = this.ctx.usage.totals({ from: weekAgo })
      usageCount = totals.count
      chargeCents = totals.charge_cents
      byDay = this.ctx.usage.breakdown(weekAgo).byDay
    } catch { /* usage 缺失时看板降级为资产视图 */ }
    let completedCalls = 0
    try {
      completedCalls = this.ctx.mcpRegistry.calls().all()
        .filter((call) => call.ok && call.at >= weekAgo).length
    } catch { /* mcp 缺失时漏斗降级 */ }
    return {
      generatedAt: new Date().toISOString(),
      windowDays: 7,
      assets: {
        appsOnline: this.ctx.resourceCore.list('app').filter((item) => item.status === 'online').length,
        agentsOnline: this.ctx.resourceCore.list('agent').filter((item) => item.status === 'online').length,
        skillsPublished: this.ctx.skillHub.skills().all().filter((item) => item.status === 'published').length,
        mcpServing: this.ctx.mcpRegistry.services().all()
          .filter((service) => service.status === 'online' || service.status === 'gray').length,
      },
      waic: { count: usageCount, chargeCents },
      byDay,
      funnel: {
        exposed: behaviorCount('card.exposed'),
        clicked: behaviorCount('card.clicked'),
        invoked: usageCount,
        completed: completedCalls,
      },
      // ROI 用工成本模型（WP-14）：usage 聚合 → 替代工时估算 → 人力成本对比平台成本。
      // 系数可经环境变量校准（默认：每次调用替代 3 分钟人工，综合人力成本 50 元/小时）；
      // 估算口径声明随响应下发，看板侧必须展示「估算」字样，避免误读为实测值。
      roi: {
        minutesPerCallEstimate: Number(process.env.ROI_MINUTES_PER_CALL ?? 3),
        laborCostCentsPerHour: Number(process.env.ROI_LABOR_COST_CENTS_PER_HOUR ?? 5000),
        callBase: completedCalls > 0 ? completedCalls : usageCount,
        estimatedHoursSaved: Math.round(((completedCalls > 0 ? completedCalls : usageCount) * Number(process.env.ROI_MINUTES_PER_CALL ?? 3) / 60) * 100) / 100,
        estimatedLaborCostCents: Math.round((completedCalls > 0 ? completedCalls : usageCount) * Number(process.env.ROI_MINUTES_PER_CALL ?? 3) / 60 * Number(process.env.ROI_LABOR_COST_CENTS_PER_HOUR ?? 5000)),
        platformChargeCents: chargeCents,
        note: '估算口径：替代工时 = 调用次数 × 单次替代分钟 ÷ 60；人力成本 = 替代工时 × 综合人力时薪。非实测值。',
      },
    }
  }

  private mappingCtx(): PortalMappingContext {
    return {
      deptName: (orgId) => {
        try { return this.ctx.iam.orgs().get(orgId)?.name ?? '' } catch { return '' }
      },
      skillName: (skillId) => {
        try { return this.ctx.skillHub.skills().get(skillId)?.name ?? skillId } catch { return skillId }
      },
      hideConfidential: String(process.env.PORTAL_HIDE_CONFIDENTIAL ?? '') === '1',
    }
  }
}

// ---- CORS（契约 §6：门户为浏览器跨域直连，必须放行，否则门户无法访问） --------------

/** 生产门户来源。 */
const PRODUCTION_PORTAL_ORIGINS = ['http://192.168.0.4:8092']

/** 门户侧显式追加来源（逗号分隔，如 http://192.168.0.4:8092,http://portal.example:8092）。 */
function extraOrigins(): Set<string> {
  return new Set(String(process.env.PORTAL_CORS_ORIGINS ?? '')
    .split(',').map((item) => item.trim()).filter(Boolean))
}

/** 门户开发服务器监听 0.0.0.0:8443（本地开发为 localhost，内网同事为各自 IP）。 */
function isPortalDevOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    const host = url.hostname.toLowerCase()
    const intranet = host === 'localhost' || host === '127.0.0.1' || host === '::1'
      || /^10\.\d+\.\d+\.\d+$/.test(host)
      || /^192\.168\.\d+\.\d+$/.test(host)
      || /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host)
    return intranet && (url.port === '8443' || url.port === '8092')
  } catch {
    return false
  }
}

/** 允许则回显来源（无凭证，契约不需要 credentials），否则仅回 Vary。 */
function corsHeaders(origin: unknown): Record<string, string> {
  const value = typeof origin === 'string' ? origin : ''
  const allowed = value !== ''
    && (PRODUCTION_PORTAL_ORIGINS.includes(value) || isPortalDevOrigin(value) || extraOrigins().has(value))
  return allowed
    ? { vary: 'Origin', 'access-control-allow-origin': value }
    : { vary: 'Origin' }
}

/** 契约包装应答（{code, message, data}，code 0/200 门户视为成功；no-cache 保证刷新即可见）。 */
function respond(exchange: HttpExchange, status: number, payload: unknown, headers: Record<string, string>): void {
  if (exchange.res.headersSent) return
  exchange.res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
    ...headers,
  })
  exchange.res.end(JSON.stringify(payload))
}

export const name = 'portal'
export const inject = ['httpServer', 'platformBus', 'resourceCore', 'iam', 'skillHub', 'mcpRegistry', 'audit', 'usage', 'behavior']

export function apply(ctx: Context) {
  const service = new PortalFeedService(ctx)

  if (portalEnabled()) {
    const prefix = portalPrefix()
    // 门户端点为公开只读（契约 §3：无鉴权）——在 console 鉴权中间件之前截获本前缀请求，
    // 自带 CORS 与契约应答，其余路径原样放行。注册顺序要求本插件先于 console 装配
    // （boot-all / cordis.yml 已按此声明）。
    ctx.effect(() => ctx.httpServer.use((exchange) => {
      if (exchange.path !== prefix && !exchange.path.startsWith(`${prefix}/`)) return
      const headers = corsHeaders(exchange.headers.origin)
      if (exchange.method === 'OPTIONS') {
        if (!exchange.res.headersSent) {
          exchange.res.writeHead(204, {
            ...headers,
            'access-control-allow-methods': 'GET, OPTIONS',
            'access-control-allow-headers': 'content-type',
            'access-control-max-age': '600',
          })
          exchange.res.end()
        }
        return true
      }
      if (exchange.method !== 'GET' && exchange.method !== 'HEAD') {
        respond(exchange, 405, { code: 40500, message: '门户契约为只读 GET，不支持该方式', data: null }, headers)
        return true
      }
      const tail = exchange.path.slice(prefix.length).replace(/^\/+|\/+$/g, '')
      if (tail === '') {
        // 端点发现：联调自检入口（curl <BASE>/ 应看到端点清单）
        respond(exchange, 200, {
          code: 0,
          message: 'ok',
          data: { service: 'portal-feed', contract: 'api.md v1.0', endpoints: ENDPOINTS, generatedAt: new Date().toISOString() },
        }, headers)
        return true
      }
      if (!(ENDPOINTS as readonly string[]).includes(tail)) {
        respond(exchange, 404, { code: 40400, message: `门户端点不存在：${tail}`, data: null }, headers)
        return true
      }
      if (tail === 'board') {
        respond(exchange, 200, { code: 0, message: 'ok', data: service.board() }, headers)
        return true
      }
      respond(exchange, 200, { code: 0, message: 'ok', data: service.feed(tail) }, headers)
      return true
    }))
  } else {
    ctx.logger('portal').info('门户数据通道已停用（PORTAL_SYNC=off），门户将降级展示内置样板数据')
  }

  // 可见性留痕：应用/数字员工上下线 → 审计记录。门户为拉取模式，留痕仅为运营可观测
  // （「何时对门户可见/不可见」），无任何外呼动作。
  const visibilityTrail: Array<[string, string, string]> = [
    [PlatformEvents.AppOnlined, 'app', 'portal.feed.app.visible'],
    [PlatformEvents.AppOfflined, 'app', 'portal.feed.app.hidden'],
    [PlatformEvents.AgentOnlined, 'agent', 'portal.feed.employee.visible'],
    [PlatformEvents.AgentOfflined, 'agent', 'portal.feed.employee.hidden'],
  ]
  for (const [event, resourceType, action] of visibilityTrail) {
    ctx.platformBus.on(event, (payload) => {
      const record = payload as { id?: string; name?: string } | undefined
      try {
        ctx.audit.record({
          type: 'change', actorType: 'system', actorId: 'portal-feed', actorName: '门户数据通道',
          action, resourceType, resourceId: record?.id ?? '', resourceName: record?.name ?? '',
          result: 'ok', detail: '门户拉取模式：资源对门户可见性已变化，门户刷新页面即可见',
        })
      } catch {
        // 留痕失败不阻断业务事件链
      }
    })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    portalFeed: PortalFeedService
  }
}
