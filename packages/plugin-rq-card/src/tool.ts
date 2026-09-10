/**
 * 本包内联的工具定义辅助（plan-gate01 Phase 2.5 执行记录，2026-09-10）。
 *
 * 【为什么内联】rq-card 是独立 npm 包（client-modules 以包名 require.resolve 解析，
 * spike §4.2），安装位置 node_modules/@ybkk/plugin-rq-card/ 下不存在 packages/* 兄弟
 * 目录——对 platform-core 的相对值导入（defineTool）在安装形态必然 ERR_MODULE_NOT_FOUND
 * （真机 gate01-smoke profile 实装实证）。defineTool 是叶子级纯函数（扁平参数说明 →
 * JSON Schema），从 platform-core/src/tools-lite.ts 复制内联，副本漂移登记
 * docs/handoff-f-remainder-to-main.md（上游 merge 后 diff 核对）。
 *
 * 【与宿主契约的关系】返回形状与 platform-core ToolDefinitionLite / dsh 原生
 * ToolRuntime 的注册契约一致，可原样注册到 ctx.tools（两种宿主同构）。
 */

/** 工具结果内容块（模型可见渲染的最小面）。 */
export interface ToolContentBlock {
  type: 'text'
  text: string
}

/** 扁平参数说明（PlatformToolSpec.parameters 的值类型）。 */
export interface ToolParamSpec {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'
  required?: boolean
  description?: string
  enum?: Array<string | number>
  items?: Record<string, unknown>
}

/** 工具运行上下文（本插件未消费，形状保持与 platform-core 对齐）。 */
export interface ToolRunContext {
  callId: string
  name: string
  signal: AbortSignal
  agent?: unknown
  token?: symbol
  principal?: { kind: string; id: string; name?: string; [key: string]: unknown }
}

/** 注册形态的工具定义（与 platform-core ToolDefinitionLite 同构）。 */
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => ToolContentBlock[]
  }
  execute: (args: any, exec: ToolRunContext) => Promise<unknown>
  timeoutMs?: number
  plugin?: string
  permission?: string
}

/** 工具规约（编写面）。 */
export interface ToolSpec {
  name: string
  description: string
  /** 插件名（登记来源用）。 */
  plugin?: string
  parameters: Record<string, ToolParamSpec>
  /** 输出 JSON Schema 根节点。 */
  output: Record<string, unknown>
  /** 自定义模型可见渲染（默认 JSON pretty print）。 */
  render?: (args: unknown, value: unknown) => ToolContentBlock[]
  timeoutMs?: number
  /** 调用所需的最小权限点（RBAC）。缺省视为无需额外权限（仅登录）。 */
  permission?: string
  execute: (args: any, exec: ToolRunContext) => Promise<unknown>
}

/** 扁平参数说明 → JSON Schema（复制自 platform-core/src/tools-lite.ts defineTool）。 */
export function defineTool(spec: ToolSpec): ToolDefinition {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, param] of Object.entries(spec.parameters)) {
    const node: Record<string, unknown> = { type: param.type }
    if (param.description) node.description = param.description
    if (param.enum) node.enum = param.enum
    if (param.items) node.items = param.items
    properties[key] = node
    if (param.required) required.push(key)
  }
  const parameters: Record<string, unknown> = {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
  return {
    name: spec.name,
    description: spec.description,
    plugin: spec.plugin,
    ...(spec.permission !== undefined ? { permission: spec.permission } : {}),
    parameters,
    output: {
      schema: spec.output,
      render: spec.render ?? ((_args: unknown, value: unknown) => [
        { type: 'text', text: JSON.stringify(value, null, 2) },
      ]),
    },
    ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
    execute: spec.execute,
  }
}
