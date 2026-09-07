/**
 * HTTP 服务：REST 路由 + 静态资源 + 中间件，独立宿主的数据面入口。
 * 真实 dsh 部署下控制台可独立进程运行（本服务随 platform-core 提供）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'

export interface HttpExchange {
  method: string
  path: string
  params: Record<string, string>
  query: URLSearchParams
  headers: IncomingMessage['headers']
  body: any
  raw: IncomingMessage
  res: ServerResponse
  /** 鉴权中间件写入的调用方身份。 */
  principal?: unknown
  ok(data?: unknown, init?: { status?: number }): void
  fail(status: number, code: string, message: string, extra?: Record<string, unknown>): void
  file(absolutePath: string, contentType?: string): void
}

export type HttpHandler = (exchange: HttpExchange) => void | Promise<void>
export type HttpMiddleware = (exchange: HttpExchange) => boolean | void | Promise<boolean | void>

interface Route {
  method: string
  segments: string[]
  handler: HttpHandler
}

export interface HttpServerConfig {
  port?: number
  host?: string
  /**
   * 对外挂载前缀（默认 ''，即根路径）。挂载进完整 dsh 宿主（plugin-dsh-bridge）时设为 '/rq'：
   * 平台侧所有「根绝对路径」构造（OIDC 授权页 302、SSO 回跳 HTML 等）据此拼接，
   * 保证单入口（dsh web 端口）下 /rq 前缀内的链接自洽。
   */
  externalBase?: string
  /**
   * 跨域放行来源（docs/frontend-host-switching.md：控制台「宿主连接切换」——A 机页面直连 B 机数据面）。
   * 默认 ['*']：数据面是纯 Bearer 通道，跨域请求不携带 Cookie（/dsh-bridge/* 注册在 dsh webServer
   * 根上、不经本分发），放开不改变同源语义；传 [] 关闭；传具体来源列表则精确回显（配合 Vary: Origin）。
   */
  corsAllowOrigins?: string[]
}

/**
 * CORS 放行决议（纯函数，selftest 直测）：返回应回写的 access-control-allow-origin 值，
 * 未命中返回 undefined（不发放放行头）。
 */
export function corsAllowOriginFor(allowOrigins: readonly string[], originHeader: string | undefined): string | undefined {
  if (!originHeader || allowOrigins.length === 0) return undefined
  if (allowOrigins.includes('*')) return '*'
  let origin = ''
  try { origin = new URL(originHeader).origin } catch { return undefined }
  return allowOrigins.includes(origin) ? origin : undefined
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.map': 'application/json',
}

export class HttpServerService extends Service {
  static readonly provide = 'httpServer'

  private routes: Route[] = []
  private middlewares: HttpMiddleware[] = []
  private staticDirs: Array<{ prefix: string; dir: string; fallback?: string }> = []
  private server: Server | undefined
  readonly port: number
  readonly host: string
  /** 对外挂载前缀：'' 或形如 '/rq'（无尾斜杠）。见 HttpServerConfig.externalBase。 */
  readonly externalBase: string
  private readonly corsAllowOrigins: string[]
  /**
   * 路由×权限矩阵（跨插件共享登记处）。console 的 guarded() 是第一登记方；
   * 插件自注册 REST（如 plugin-panel-core）也必须把 {method, path, permission} 推入此处，
   * 否则逃出 selftest「RBAC 端点矩阵 100% 越权断言网」（review-dsh-agent-panel-v2 Phase 0）。
   */
  readonly routeMatrix: Array<{ method: string; path: string; permission: string }> = []

  constructor(ctx: Context, config: HttpServerConfig = {}) {
    super(ctx, 'httpServer')
    this.port = config.port ?? 7300
    this.host = config.host ?? '0.0.0.0'
    this.externalBase = (config.externalBase ?? '').replace(/\/+$/, '')
    this.corsAllowOrigins = config.corsAllowOrigins ?? ['*']
    ctx.effect(() => () => {
      void this.stop()
    })
  }

  async start(): Promise<void> {
    if (this.server) return
    const server = createServer((req, res) => {
      void this.dispatch(req, res)
    })
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject)
      server.listen(this.port, this.host, () => {
        server.removeListener('error', reject)
        resolvePromise()
      })
    })
    this.server = server
  }

  async stop(): Promise<void> {
    if (!this.server) return
    const server = this.server
    this.server = undefined
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
  }

  use(middleware: HttpMiddleware): () => void {
    this.middlewares.push(middleware)
    return () => {
      const index = this.middlewares.indexOf(middleware)
      if (index >= 0) this.middlewares.splice(index, 1)
    }
  }

  register(method: string, pattern: string, handler: HttpHandler): () => void {
    const segments = pattern.split('/').filter(Boolean)
    const route: Route = { method: method.toUpperCase(), segments, handler }
    this.routes.push(route)
    return () => {
      const index = this.routes.indexOf(route)
      if (index >= 0) this.routes.splice(index, 1)
    }
  }

  /** 便捷注册全部常用动词。 */
  route(pattern: string, handler: HttpHandler, methods = ['GET']): void {
    for (const method of methods) this.register(method, pattern, handler)
  }

  serveStatic(prefix: string, dir: string, fallback?: string): () => void {
    const entry = { prefix, dir: resolve(dir), fallback }
    this.staticDirs.push(entry)
    return () => {
      const index = this.staticDirs.indexOf(entry)
      if (index >= 0) this.staticDirs.splice(index, 1)
    }
  }

  private match(method: string, pathSegments: string[]): { route: Route; params: Record<string, string> } | undefined {
    for (const route of this.routes) {
      if (route.method !== method && !(route.method === 'GET' && method === 'HEAD')) continue
      if (route.segments.length !== pathSegments.length) continue
      const params: Record<string, string> = {}
      let matched = true
      for (let i = 0; i < route.segments.length; i++) {
        const pattern = route.segments[i]!
        const actual = pathSegments[i]!
        if (pattern.startsWith(':')) {
          params[pattern.slice(1)] = decodeURIComponent(actual)
        } else if (pattern !== actual) {
          matched = false
          break
        }
      }
      if (matched) return { route, params }
    }
    return undefined
  }

  /**
   * 请求入口（公开）。独立形态由 start() 的 listener 调用；挂载形态（plugin-dsh-bridge，
   * 完整 dsh 宿主下的单进程单入口）由 dsh webServer 的前缀路由剥离对外前缀后直接调用。
   * 调用方保证 req.url 已是平台内部路径（/api/*、/、/docs/* 等）。
   */
  async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const pathSegments = url.pathname.split('/').filter(Boolean).map((s) => s)
    const method = (req.method ?? 'GET').toUpperCase()

    // 跨域放行（宿主连接切换，docs/frontend-host-switching.md）：只覆盖平台 REST 数据面 /api/*，
    // 且豁免自管 CORS 的子面——门户通道 /api/portal/* 与 OIDC 协议的 /api/authn/oidc/* 自行按
    // 来源精确放行，不得被放宽（/oauth/*、/.well-known/* 不在 /api 内，天然不受影响）；
    // 令牌铸造/交换面 /api/auth/*（login/refresh/票据兑换等公开端点）对 blanket '*' 永不发放
    // （RQ 澄清第 1 条：防任意网页跨站读取登录响应做 drive-by 凭证探测）——配置具体来源
    // 列表时仍按精确来源放行（corsAllowOriginFor 返回具体 origin 不受此豁免），远程宿主
    // 在线登录由 B 侧显式配置来源，符合零信任默认基调。
    // 先于鉴权中间件——浏览器预检 OPTIONS 不带 Bearer，不得被 401 拦截；放行头经 setHeader
    // 预挂，与后续 ok/fail/file 的 writeHead 自然合并（错误体跨域同样可读）。
    const blanketCorsExempt = url.pathname.startsWith('/api/portal/')
      || url.pathname.startsWith('/api/authn/oidc/')
      || (this.corsAllowOrigins.includes('*') && url.pathname.startsWith('/api/auth/'))
    const blanketCorsPath = url.pathname.startsWith('/api/') && !blanketCorsExempt
    const allowOrigin = blanketCorsPath ? corsAllowOriginFor(this.corsAllowOrigins, req.headers.origin) : undefined
    if (allowOrigin) {
      res.setHeader('access-control-allow-origin', allowOrigin)
      res.setHeader('vary', 'Origin')
      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'access-control-allow-headers': String(req.headers['access-control-request-headers'] ?? 'authorization, content-type'),
          'access-control-max-age': '600',
        })
        res.end()
        return
      }
    }

    let body: any
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const rawBody = Buffer.concat(chunks).toString('utf8')
      if (rawBody) {
        const contentType = String(req.headers['content-type'] ?? '')
        if (contentType.includes('application/json')) {
          try {
            body = JSON.parse(rawBody)
          } catch {
            body = undefined
          }
        } else if (contentType.includes('form')) {
          body = Object.fromEntries(new URLSearchParams(rawBody))
        } else {
          body = rawBody
        }
      }
    }

    const exchange: HttpExchange = {
      method,
      path: url.pathname,
      params: {},
      query: url.searchParams,
      headers: req.headers,
      body,
      raw: req,
      res,
      ok(data, init) {
        // 幂等守卫：错误处理器已写过响应时忽略（连接器路由的错误透传与外层 guarded 的兜底
        // 存在同请求双写路径，二次 writeHead 会抛 ERR_HTTP_HEADERS_SENT）
        if (res.headersSent) return
        const payload = data === undefined ? { ok: true } : { ok: true, data }
        const text = JSON.stringify(payload)
        res.writeHead(init?.status ?? 200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(text)
      },
      fail(status, code, message, extra) {
        if (res.headersSent) return
        const payload = JSON.stringify({ ok: false, error: { code, message, ...extra } })
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(payload)
      },
      file(absolutePath, contentType) {
        void (async () => {
          try {
            const info = await stat(absolutePath)
            if (!info.isFile()) {
              res.writeHead(404).end('not found')
              return
            }
            const type = contentType ?? MIME[extname(absolutePath)] ?? 'application/octet-stream'
            res.writeHead(200, { 'content-type': type, 'content-length': info.size, 'cache-control': 'no-cache' })
            createReadStream(absolutePath).pipe(res)
          } catch {
            res.writeHead(404).end('not found')
          }
        })()
      },
    }

    try {
      for (const middleware of this.middlewares) {
        const blocked = await middleware(exchange)
        if (blocked === true) return
        if (res.writableEnded) return
      }

      const matched = this.match(method, pathSegments)
      if (matched) {
        exchange.params = matched.params
        await matched.route.handler(exchange)
        return
      }

      // 静态目录最长前缀优先（/docs 等子路径挂载先于 / 兜底；同长保持注册顺序）
      const staticCandidates = this.staticDirs
        .map((entry) => ({ entry, prefix: entry.prefix.replace(/\/$/, '') }))
        .filter(({ prefix }) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))
        .sort((a, b) => b.prefix.length - a.prefix.length)
      if (staticCandidates.length > 0) {
        // DEF-01：API 请求永不回落到静态资源/SPA 页面，未匹配路由一律 404 JSON
        if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
          exchange.fail(404, 'NOT_FOUND', `路由不存在：${method} ${url.pathname}`)
          return
        }
        const best = staticCandidates[0]!
        await this.serveFromDir(exchange, best.entry, url.pathname.slice(best.prefix.length))
        return
      }
      if (this.staticDirs.length > 0) {
        // SPA 兜底：非 /api 请求回落到第一个静态目录的 fallback 页
        if (!url.pathname.startsWith('/api/')) {
          const entry = this.staticDirs[0]!
          await this.serveFromDir(exchange, entry, entry.fallback ?? '/index.html')
          return
        }
      }
      exchange.fail(404, 'NOT_FOUND', `路由不存在：${method} ${url.pathname}`)
    } catch (error) {
      if (!res.writableEnded) {
        // 生产安全：500 兜底不回传内部异常文本，详情仅入服务日志
        exchange.fail(500, 'INTERNAL', '服务器内部错误，请稍后重试或联系管理员')
      }
      console.error(`[http] ${method} ${url.pathname} 处理异常`, error)
    }
  }

  private async serveFromDir(exchange: HttpExchange, entry: { dir: string; fallback?: string }, relative: string): Promise<void> {
    let target = join(entry.dir, normalize(relative).replace(/^([/\\])+/, ''))
    if (relative === '' || relative === '/') target = join(entry.dir, 'index.html')
    try {
      const info = await stat(target)
      if (info.isDirectory()) target = join(target, 'index.html')
    } catch {
      const fallback = entry.fallback ?? '/index.html'
      target = join(entry.dir, fallback.replace(/^\/+/, ''))
    }
    exchange.file(target)
  }
}

/** 以当前模块为基准解析资源目录（ESM 下替代 __dirname）。 */
export function assetDir(importMeta: ImportMeta, ...relative: string[]): string {
  return join(fileURLToPath(importMeta.url), '..', '..', ...relative)
}
