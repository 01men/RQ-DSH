/**
 * modelgw 插件对模型暴露的工具。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '../../platform-core/src/index.ts'

export const name = 'modelgw-tools'
export const inject = ['tools', 'modelGateway']

export function apply(ctx: Context) {
  const t = ctx.tools

  t.register(defineTool({
    name: 'model_list',
    description: '列出模型网关目录（转售模型、计价与状态）。',
    parameters: {},
    output: { type: 'object', additionalProperties: true },
    async execute() {
      const models = ctx.modelGateway.models().all()
      return {
        total: models.length,
        models: models.map((item) => ({
          slug: item.slug, provider: item.provider, status: item.status,
          listCentsPerKTokens: item.listCentsPerKTokens, configured: item.endpoint !== '',
        })),
      }
    },
  }))
}
