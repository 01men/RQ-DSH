/**
 * @dsh-ops/plugin-connect —— 远程接入插件（一份代码，两种角色）。
 *
 * - role=host（独立宿主默认）：提供接入码 / enroll / 客户端管理端点与工具，
 *   让远程 dsh 运行时（插件市场安装形态）可向本平台申请机器凭证。
 * - role=client（dsh.bundle 安装形态）：向宿主申请并保管机器凭证；
 *   配置完成后，平台全部运维工具的执行自动转发宿主（未配置时保持本地执行，向后兼容）；
 *   同时起一个仅本机可访问的配置页（默认 http://127.0.0.1:7390）供人工填写/更新配置，
 *   并向模型暴露 connect_* 工具，让 Agent 用自然语言完成「申请口令 / 改配置 / 断开」。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../platform-core/src/index.ts'
import { ConnectClientService, isProxiedTool } from './client.ts'
import { ConnectConfigServer } from './config-page.ts'
import { connectHostApi, connectHostTools } from './host.ts'

export * from './client.ts'
export * from './config-page.ts'
export * from './host.ts'

export interface ConnectConfig {
  /** host=宿主侧（管理端点）；client=远程 dsh 侧（申请凭证 + 工具远程代理）。 */
  role?: 'host' | 'client'
  /** 客户端配置文件目录（默认与本地存储同目录）。 */
  dataDir?: string
  /** 客户端本机配置页监听（默认 127.0.0.1:7390；host=0.0.0.0 可局域网访问）。 */
  configServer?: { port?: number; host?: string }
  /** 心跳间隔分钟数（默认 5；0 = 关闭心跳推送）。 */
  heartbeatIntervalMinutes?: number
}

export const name = 'connect'
export const inject = ['tools', 'httpServer', 'opsStorage', 'platformBus']

export function apply(ctx: Context, config: ConnectConfig = {}) {
  if (config.role === 'client') {
    applyClient(ctx, config)
    return
  }
  // host 角色：管理端点（等 authn/iam/audit 就绪）+ 宿主侧接入管理工具
  ctx.plugin(connectHostApi)
  ctx.plugin(connectHostTools)
}

// ---------------------------------------------------------------------------
// client 角色
// ---------------------------------------------------------------------------

function applyClient(ctx: Context, config: ConnectConfig): void {
  const client = new ConnectClientService(ctx, { dataDir: config.dataDir })

  // 工具远程代理：包裹 tools.register，业务工具（非 connect_ 前缀）在已接入时
  // 改为转发宿主 /api/tools/execute。包裹必须发生在业务插件注册之前——
  // 因此本插件在 cordis.patch.yml 中紧随 platform-core 之后加载。
  const wrapped = wrapToolRegistration(ctx, client)

  // 本机配置页（仅本机可访问；用户在 dsh 界面之外的可视化配置入口）
  const server = new ConnectConfigServer(ctx, client, config.configServer ?? {})
  void server.start().then(() => {
    ctx.logger('connect').info(
      `接入配置页已就绪：http://${server.host}:${server.port}${wrapped ? '（当前工具为本地执行，接入后自动切换远程）' : ''}`,
    )
  }, (error: unknown) => {
    ctx.logger('connect').error(`接入配置页启动失败（端口 ${server.port}）：`, error)
  })

  // -- 心跳推送：接入后周期性向宿主上报存活与运行元信息（宿主侧接入资产监测） ------
  // 默认 5 分钟一轮，heartbeatIntervalMinutes=0 关闭；未接入时静默跳过，失败仅记录 lastError。
  const heartbeatMinutes = config.heartbeatIntervalMinutes ?? 5
  if (heartbeatMinutes > 0) {
    const bootAt = Date.now()
    const beat = (): void => {
      if (!client.hasHub()) return
      let tools = 0
      try { tools = ctx.tools.schemas?.().length ?? 0 } catch { /* dsh 原生运行时接口差异时降级为 0 */ }
      void client.heartbeat({ tools, version: process.version, uptimeSec: Math.floor((Date.now() - bootAt) / 1000) })
        .catch((error: unknown) => client.noteError(`heartbeat: ${error instanceof Error ? error.message : String(error)}`))
    }
    const timer = setInterval(beat, heartbeatMinutes * 60_000)
    timer.unref?.()
    const first = setTimeout(beat, 10_000) // 接入配置完成后 10s 内先发一次，宿主侧立即可见
    first.unref?.()
    // cordis ctx.effect(fn)：fn 返回清理函数，须双层箭头（否则注册时即执行）
    ctx.effect(() => () => { clearInterval(timer); clearTimeout(first) })
  }

  // -- Agent 工具：安装完插件后，Agent 用自然语言即可完成口令申请与配置更新 ----
  const t = ctx.tools
  t.register(defineTool({
    name: 'connect_status',
    description: '查看当前与宿主平台的接入状态（是否已配置、宿主可达性、机器令牌状态、工具执行模式 local/remote、最近错误）。',
    parameters: {},
    output: { type: 'object', additionalProperties: true },
    async execute() {
      return await client.status()
    },
  }))

  t.register(defineTool({
    name: 'connect_setup',
    description: '向宿主平台申请口令并完成接入（安装插件后第一步）：用管理员签发的一次性接入码换取长期机器凭证并保存到本机。成功后平台运维工具自动切换为远程执行。',
    parameters: {
      hubUrl: { type: 'string', required: true, description: '宿主平台服务地址，如 http://192.168.1.5:7300' },
      enrollmentCode: { type: 'string', required: true, description: '宿主管理员在控制台「平台接入」创建的一次性接入码（enr_ 开头）' },
      clientName: { type: 'string', description: '本机名称（默认 dsh-主机名，宿主侧便于识别）' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const result = await client.enroll({
        hubUrl: String(args.hubUrl),
        enrollmentCode: String(args.enrollmentCode),
        clientName: args.clientName === undefined || args.clientName === '' ? undefined : String(args.clientName),
      })
      const probe = await client.probeHub().catch(() => null)
      return {
        ok: true,
        hubUrl: result.hubUrl,
        clientName: result.clientName,
        template: result.template,
        hubReachable: probe?.reachable === true,
        notice: '机器凭证已保存到本机；平台运维工具已切换为远程执行（宿主侧执行、按模板权限收敛、全程审计）',
      }
    },
  }))

  t.register(defineTool({
    name: 'connect_login',
    description: '用已有机器凭证（ClientId/ClientSecret）配置宿主连接。适用于管理员在宿主控制台手工签发凭证后分发的场景。',
    parameters: {
      hubUrl: { type: 'string', required: true, description: '宿主平台服务地址' },
      clientId: { type: 'string', required: true, description: '机器凭证 ClientId（mc- 开头）' },
      clientSecret: { type: 'string', required: true, description: '机器凭证 ClientSecret' },
      clientName: { type: 'string', description: '本机名称（可选）' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const result = await client.loginWithCredential({
        hubUrl: String(args.hubUrl),
        clientId: String(args.clientId),
        clientSecret: String(args.clientSecret),
        clientName: args.clientName === undefined || args.clientName === '' ? undefined : String(args.clientName),
      })
      return { ok: true, hubUrl: result.hubUrl, clientName: result.clientName, notice: '凭证已验证并保存，工具切换为远程执行' }
    },
  }))

  t.register(defineTool({
    name: 'connect_test',
    description: '体检宿主连接：健康检查 + 机器令牌换发 + 一次真实只读调用（agent_list）。',
    parameters: {},
    output: { type: 'object', additionalProperties: true },
    async execute() {
      const status = await client.status()
      if (!client.hasHub()) return { ...status, note: '尚未接入，先执行 connect_setup' }
      let sample: Record<string, unknown> = {}
      try {
        const value = await client.forward('agent_list', {})
        sample = { sampleCall: { tool: 'agent_list', total: (value as { total?: number })?.total } }
      } catch (error) {
        sample = { sampleCall: { tool: 'agent_list', error: error instanceof Error ? error.message : String(error) } }
      }
      return { ...status, ...sample }
    },
  }))

  t.register(defineTool({
    name: 'connect_reset',
    description: '断开宿主连接：清除本机保存的机器凭证与令牌缓存，工具回到本地执行（宿主侧凭证不受影响，回收请在宿主控制台禁用）。',
    parameters: {
      reason: { type: 'string', description: '断开原因（记录到本机日志）' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const was = client.getConfig()
      client.reset()
      ctx.logger('connect').info(`已断开宿主连接${args.reason ? `：${String(args.reason)}` : ''}${was ? `（原 ${was.hubUrl}）` : ''}`)
      return { ok: true, configured: false, notice: '本机凭证已清除，工具回到本地执行模式' }
    },
  }))
}

/**
 * 包裹 ToolRuntime：把业务工具的 execute 在「已接入宿主」时替换为远程转发。
 * 返回是否成功包裹（失败时降级为纯本地执行并告警，不阻断启动）。
 *
 * 关键实现细节：
 * 1. cordis 经由 ctx 访问的服务是 traceable 代理——直接对代理赋值只写入 fiber
 *    shadow，真实实例不受影响；须以全局注册的 Symbol.for("cordis.original")
 *    解出真实服务实例。
 * 2. 包裹打在**原型**上（register 注册入口 + execute 执行出口双保险），对
 *    ToolRuntimeLite 与 dsh 原生 ToolRuntime 一视同仁。
 * 3. cordis 的 ctx.effect(fn) 语义是「fn 返回清理函数」——disposer 必须写成
 *    双层箭头，否则清理逻辑会在注册时立即执行（把包裹当场还原）。
 * 4. 第 1 层包装的 execute 带 Symbol 标记：第 2 层出口据此识别「已由入口层
 *    包裹的工具」，避免同一次调用被双重转发。
 */
const PROXIED_EXECUTE_MARK = Symbol.for('dsh-ops.connect.proxied-execute')

function wrapToolRegistration(ctx: Context, client: ConnectClientService): boolean {
  const originalSymbol = Symbol.for('cordis.original')
  const service = ctx.tools as unknown as Record<PropertyKey, unknown> | undefined
  const target = (service && typeof service[originalSymbol] === 'object'
    ? service[originalSymbol]
    : service) as {
      register?: (definition: unknown) => unknown
      execute?: (input: { name: string; arguments?: unknown }) => Promise<unknown>
      definitions?: Map<string, { execute?: unknown }>
    } | undefined
  const proto = (target ? Object.getPrototypeOf(target) : null) as Record<string, unknown> | null
  if (!proto || typeof proto['register'] !== 'function') {
    ctx.logger('connect').warn('未能定位 ToolRuntime.register（接口不兼容），工具远程代理不可用，保持本地执行')
    return false
  }

  // -- 第 1 层：注册入口包裹（新注册的业务工具换成转发执行体） ----------------
  const originalRegister = proto['register'] as (this: unknown, definition: unknown) => unknown
  const wrappedRegister = function (this: unknown, definition: unknown): unknown {
    const spec = definition as { name?: unknown; execute?: (args: any, exec: any) => Promise<unknown> } | undefined
    const toolName = spec?.name
    if (typeof toolName === 'string' && isProxiedTool(toolName)) {
      const localExecute = spec.execute
      const proxiedExecute = async (args: any, exec: any): Promise<unknown> => {
        if (client.hasHub()) return client.forward(toolName, args ?? {}, exec)
        return localExecute?.(args, exec)
      }
      ;(proxiedExecute as unknown as Record<symbol, unknown>)[PROXIED_EXECUTE_MARK] = true
      return originalRegister.call(this, { ...spec, execute: proxiedExecute })
    }
    return originalRegister.call(this, definition)
  }
  try {
    proto['register'] = wrappedRegister
  } catch (error) {
    ctx.logger('connect').warn('包裹 ToolRuntime.register 失败', error)
    return false
  }
  ctx.effect(() => () => {
    if (proto['register'] === wrappedRegister) proto['register'] = originalRegister
  })

  // -- 第 2 层：执行出口兜底（注册早于本插件加载/入口被绕过时仍能转发） -------
  const originalExecute = proto['execute'] as ((this: unknown, input: { name: string; arguments?: unknown }) => Promise<unknown>) | undefined
  if (typeof originalExecute === 'function') {
    const isAlreadyProxied = (self: unknown, name: string): boolean => {
      const definitions = (self as typeof target | undefined)?.definitions
      const execute = definitions?.get?.(name)?.execute as Record<symbol, unknown> | undefined
      return execute?.[PROXIED_EXECUTE_MARK] === true
    }
    const wrappedExecute = async function (this: unknown, input: { name: string; arguments?: unknown }): Promise<unknown> {
      const started = Date.now()
      if (client.hasHub() && isProxiedTool(input?.name ?? '') && !isAlreadyProxied(this, input.name)) {
        // 兜底路径：该工具未经入口层包裹（注册早于本插件），就地转发并按
        // ToolRuntime 执行契约组装结果对象
        const callId = `connect-${started}-${input.name}`
        try {
          const value = await client.forward(input.name, (input.arguments ?? {}) as Record<string, unknown>)
          return { isError: false, value, content: [{ type: 'text', text: JSON.stringify(value) }], callId, name: input.name, durationMs: Date.now() - started }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { isError: true, content: [{ type: 'text', text: `工具执行失败：${message}` }], error: { message }, callId, name: input.name, durationMs: Date.now() - started }
        }
      }
      return await originalExecute.call(this, input)
    }
    try {
      proto['execute'] = wrappedExecute
      ctx.effect(() => () => {
        if (proto['execute'] === wrappedExecute) proto['execute'] = originalExecute
      })
    } catch { /* execute 出口包裹失败：仅依赖注册入口层 */ }
  }

  if (process.env['CONNECT_DEBUG']) {
    console.error(`[connect-diag] wrapped ToolRuntime prototype:`, target?.constructor?.name)
  }
  return true
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    connectClient: ConnectClientService
    connectConfigServer: ConnectConfigServer
  }
}
