/**
 * app 插件对模型暴露的工具。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@dsh-ops/platform-core'

export const name = 'app-tools'
export const inject = ['tools', 'appRegistry', 'resourceCore']

export function apply(ctx: Context) {
  const t = ctx.tools

  t.register(defineTool({
    name: 'app_list',
    description: '列出 AI 应用本体（类型/状态过滤）。',
    parameters: {
      status: { type: 'string', enum: ['draft', 'trial', 'online', 'offline', 'archived'], description: '状态' },
      q: { type: 'string', description: '关键字' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const apps = ctx.resourceCore.list('app', args)
      return {
        total: apps.length,
        apps: apps.map((app) => ({
          id: app.id, name: app.name, status: app.status, appType: app.attrs['appType'],
          url: app.attrs['url'], owner: app.attrs['ownerName'],
        })),
      }
    },
  }))

  t.register(defineTool({
    name: 'app_topology',
    description: '查看应用依赖拓扑：应用 → Agent → MCP/Skill 一图穿透（异常节点标注）。',
    parameters: {
      appId: { type: 'string', required: true, description: '应用 ID' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      return { topology: ctx.appRegistry.topology(args.appId) }
    },
  }))

  t.register(defineTool({
    name: 'app_metrics',
    description: '应用层指标：DAU/MAU、会话数、会话深度、留存与近 14 天序列。',
    parameters: {
      appId: { type: 'string', required: true, description: '应用 ID' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      return ctx.appRegistry.metrics(args.appId)
    },
  }))

  t.register(defineTool({
    name: 'app_cost_breakdown',
    description: '成本穿透：应用 → Agent → MCP/模型 的 Token/调用/成本归集。',
    parameters: {
      appId: { type: 'string', required: true, description: '应用 ID' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      return { rows: ctx.appRegistry.costBreakdown(args.appId) }
    },
  }))
}
