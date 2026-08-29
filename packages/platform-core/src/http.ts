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

  constructor(ctx: Context, config: HttpServerConfig = {}) {
    super(ctx, 'httpServer')
    this.port = config.port ?? 7300
    this.host = config.host ?? '0.0.0.0'
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

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const pathSegments = url.pathname.split('/').filter(Boolean).map((s) => s)
    const method = (req.method ?? 'GET').toUpperCase()

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
