/**
 * usage 插件对模型暴露的工具。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@dsh-ops/platform-core'

export const name = 'usage-tools'
export const inject = ['tools', 'usage']

export function apply(ctx: Context) {
  const t = ctx.tools

  t.register(defineTool({
    name: 'usage_query',
    description: '查询资源消耗计量事件（按主体/资源/时间窗过滤，返回事件数与应收金额）。',
    parameters: {
      principal: { type: 'string', description: '计费责任主体过滤（org:<id> / plugin:<id>）' },
      resource: { type: 'string', description: '资源过滤（model:<slug> / mcp:<slug> / plugin:<id>）' },
      from: { type: 'string', description: '起始时间（ISO）' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      return ctx.usage.totals({
        ...(args.principal ? { principal: args.principal } : {}),
        ...(args.resource ? { resource: args.resource } : {}),
        ...(args.from ? { from: args.from } : {}),
      })
    },
  }))

  t.register(defineTool({
    name: 'usage_reconcile',
    description: '触发计量对账：usage 事件流水 vs 消费方投影，偏差即告警。',
    parameters: {},
    output: { type: 'object', additionalProperties: true },
    async execute() {
      return ctx.usage.reconcile()
    },
  }))
}
