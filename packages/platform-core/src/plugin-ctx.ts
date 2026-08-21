/**
 * 轻量插件上下文（代理 ctx）：第三方插件运行边界的第 1 层防线。
 * 范围（生态设计 v1.2 第 3 步，S3 消解）：**只做事件源鉴别 + 能力裁剪**，
 * 不做模块级沙箱（require/fs/net 隔离属第 10 步 L1 自研沙箱）。
 *
 * 三层防线声明：代理 ctx（运行时强制）→ lint/静态扫描（可绕过）→ 运行时对账
 * （usage 事件 principal/resource vs manifest 声明 capabilities，偏差告警下架）。
 */
import type { Context } from '@deepseek-ai/cordis'

/** 平台能力 → ctx 服务名映射（裁剪白名单的依据）。 */
export const CAPABILITY_SERVICES: Record<string, string[]> = {
  'model-gateway.invoke': ['modelGateway'],
  'knowledgebase.read': [],
  'audit.emit': [],
  'usage.meter': ['usage'],
  'storage.scoped': [],
}

export interface PluginSandboxOptions {
  pluginId: string
  /** 安装时企业审批通过的能力集合（approved ⊆ requested）。 */
  capabilities: string[]
}

/**
 * 构造插件代理上下文：
 *   - platformBus.emit 强制盖 source: plugin:<id>，事件名强制收敛到 plugin:<id>: 前缀；
 *   - 平台服务访问按 approved capabilities 裁剪，越权访问抛错；
 *   - 平台内部发射路径（不带 source）对插件不可达。
 */
export function createPluginContext(ctx: Context, options: PluginSandboxOptions): PluginContext {
  const { pluginId, capabilities } = options
  const allowed = new Set(capabilities)

  const platformBus = {
    on: (event: string, cb: (payload: unknown, event: unknown) => void) => ctx.platformBus.on(event, cb as never),
    /** 插件事件：只允许自有命名空间；总线层再强制一次 source 一致性。 */
    emit: (name: string, payload: unknown) => {
      if (!name.startsWith(`plugin:${pluginId}:`)) {
        throw new Error(`[plugin-ctx] 插件 ${pluginId} 只能发射 plugin:${pluginId}: 前缀的事件，收到：${name}`)
      }
      return ctx.platformBus.emit(name, payload, { source: `plugin:${pluginId}` })
    },
    recent: (limit?: number) => ctx.platformBus.recent(limit),
  }

  const proxy = new Map<string, unknown>()

  return {
    pluginId,
    capabilities: [...allowed],
    platformBus,
    /** 能力裁剪的服务访问入口：未授权服务抛错（运行时强制）。 */
    service(name: string): unknown {
      const entry = Object.entries(CAPABILITY_SERVICES).find(([, services]) => services.includes(name))
      const capability = entry?.[0] ?? name
      if (!allowed.has(capability) && !allowed.has('*')) {
        throw new Error(`[plugin-ctx] 插件 ${pluginId} 未获能力 ${capability}，禁止访问服务 ${name}（安装时审批的能力集为准）`)
      }
      if (!proxy.has(name)) {
        const target = (ctx as unknown as Record<string, unknown>)[name]
        if (target === undefined) throw new Error(`[plugin-ctx] 平台服务不存在：${name}`)
        proxy.set(name, target)
      }
      return proxy.get(name)
    },
  }
}

export interface PluginContext {
  readonly pluginId: string
  readonly capabilities: string[]
  platformBus: {
    on: (event: string, cb: (payload: unknown, event: unknown) => void) => () => void
    emit: (name: string, payload: unknown) => unknown
    recent: (limit?: number) => unknown[]
  }
  service(name: string): unknown
}
