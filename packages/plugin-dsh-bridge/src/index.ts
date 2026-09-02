/**
 * @dsh-ops/plugin-dsh-bridge —— dsh 宿主挂载桥（单进程单入口的结构地基）。
 *
 * 完整 dsh 形态下，把榕器数据面（platform-core httpServer 的全部路由/中间件/静态资源）
 * 以 URL 前缀方式挂进 dsh webServer（ctx.webServer，dsh web 进程内唯一监听器）：
 *
 *   http://<host>:<port>/rq/*   →  剥离 /rq 前缀后交给 httpServer.dispatch
 *   http://<host>:<port>/rq     →  302 /rq/（目录形态归一，保证 SPA 相对引用可解析）
 *
 * 独立形态（node src/main.ts）不装配本插件——webServer 不存在，行为零变化。
 * 挂载后 platform-core 的 http.externalBase 应设为同值前缀（cordis.yml 内配置），
 * 平台侧根绝对路径构造（OIDC 授权页 302 等）据此保持自洽。
 *
 * 设计依据：docs/dev-plan-agent-host-unification.md §三（M1）。
 * dsh 侧挂载契约（deepseek-harness packages/host/webserver/src/index.ts:94-101）：
 *   WebRoute = { kind:'exact'|'prefix', path, handler(req,res) }，handler 拥有完整响应生命周期。
 * 硬约束：`/api` 前缀与全站 fallback 席位均已被 dsh 占用（重复注册 throw），
 * 榕器数据面必须整体走独立前缀（/rq）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { HttpServerService } from '../../platform-core/src/index.ts'

/** dsh webServer 的最小结构类型（不依赖 dsh 包，仅消费 register 契约）。 */
interface DshWebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void
  }): unknown
}

export interface DshBridgeConfig {
  /** 榕器数据面对外前缀（默认 /rq；须为以 / 开头的非根路径）。 */
  mountPath?: string
}

export const name = 'dsh-bridge'

/** webServer 由 dsh web profile 提供；httpServer 由 platform-core 提供。 */
export const inject = ['webServer', 'httpServer']

export function apply(ctx: Context, config: DshBridgeConfig = {}) {
  const mountPath = (config.mountPath ?? '/rq').replace(/\/+$/, '')
  if (!mountPath.startsWith('/') || mountPath === '/') {
    throw new Error(`dsh-bridge mountPath 非法：${JSON.stringify(config.mountPath)}（须为以 / 开头的非根路径）`)
  }
  const webServer = (ctx as unknown as { webServer?: DshWebServerLike }).webServer
  const httpServer = (ctx as unknown as { httpServer?: HttpServerService }).httpServer
  if (!webServer || typeof webServer.register !== 'function') {
    throw new Error('dsh-bridge 需要 ctx.webServer（仅在完整 dsh web 宿主下装配本插件）')
  }
  if (!httpServer) {
    throw new Error('dsh-bridge 需要 ctx.httpServer（platform-core 必须先于本插件装配）')
  }

  webServer.register({
    kind: 'prefix',
    path: mountPath,
    handler(req, res) {
      const url = req.url ?? '/'
      if (url === mountPath) {
        res.writeHead(302, { location: `${mountPath}/` }).end()
        return
      }
      const inner = url.startsWith(`${mountPath}/`) ? url.slice(mountPath.length) : url
      req.url = inner.startsWith('/') ? inner : `/${inner}`
      void httpServer.dispatch(req, res)
    },
  })

  ctx.logger('dsh-bridge').info(`榕器数据面已挂载至 dsh webServer：${mountPath}/*（单进程单入口）`)
}
