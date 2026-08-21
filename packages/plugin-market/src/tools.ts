/**
 * market 插件对模型暴露的工具。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@dsh-ops/platform-core'

export const name = 'market-tools'
export const inject = ['tools', 'market']

export function apply(ctx: Context) {
  const t = ctx.tools

  t.register(defineTool({
    name: 'market_plugin_list',
    description: '列出第三方插件市场已上架的 L0 声明式插件（含能力请求与计费声明）。',
    parameters: {},
    output: { type: 'object', additionalProperties: true },
    async execute() {
      const listed = ctx.market.listed()
      return {
        total: listed.length,
        plugins: listed.map((item) => ({
          pluginId: item.pluginId, version: item.version, developer: item.developerName,
          capabilities: item.parsed.capabilities_request, installs: item.installs,
          billing: item.parsed.billing,
        })),
      }
    },
  }))
}
