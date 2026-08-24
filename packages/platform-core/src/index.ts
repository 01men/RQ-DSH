/**
 * @dsh-ops/platform-core —— 平台基础插件。
 *
 * 提供四个基础服务（一切皆插件：基础层同样是插件）：
 *   ctx.opsStorage      JSON 集合存储（原子落盘，可替换为 DB 实现）
 *   ctx.platformBus  平台事件总线（插件协作唯一胶水）
 *   ctx.tools        ToolRuntime-lite（独立宿主下提供；完整 dsh 下由真 ToolRuntime 提供）
 *   ctx.httpServer   HTTP 服务（控制台 REST API 与静态资源）
 */
import type { Context } from '@deepseek-ai/cordis'
import { StorageService } from './storage.ts'
import { PlatformBusService } from './bus.ts'
import { ToolRuntimeLite } from './tools-lite.ts'
import { HttpServerService } from './http.ts'
import { SqliteTxnService } from './sqlite.ts'

export * from './storage.ts'
export * from './bus.ts'
export * from './tools-lite.ts'
export * from './http.ts'
export * from './ids.ts'
export * from './sqlite.ts'
export * from './yaml.ts'
export * from './plugin-ctx.ts'

export interface PlatformCoreConfig {
  dataDir?: string
  /** 独立宿主默认 true；挂载进完整 dsh 时设为 false，避免与真正 ToolRuntime 冲突。 */
  provideToolRuntime?: boolean
  http?: { port?: number; host?: string }
  /** 是否自动启动 HTTP 监听。 */
  startHttp?: boolean
}

export const name = 'platform-core'

export function apply(ctx: Context, config: PlatformCoreConfig = {}) {
  ctx.plugin(StorageService, { dataDir: config.dataDir })
  ctx.plugin(PlatformBusService)
  ctx.plugin(SqliteTxnService, { dataDir: config.dataDir })
  if (config.provideToolRuntime !== false) {
    ctx.plugin(ToolRuntimeLite)
  }
  const http = new HttpServerService(ctx, config.http ?? {})
  if (config.startHttp !== false) {
    void http.start().then(() => {
      ctx.logger('platform-core').info(`HTTP 服务已启动：http://${http.host}:${http.port}`)
    }, (error: unknown) => {
      ctx.logger('platform-core').error('HTTP 服务启动失败', error)
    })
  }
}
