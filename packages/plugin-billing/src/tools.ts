/**
 * billing 插件对模型暴露的工具。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../platform-core/src/index.ts'

export const name = 'billing-tools'
export const inject = ['tools', 'billing']

export function apply(ctx: Context) {
  const t = ctx.tools

  t.register(defineTool({
    name: 'billing_wallet_balance',
    description: '查询组织钱包余额与当月已消费（分）。',
    parameters: {
      orgId: { type: 'string', required: true, description: '组织 ID' },
    },
    output: { type: 'object', additionalProperties: true },
    async execute(args) {
      return {
        orgId: args.orgId,
        balanceCents: ctx.billing.balance('org', args.orgId),
        monthSpentCents: ctx.billing.monthSpent(args.orgId),
      }
    },
  }))
}
