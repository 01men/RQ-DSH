/**
 * app 插件对模型暴露的工具。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../platform-core/src/index.ts'

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
    name: 'app_metrics_report',
    description: '上报应用层产品指标（PV/UV/DAU/会话数/会话深度/7 日留存，可指定 date 补录历史）。外部 AI 应用接入后据此向宿主推送运行指标，宿主侧做全生命周期监测。',
    permission: 'app.write',
    parameters: {
      appId: { type: 'string', required: true, description: '应用 ID' },
      pv: { type: 'integer', description: '页面浏览量 PV（同日多次上报累加）' },
      uv: { type: 'integer', description: '日独立访客 UV（同日多次上报取最大值）' },
      dau: { type: 'integer', description: '日活跃用户数（同日多次上报取最大值）' },
      sessions: { type: 'integer', description: '会话数（同日多次上报累加）' },
      avgDepth: { type: 'number', description: '平均会话深度' },
      retention7: { type: 'number', description: '7 日留存（0-1 小数）' },
      date: { type: 'string', description: '指标日期 YYYY-MM-DD（默认今天；补录历史时指定）' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      const appId = String(args.appId)
      ctx.appRegistry.recordUsage(appId, {
        ...(args.pv !== undefined ? { pv: Number(args.pv) } : {}),
        ...(args.uv !== undefined ? { uv: Number(args.uv) } : {}),
        ...(args.dau !== undefined ? { dau: Number(args.dau) } : {}),
        ...(args.sessions !== undefined ? { sessions: Number(args.sessions) } : {}),
        ...(args.avgDepth !== undefined ? { avgDepth: Number(args.avgDepth) } : {}),
        ...(args.retention7 !== undefined ? { retention7: Number(args.retention7) } : {}),
        ...(args.date !== undefined && args.date !== '' ? { date: String(args.date) } : {}),
      })
      return { reported: true, metrics: ctx.appRegistry.metrics(appId) }
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
